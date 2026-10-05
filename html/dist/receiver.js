import { renderIcons } from '/icons.js';
import { AudioLink } from '/connection.js';
renderIcons();
const $ = (id) => document.getElementById(id);
const link = new AudioLink();
const audio = $('remote-audio');
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
const virtualMicKey = 'pocketlink.virtualMic';
let preferVirtualMic = false;
try {
  preferVirtualMic = localStorage.getItem(virtualMicKey) === 'true';
} catch {
  /* Storage may be unavailable. */
}
const isCableInput = (label) => /^CABLE Input\b/i.test(label || '');
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
    ? `系统麦克风${outputRestored ? '' : ' · 连接时恢复'}`
    : custom
      ? '自定义播放设备'
      : '电脑试听';
  $('mic-device-hint').textContent = microphoneName
    ? `在其他软件中，选择麦克风「${microphoneName}」。`
    : '将手机声音用于会议、游戏等软件。';
}
function status(message, error = false) {
  $('receiver-status').textContent = message;
  $('receiver-status').className =
    `message ${error ? 'error' : link.status === 'connected' ? 'success' : ''}`;
}
function settingsStatus(text) {
  $('settings-status').textContent = text;
}
function clearAudio() {
  cancelAnimationFrame(meterFrame);
  meterSource?.disconnect();
  meterSource = null;
  analyser = null;
  audio.pause();
  audio.srcObject = null;
  $('resume-audio').disabled = true;
  $('receiver-level-bar').style.width = '0';
  $('audio-status').textContent = '等待手机音频';
}
async function prepareMeter() {
  if (!meterContext || meterContext.state === 'closed') meterContext = new AudioContext();
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
    $('audio-status').textContent = '正在播放手机音频';
    $('resume-audio').textContent = '暂停播放';
  } catch {
    $('audio-status').textContent = '点击下方按钮开始播放';
    $('resume-audio').textContent = '播放音频';
  }
}
function showAddress() {
  const index = Number($('phone-network').value || 0);
  const phoneURL = config?.phoneURLs?.[index];
  if (!phoneURL || !pairCode || expiresAt <= Date.now()) {
    $('phone-entry').hidden = true;
    $('phone-qr').removeAttribute('src');
    return;
  }
  $('phone-entry').hidden = false;
  $('phone-url').href = phoneURL;
  $('phone-url').textContent = phoneURL;
  $('phone-qr').src =
    `${serviceBase}/api/qr.svg?index=${index}&code=${encodeURIComponent(pairCode)}`;
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
  const urls = (config.phoneURLs || []).filter((value) => {
    try {
      return ['https:', 'http:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });
  config.phoneURLs = urls;
  $('phone-network').replaceChildren(...urls.map((url, index) => new Option(url, String(index))));
  $('network-field').hidden = urls.length < 2;
  showAddress();
}
$('phone-network').addEventListener('change', showAddress);
$('create-code').addEventListener('click', async () => {
  const generation = ++serviceGeneration;
  try {
    await prepareMeter();
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
    await link.open({ role: 'receiver', server: $('receiver-server').value.trim() });
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
  $('pair-section').hidden = connected;
  $('audio-section').hidden = !connected;
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
  $('disconnect').textContent = connected ? '断开连接' : '取消配对';
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
  const labels = {
    idle: '会话已关闭',
    connecting: '正在连接…',
    waiting: '等待手机扫码或输入配对码…',
    negotiating: '正在建立音频连接…',
    connected: '已连接 · 正在接收手机音频',
    reconnecting: '音频连接中断，正在恢复…',
  };
  status(labels[state] || state);
});
link.addEventListener('error', (e) => status(e.detail.message, true));
link.addEventListener('notice', (e) => status(e.detail.message));
link.addEventListener('stream', async (e) => {
  try {
    audio.srcObject = e.detail.stream;
    $('resume-audio').disabled = false;
    startMeter(e.detail.stream);
    await playAudio();
    await refreshDevices();
  } catch {
    status('音频播放暂不可用，请点击播放重试。', true);
  }
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
  try {
    const selected = audio.sinkId || 'default';
    const devices = await navigator.mediaDevices.enumerateDevices();
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
$('use-virtual-mic').addEventListener('click', async () => {
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
      settingsStatus('已启用系统麦克风，下次连接自动恢复。');
    }
  } catch {
    settingsStatus(
      '无法读取设备，请允许浏览器麦克风权限后重试，或在 Windows 音量混合器中设置输出。',
    );
  } finally {
    button.disabled = false;
    $('use-speakers').disabled = false;
  }
});
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
for (const name of ['settings', 'setup']) {
  $(`open-${name}`).addEventListener('click', () => $(`${name}-dialog`).showModal());
  $(`close-${name}`).addEventListener('click', () => $(`${name}-dialog`).close());
}
if (!audio.setSinkId) {
  $('output-device').disabled = true;
  $('choose-output').textContent = '在系统中选择输出';
}
renderOutput();
refreshDevices();
navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
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
  void meterContext?.close();
});
