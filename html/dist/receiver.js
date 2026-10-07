import { renderIcons } from '/icons.js';
import { ReceiverLink } from '/receiver-link.js';
import { ReceiverMixer } from '/receiver-mixer.js';
import { RemoteSoundboard } from '/remote-soundboard.js';
import { VOICE_PRESETS, VOICES } from '/voice-dsp.js';
renderIcons();
const $ = (id) => document.getElementById(id);
const link = new ReceiverLink();
const audio = $('remote-audio');
let connectionMode = new URLSearchParams(location.search).get('mode') === 'usb' ? 'usb' : 'lan';
audio.volume = 0.7;
let pairCode = '',
  expiresAt = 0,
  config,
  serviceBase = location.origin;
let meterContext,
  analyser,
  meterSource,
  meterFrame,
  serviceGeneration = 0;
let mixer,
  mixGeneration = 0;
let voiceChoice = 'original';
let devicesGeneration = 0;
let phoneStream = null,
  inputEnabled = false,
  inputPending = false,
  studioPromise,
  disposed = false;
let availableInputs = [];
const inputDevices = (devices) =>
  devices.filter(
    (device) =>
      device.kind === 'audioinput' &&
      device.deviceId &&
      device.label &&
      !['default', 'communications'].includes(device.deviceId) &&
      !/CABLE (Input|Output)|VB-Audio Virtual Cable|PocketLink 麦克风/i.test(device.label),
  );
function renderVoices() {
  $('receiver-voice').value = voiceChoice;
  $('receiver-voice').disabled = false;
}
async function setReceiverVoice(id) {
  if (!VOICES.includes(id)) throw new Error('未知变声预设');
  const target = await ensureStudio();
  await target.setVoice(id);
}
const remoteSounds = new RemoteSoundboard(
  () => mixer,
  (message) => {
    $('sound-status').textContent = message;
  },
  {
    state: () => ({
      selected: voiceChoice,
      presets: VOICE_PRESETS.map(({ id, name }) => ({ id, name })),
    }),
    set: setReceiverVoice,
    input: () => ({ phone: $('input-device').value === 'phone', enabled: inputEnabled }),
  },
  ensureStudio,
);
$('receiver-voice').replaceChildren(...VOICE_PRESETS.map(({ id, name }) => new Option(name, id)));
$('receiver-voice').addEventListener('change', () => {
  void setReceiverVoice($('receiver-voice').value).catch((error) => {
    $('input-status').textContent = error.message;
    renderVoices();
  });
});
link.addEventListener('control', ({ detail }) => remoteSounds.attach(detail.channel, serviceBase));
link.addEventListener('sounds-changed', () => void remoteSounds.refresh?.());
$('sound-files').addEventListener('change', async () => {
  const picker = $('sound-files');
  const files = [...picker.files];
  if (!files.length) return;
  picker.disabled = true;
  let done = 0;
  try {
    const response = await fetch(`${serviceBase}/api/config`);
    const { soundUploadToken } = await response.json();
    if (!soundUploadToken) throw new Error('请在运行 PocketLink 服务的电脑上添加音效。');
    for (const file of files) {
      if (!/\.(mp3|wav|m4a)$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024)
        throw new Error(`${file.name}：请选择不超过 10 MB 的 MP3、WAV 或 M4A。`);
      $('sound-upload-status').textContent = `正在添加 ${file.name}…`;
      const result = await fetch(
        `${serviceBase}/api/sounds?name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          headers: { 'X-PocketLink-Upload': soundUploadToken },
          body: file,
          signal: AbortSignal.timeout(30000),
        },
      );
      const value = await result.json();
      if (!result.ok) throw new Error(value.error || '音效添加失败。');
      ++done;
    }
    $('sound-upload-status').textContent = `已添加 ${done} 个音效，手机列表已更新。`;
    void remoteSounds.refresh?.();
  } catch (error) {
    $('sound-upload-status').textContent = `已添加 ${done} 个。${error.message}`;
  } finally {
    picker.disabled = false;
    picker.value = '';
  }
});
const virtualMicKey = 'pocketlink.virtualMic';
let preferVirtualMic = false;
try {
  preferVirtualMic = localStorage.getItem(virtualMicKey) === 'true';
} catch {
  /* Storage may be unavailable. */
}
const isCableInput = (label) =>
  /^CABLE Input\b/i.test(label || '') ||
  (/\(VB-Audio Virtual Cable\)$/i.test(label || '') && !/16\s*Ch/i.test(label));
const findCable = (devices) =>
  devices.find(
    (device) =>
      device.kind === 'audiooutput' &&
      !['default', 'communications'].includes(device.deviceId) &&
      isCableInput(device.label),
  );
let microphoneName = '',
  outputRestored = false;
function renderOutput() {
  const custom = !preferVirtualMic && audio.sinkId;
  $('use-virtual-mic').setAttribute('aria-pressed', String(preferVirtualMic));
  $('use-speakers').setAttribute('aria-pressed', String(!preferVirtualMic && !custom));
  $('output-route').textContent = preferVirtualMic
    ? `系统麦克风${outputRestored ? '' : ' · 启用时恢复'}`
    : custom
      ? '自定义播放设备'
      : '电脑试听';
  $('mic-device-hint').textContent = microphoneName
    ? `在其他软件中，选择麦克风「${microphoneName}」。`
    : '将处理后的声音用于会议、游戏等软件。';
}
function status(message, error = false) {
  $('receiver-status').textContent = message;
  $('receiver-status').className =
    `message ${error ? 'error' : link.status === 'connected' ? 'success' : ''}`;
}
function settingsStatus(text) {
  $('settings-status').textContent = text;
}
function renderAudioState() {
  remoteSounds.sendInputState();
  const connected = ['connected', 'reconnecting'].includes(link.status);
  $('pair-section').hidden = connected;
  $('open-phone').textContent = connected ? '手机已连接' : '连接手机';
  $('input-toggle').textContent = inputPending
    ? '取消开启'
    : inputEnabled
      ? '关闭麦克风'
      : '开启麦克风';
  $('input-toggle').setAttribute('aria-pressed', String(inputEnabled || inputPending));
  $('input-toggle').disabled = $('input-device').value === 'none';
}
function clearAudio({ force = false } = {}) {
  phoneStream = null;
  remoteSounds.detach();
  if ($('input-device').value === 'phone') {
    stopInput();
    $('input-device').value = 'none';
    $('input-status').textContent = '手机已断开，请选择其他输入。音效仍可使用。';
  }
  renderInputs();
  if (force) {
    disposed = true;
    stopInput();
    remoteSounds.stop();
    mixer?.close();
    mixer = null;
    cancelAnimationFrame(meterFrame);
    meterSource?.disconnect();
    meterSource = analyser = null;
    audio.pause();
    audio.srcObject = null;
  }
  renderAudioState();
}
async function ensureStudio() {
  if (disposed) throw new Error('页面已关闭');
  if (studioPromise) return studioPromise;
  if (mixer) {
    await prepareMeter();
    return mixer;
  }
  studioPromise = (async () => {
    await prepareMeter();
    if (preferVirtualMic && !outputRestored) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cable = findCable(devices);
      if (!cable) throw new Error('请先打开设置，点击「系统麦克风」恢复输出设备。');
      await refreshDevices();
      if (!(await setOutput(cable.deviceId)))
        throw new Error('虚拟麦克风输出恢复失败，请重新选择设备。');
    }
    if (disposed) throw new Error('页面已关闭');
    const target = (mixer = new ReceiverMixer(meterContext, null));
    target.setGain(Number($('input-gain').value) / 100);
    target.addEventListener('voice', () => {
      if (mixer !== target || target.closed) return;
      voiceChoice = target.voice;
      renderVoices();
      remoteSounds.sendVoiceState();
    });
    target.addEventListener('voice-error', () => {
      $('input-status').textContent = '变声处理已中断，已恢复原声。';
    });
    target.addEventListener('ended', () => {
      stopInput();
      $('input-status').textContent = '麦克风已断开，请重新选择输入。音效仍可使用。';
    });
    audio.srcObject = target.stream;
    startMeter(target.stream);
    $('resume-audio').disabled = false;
    await playAudio();
    return target;
  })();
  try {
    return await studioPromise;
  } finally {
    studioPromise = null;
  }
}
function renderSounds() {
  $('sound-list').replaceChildren(
    ...remoteSounds.sounds.map(({ id, name }) => {
      const button = document.createElement('button');
      button.className = 'sound-tile';
      button.textContent = name;
      button.setAttribute('aria-pressed', String(remoteSounds.playing === id));
      button.addEventListener('click', () => void remoteSounds.play(id));
      return button;
    }),
  );
  $('sound-empty').hidden = remoteSounds.sounds.length > 0;
  $('sound-status').textContent = remoteSounds.playing
    ? `正在播放：${remoteSounds.sounds.find((s) => s.id === remoteSounds.playing)?.name || '音效'}`
    : '';
}
remoteSounds.addEventListener('change', renderSounds);
$('stop-sound').addEventListener('click', () => remoteSounds.stop());
$('refresh-sounds').addEventListener('click', () => void remoteSounds.refresh(serviceBase));
async function prepareMeter() {
  if (!meterContext || meterContext.state === 'closed')
    // The mixer needs a clock even when Windows has no default speaker attached.
    meterContext = new AudioContext({ sinkId: { type: 'none' } });
  if (meterContext.state !== 'running') await meterContext.resume();
}
function startMeter(stream) {
  cancelAnimationFrame(meterFrame);
  meterSource?.disconnect();
  meterSource = meterContext.createMediaStreamSource(stream);
  analyser = meterContext.createAnalyser();
  analyser.fftSize = 1024;
  meterSource.connect(analyser);
  const values = new Float32Array(1024);
  function draw() {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(values);
    const rms = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
    const db = rms ? 20 * Math.log10(rms) : -100;
    $('receiver-level-bar').style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    meterFrame = requestAnimationFrame(draw);
  }
  draw();
}
async function playAudio() {
  await prepareMeter();
  try {
    await audio.play();
    $('audio-status').textContent = '音频输出已开启';
    $('resume-audio').textContent = '暂停播放';
  } catch {
    $('audio-status').textContent = '点击下方按钮开始播放';
    $('resume-audio').textContent = '播放音频';
  }
}
function showAddress() {
  const index = Number($('phone-network').value || 0);
  const phoneURL = config?.phoneURLs?.[index];
  $('connect-lan').setAttribute('aria-pressed', String(connectionMode === 'lan'));
  $('connect-usb').setAttribute('aria-pressed', String(connectionMode === 'usb'));
  $('usb-hint').hidden = connectionMode !== 'usb';
  $('usb-hint').textContent =
    '插线并信任电脑，在 iOS App 选择 USB 并输入配对码。无需热点或局域网。';
  if (link.status === 'idle')
    $('create-code').textContent = connectionMode === 'usb' ? '创建 USB 配对码' : '创建配对码';
  if (!phoneURL || !pairCode || expiresAt <= Date.now() || connectionMode === 'usb') {
    $('phone-entry').hidden = true;
    $('phone-qr').removeAttribute('src');
    return;
  }
  $('phone-entry').hidden = false;
  $('phone-url').href = phoneURL;
  $('phone-url').textContent = phoneURL;
  $('phone-qr').src =
    `${serviceBase}/api/qr.svg?index=${index}&code=${encodeURIComponent(pairCode)}${connectionMode === 'usb' ? '&mode=usb' : ''}`;
  const setupURL = config.setupURLs?.[index];
  $('open-setup').hidden = !setupURL;
  if (setupURL) {
    $('setup-url').href = setupURL;
    $('setup-url').textContent = setupURL;
    $('setup-qr').src = `${serviceBase}/api/qr.svg?kind=setup&index=${index}`;
    $('certificate-name').textContent = config.certificate?.name || '';
    $('certificate-fingerprint').textContent = `SHA-256: ${config.certificate?.fingerprint || ''}`;
  }
}
function showConfig(value) {
  config = value;
  const entries = (config.phoneURLs || [])
    .map((url, index) => ({ url, index }))
    .filter(({ url }) => {
      try {
        return ['https:', 'http:'].includes(new URL(url).protocol);
      } catch {
        return false;
      }
    });
  $('phone-network').replaceChildren(
    ...entries.map(
      ({ url, index }) =>
        new Option(
          `${config.phoneNetworks?.[index]?.kind === 'usb' ? '共享网络 · ' : ''}${url}`,
          String(index),
        ),
    ),
  );
  $('network-field').hidden = entries.length < 2;
  selectConnectionMode(connectionMode);
}
function selectConnectionMode(mode) {
  if (mode !== connectionMode && link.status !== 'idle') {
    ++serviceGeneration;
    link.close();
  }
  connectionMode = mode;
  const index = config?.phoneNetworks?.findIndex((item) =>
    mode === 'usb' ? item.kind === 'usb' : item.kind !== 'usb',
  );
  if (index >= 0) $('phone-network').value = String(index);
  showAddress();
}
$('connect-lan').addEventListener('click', () => selectConnectionMode('lan'));
$('connect-usb').addEventListener('click', () => selectConnectionMode('usb'));
showAddress();
$('phone-network').addEventListener('change', showAddress);
$('create-code').addEventListener('click', async () => {
  const generation = ++serviceGeneration;
  try {
    await ensureStudio();
    // Restore the routing before a phone can connect and begin playback.
    // Never silently send a remembered virtual microphone to the speakers.
    if (preferVirtualMic) {
      const devices = await navigator.mediaDevices?.enumerateDevices();
      const cable = findCable(devices || []);
      if (!cable) throw new Error('请先打开设置，点击「系统麦克风」恢复输出设备。');
      await refreshDevices();
      if (!(await setOutput(cable.deviceId)))
        throw new Error('虚拟麦克风输出恢复失败，请在设置中重新选择设备。');
    }
    if (generation !== serviceGeneration) return;
    await link.open({
      role: 'receiver',
      server: $('receiver-server').value.trim(),
      mode: connectionMode,
      context: meterContext,
    });
    if (generation !== serviceGeneration || link.status === 'idle') return;
    serviceBase = new URL($('receiver-server').value.trim() || location.origin).origin;
    showConfig(link.config);
  } catch (error) {
    status(error.message, true);
  }
});
link.addEventListener('code', (e) => {
  pairCode = e.detail.code;
  expiresAt = e.detail.expiresAt;
  $('receiver-code').textContent = pairCode.slice(0, 4) + ' ' + pairCode.slice(4);
  $('copy-code').disabled = false;
  showAddress();
});
link.addEventListener('status', (e) => {
  const state = e.detail.status;
  const connected = state === 'connected' || state === 'reconnecting';
  $('create-code').disabled = ['connecting', 'negotiating', 'connected'].includes(state);
  $('create-code').classList.toggle('waiting', state === 'waiting');
  $('create-code').textContent =
    state === 'connecting'
      ? '正在创建…'
      : state === 'negotiating'
        ? '正在连接…'
        : state === 'waiting'
          ? '刷新配对码'
          : '创建配对码';
  $('disconnect').hidden = state === 'idle';
  $('disconnect').textContent = connected ? '断开手机' : '取消配对';
  $('receiver-server').disabled = state !== 'idle';
  if (state === 'idle') {
    pairCode = '';
    expiresAt = 0;
    $('receiver-code').textContent = '—— ——';
    $('copy-code').disabled = true;
    showAddress();
    clearAudio();
  }
  if (state === 'waiting') clearAudio();
  if (state === 'connected') $('phone-dialog').close();
  renderAudioState();
  const labels = {
    idle: '会话已关闭',
    connecting: '正在连接…',
    waiting: '等待手机扫码或输入配对码…',
    negotiating: '正在建立音频连接…',
    connected: '手机已连接',
    reconnecting: '音频连接中断，正在恢复…',
  };
  status(
    state === 'waiting' && connectionMode === 'usb'
      ? '等待 iOS App 输入配对码并通过数据线连接…'
      : labels[state] || state,
  );
});
link.addEventListener('error', (e) => status(e.detail.message, true));
link.addEventListener('notice', (e) => status(e.detail.message));
link.addEventListener('stream', (e) => {
  phoneStream = e.detail.stream;
  if (inputEnabled && $('input-device').value === 'phone') mixer?.setRemote(phoneStream);
  renderInputs();
  renderAudioState();
});
$('disconnect').addEventListener('click', () => {
  ++serviceGeneration;
  link.close();
});
$('copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pairCode);
    status('配对码已复制');
  } catch {
    status('请手动复制上方配对码');
  }
});
$('resume-audio').addEventListener('click', async () => {
  if (!audio.paused) {
    audio.pause();
    $('audio-status').textContent = '播放已暂停';
    $('resume-audio').textContent = '继续播放';
  } else {
    try {
      await playAudio();
    } catch {
      status('无法恢复音频播放，请重新连接。', true);
    }
  }
});
$('output-volume').addEventListener('input', () => {
  audio.volume = Number($('output-volume').value) / 100;
  $('output-volume-value').textContent = $('output-volume').value + '%';
});
async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const generation = ++devicesGeneration;
  try {
    const selected = audio.sinkId || 'default';
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (generation !== devicesGeneration) return;
    availableInputs = inputDevices(devices);
    const activeId = $('input-device').value;
    if (
      activeId !== 'none' &&
      activeId !== 'phone' &&
      !availableInputs.some((device) => device.deviceId === activeId)
    ) {
      stopInput();
      $('input-device').value = 'none';
      $('input-status').textContent = '当前麦克风已拔出，请选择设备后重新开启。';
    }
    renderInputs();
    const microphone =
      devices.find(
        (device) =>
          device.kind === 'audioinput' &&
          !['default', 'communications'].includes(device.deviceId) &&
          /^PocketLink 麦克风(?:\s*\(|$)/i.test(device.label),
      ) ||
      devices.find(
        (device) =>
          device.kind === 'audioinput' &&
          !['default', 'communications'].includes(device.deviceId) &&
          /^CABLE Output\b/i.test(device.label),
      );
    microphoneName = microphone?.label.replace(/\s*\(VB-Audio Virtual Cable\)$/i, '') || '';
    const options = [new Option('系统默认输出', 'default')];
    for (const device of devices.filter(
      (d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default',
    ))
      options.push(new Option(device.label || `音频输出 ${options.length}`, device.deviceId));
    $('output-device').replaceChildren(...options);
    $('output-device').value = selected;
    if (!$('output-device').value) $('output-device').value = 'default';
    renderOutput();
  } catch {
    settingsStatus('输出设备列表暂不可用，请使用系统默认输出。');
  }
}
async function setOutput(id) {
  const previous = audio.sinkId || 'default';
  try {
    await audio.setSinkId(id === 'default' ? '' : id);
    const label =
      Array.from($('output-device').options).find((option) => option.value === id)?.textContent ||
      '所选音频设备';
    preferVirtualMic = id !== 'default' && isCableInput(label);
    try {
      if (preferVirtualMic) localStorage.setItem(virtualMicKey, 'true');
      else localStorage.removeItem(virtualMicKey);
    } catch {
      /* Keep working without storage. */
    }
    outputRestored = true;
    renderOutput();
    $('output-device').value = id;
    settingsStatus('');
    return true;
  } catch {
    $('output-device').value = previous;
    settingsStatus('无法切换输出，请在 Windows 声音设置中选择。');
    return false;
  }
}
async function useVirtualMicrophone() {
  const button = $('use-virtual-mic');
  if (!audio.setSinkId || !navigator.mediaDevices?.enumerateDevices) {
    settingsStatus(
      '请使用电脑版 Chrome / Edge，或在 Windows 音量混合器中将浏览器输出设为 CABLE Input。',
    );
    return;
  }
  button.disabled = true;
  $('use-speakers').disabled = true;
  settingsStatus('正在查找虚拟麦克风…');
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let cable = findCable(devices);
    // Chromium may hide non-default outputs until capture permission is granted.
    // This temporary stream is never played or sent to the phone.
    if (!cable && !devices.some((device) => device.kind === 'audioinput' && device.label)) {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      permissionStream.getTracks().forEach((track) => track.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      cable = findCable(devices);
    }
    await refreshDevices();
    if (!cable) {
      settingsStatus(
        '未找到虚拟麦克风。请在高级设置中查看 VB-CABLE 安装入口；已有设备请确认未被禁用。',
      );
      return;
    }
    if (await setOutput(cable.deviceId)) {
      $('output-device').value = cable.deviceId;
      settingsStatus('已启用系统麦克风，下次启用音频时自动恢复。');
      return true;
    }
  } catch {
    settingsStatus(
      '无法读取设备，请允许浏览器麦克风权限后重试，或在 Windows 音量混合器中设置输出。',
    );
  } finally {
    button.disabled = false;
    $('use-speakers').disabled = false;
  }
}
$('use-virtual-mic').addEventListener('click', useVirtualMicrophone);
$('use-speakers').addEventListener('click', async () => {
  $('use-speakers').disabled = true;
  $('use-virtual-mic').disabled = true;
  try {
    if (await setOutput('default')) settingsStatus('已切换到电脑试听。');
  } finally {
    $('use-speakers').disabled = false;
    $('use-virtual-mic').disabled = false;
  }
});
$('output-device').addEventListener('change', () => setOutput($('output-device').value));
$('choose-output').addEventListener('click', async () => {
  if (navigator.mediaDevices?.selectAudioOutput) {
    try {
      const device = await navigator.mediaDevices.selectAudioOutput();
      await refreshDevices();
      await setOutput(device.deviceId);
    } catch {
      settingsStatus('未选择音频输出设备。');
    }
  } else {
    await refreshDevices();
    settingsStatus('也可在 Windows 声音设置中指定浏览器的输出设备。');
  }
});
function renderInputs() {
  const previous = $('input-device').value || 'none';
  const options = [new Option('仅音效（无麦克风）', 'none')];
  for (const device of availableInputs) options.push(new Option(device.label, device.deviceId));
  if (phoneStream) options.push(new Option('手机', 'phone'));
  $('input-device').replaceChildren(...options);
  $('input-device').value = options.some((option) => option.value === previous) ? previous : 'none';
  renderAudioState();
}
function stopInput() {
  ++mixGeneration;
  inputEnabled = inputPending = false;
  mixer?.stopLocal();
  mixer?.setRemote(null);
  $('input-status').textContent = '';
  renderAudioState();
}
async function startInput() {
  stopInput();
  const id = $('input-device').value;
  if (id === 'none') return;
  const generation = mixGeneration;
  inputPending = true;
  renderAudioState();
  $('input-status').textContent = '正在开启麦克风…';
  try {
    const target = await ensureStudio();
    if (generation !== mixGeneration) return;
    if (id === 'phone') {
      if (!phoneStream) throw new Error('手机已断开，请重新选择输入。');
      target.setRemote(phoneStream);
    } else {
      if (!(await target.startLocal(id))) return;
      if (generation !== mixGeneration) return;
    }
    inputEnabled = true;
    $('input-status').textContent = id === 'phone' ? '请在手机上开启麦克风。' : '';
  } catch (error) {
    if (generation !== mixGeneration) return;
    stopInput();
    $('input-status').textContent =
      error.name === 'NotAllowedError' ? '请允许浏览器使用麦克风，音效仍可使用。' : error.message;
  } finally {
    if (generation === mixGeneration) inputPending = false;
    renderAudioState();
  }
}
$('input-toggle').addEventListener('click', () => {
  if (inputEnabled || inputPending) stopInput();
  else void startInput();
});
$('input-device').addEventListener('change', () => {
  const wasActive = inputEnabled || inputPending;
  stopInput();
  if (wasActive) void startInput();
  else $('input-status').textContent = $('input-device').value === 'none' ? '' : '';
});
$('refresh-inputs').addEventListener('click', async () => {
  const button = $('refresh-inputs');
  button.disabled = true;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some((d) => d.kind === 'audioinput' && d.label)) {
      const permission = await navigator.mediaDevices.getUserMedia({ audio: true });
      permission.getTracks().forEach((track) => track.stop());
    }
    await refreshDevices();
    $('input-status').textContent = availableInputs.length
      ? ''
      : '未找到电脑麦克风，可连接设备后刷新。';
  } catch {
    $('input-status').textContent = '无法读取麦克风，请允许浏览器权限后重试。';
  } finally {
    button.disabled = false;
  }
});
$('input-gain').addEventListener('input', () => {
  const value = Number($('input-gain').value);
  mixer?.setGain(value / 100);
  $('input-gain-value').textContent = value + '%';
});
for (const name of ['settings', 'setup', 'phone']) {
  $(`open-${name}`).addEventListener('click', () => {
    $(`${name}-dialog`).showModal();
    if (name === 'settings') void refreshDevices();
  });
  $(`close-${name}`).addEventListener('click', () => $(`${name}-dialog`).close());
}
if (!audio.setSinkId) {
  $('output-device').disabled = true;
  $('choose-output').textContent = '在系统中选择输出';
}
renderOutput();
renderVoices();
renderAudioState();
void remoteSounds.refresh();
refreshDevices();
navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
window.addEventListener('focus', refreshDevices);
setInterval(() => {
  if (link.status === 'waiting' && expiresAt) {
    const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    if (!seconds) showAddress();
    status(
      seconds
        ? `等待手机连接 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
        : '配对码已过期，请重新创建',
    );
  }
}, 1000);
window.addEventListener('pagehide', () => {
  link.close();
  clearAudio({ force: true });
  void meterContext?.close();
});
