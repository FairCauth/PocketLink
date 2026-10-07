import { icon, renderIcons } from './icons.js';
import { AudioEngine, friendlyError } from './audio-engine.js';
import { AudioLink, serviceURL } from './connection.js';
import { PhoneController } from './phone-controller.js';
import { setupSoundboard } from './soundboard.js';
import { setupSoundSettings } from './sound-settings.js';

renderIcons();
const $ = (id) => document.getElementById(id);
const engine = new AudioEngine();
const controller = new PhoneController();
const soundboard = setupSoundboard(controller);
setupSoundSettings(engine);
const link = new AudioLink();
link.addEventListener('control', (e) => controller.attach(e.detail.channel));
controller.addEventListener('error', (e) => message('mic-message', e.detail.message, true));
link.addEventListener('sounds-changed', () => void soundboard.load());
const canvas = $('waveform');
const recordings = [];
let phase = 'pair';
let mode = 'lan';
let previousLinkState = 'idle';
let animation;
let closing;
let scanJoining = false;
const duration = (ms) => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

function message(id, text = '', error = false) {
  const element = $(id);
  element.textContent = text;
  element.classList.toggle('error', error);
  if (id !== 'pair-status') element.hidden = !text;
}

function updateView() {
  const connected = phase === 'control';
  const busy = phase === 'joining' || phase === 'closing';
  $('pair-view').hidden = connected;
  $('mic-view').hidden = !connected;
  $('pair-code').disabled = busy;
  const scanning = scanJoining && phase === 'joining';
  $('pair-code').hidden = scanning;
  $('connect-button').hidden = scanning;
  $('pair-title').textContent = scanning ? '正在连接电脑' : '连接电脑';
  $('pair-hint').textContent = scanning ? '已识别配对码，无需输入' : '输入电脑上显示的配对码';
  $('connect-button').disabled = busy || $('pair-code').value.replace(/\D/g, '').length !== 8;
  $('connect-button').textContent = phase === 'closing' ? '正在结束…' : busy ? '正在连接…' : '连接';
  $('pair-form').setAttribute('aria-busy', String(busy));
  // The browser owns the permission prompt; allow cancellation once networking starts.
  $('cancel-connect').hidden = phase !== 'joining' || link.status === 'idle';
  $('connection-settings').disabled = phase !== 'pair';
}

function drawWave() {
  cancelAnimationFrame(animation);
  if (phase !== 'control' || !engine.analyser) return;
  const width = canvas.clientWidth,
    height = canvas.clientHeight,
    dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const context = canvas.getContext('2d');
  const samples = new Float32Array(engine.analyser.fftSize);
  engine.analyser.getFloatTimeDomainData(samples);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = engine.muted ? '#62705d' : '#c7f48b';
  context.lineWidth = 1.7;
  context.beginPath();
  for (let x = 0; x < width; x++) {
    const value = samples[Math.floor((x / width) * samples.length)];
    const y = height / 2 + Math.max(-1, Math.min(1, value * 2.5)) * height * 0.43;
    if (x) context.lineTo(x, y);
    else context.moveTo(x, y);
  }
  context.stroke();
  animation = requestAnimationFrame(drawWave);
}

function updateMic() {
  const on = engine.state === 'on';
  const capturing = on && !!engine.track;
  $('phone-microphone').checked = !!engine.track || engine.microphoneStarting;
  $('phone-microphone').disabled = !on || engine.microphoneStarting;
  $('microphone-controls').hidden = !capturing;
  $('mic-title').textContent = capturing ? '手机麦克风' : '音效面板';
  $('mute-mic').disabled = !capturing;
  $('mute-mic').innerHTML = icon(engine.muted ? 'mute' : 'mic');
  $('mute-mic').setAttribute('aria-pressed', String(engine.muted));
  $('mute-mic').setAttribute('aria-label', engine.muted ? '取消静音' : '静音麦克风');
  $('mic-caption').textContent = engine.muted ? '已静音 · 轻触恢复' : '轻触静音';
  $('record-button').disabled = !on || engine.finishing || (!capturing && !engine.recording);
  updateVoice();
  updateInputHint();
  if (!on && phase === 'control') {
    message('pair-status', '麦克风已关闭，请重新连接。', true);
    void endSession();
  }
}

// Pairing failure, cancellation and remote disconnect all release capture.
function endSession() {
  if (closing) return closing;
  phase = 'closing';
  cancelAnimationFrame(animation);
  controller.detach();
  link.close();
  updateView();
  closing = engine.stop().finally(() => {
    closing = null;
    scanJoining = false;
    phase = 'pair';
    $('session-time').textContent = '00:00';
    $('resume-mic').hidden = true;
    message('mic-message');
    updateView();
  });
  return closing;
}

$('pair-code').addEventListener('input', () => {
  $('pair-code').value = $('pair-code')
    .value.replace(/\D/g, '')
    .slice(0, 8)
    .replace(/^(\d{4})(\d)/, '$1 $2');
  $('pair-code').removeAttribute('aria-invalid');
  message('pair-status');
  updateView();
});

async function connectPhone({ automatic = false } = {}) {
  if (phase !== 'pair') return;
  const code = $('pair-code').value.replace(/\D/g, '');
  if (!/^\d{8}$/.test(code)) {
    $('pair-code').setAttribute('aria-invalid', 'true');
    message('pair-status', '请输入 8 位配对码。', true);
    $('pair-code').focus();
    return;
  }
  phase = 'joining';
  scanJoining = automatic;
  updateView();
  message('pair-status', '正在连接电脑…');
  try {
    let server;
    if (mode === 'usb')
      throw new Error(
        'USB 直连请使用新版 iOS App，在电脑工作台选择「连接手机 → USB 有线」。手机网页不支持此模式。',
      );
    if (mode === 'server') {
      if (!$('server-url').value.trim()) throw new Error('请在设置中填写服务器地址。');
      server = serviceURL($('server-url').value.trim());
    }
    await engine.start({ automatic, microphone: false });
    if (phase !== 'joining') return;
    await link.open({ role: 'sender', code, server, mode, stream: engine.stream, control: true });
  } catch (error) {
    message('pair-status', friendlyError(error), true);
    await endSession();
  }
}
$('pair-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void connectPhone();
});

for (const id of ['cancel-connect', 'disconnect']) {
  $(id).addEventListener('click', async () => {
    message('pair-status');
    await endSession();
    $('pair-code').focus();
  });
}

link.addEventListener('status', (event) => {
  const state = event.detail.status;
  const previous = previousLinkState;
  previousLinkState = state;
  if (state === 'idle') {
    // AudioLink.open() closes the old idle socket before it opens a new one.
    if (previous !== 'idle' && phase !== 'closing') {
      message('pair-status', '连接已结束，请重新连接。');
      void endSession();
    }
    return;
  }
  if (state === 'connected') {
    const firstConnection = phase !== 'control';
    phase = 'control';
    message('pair-status');
    $('connection-status').innerHTML = '<i></i>已连接';
    $('connection-status').classList.remove('reconnecting');
    updateView();
    drawWave();
    if (firstConnection) {
      $('mic-title').focus({ preventScroll: true });
      void soundboard.load();
    }
  } else if (state === 'reconnecting') {
    $('connection-status').innerHTML = '<i></i>正在重连';
    $('connection-status').classList.add('reconnecting');
  } else {
    message('pair-status', state === 'negotiating' ? '正在建立音频连接…' : '正在连接电脑…');
    updateView();
  }
});
link.addEventListener('error', (event) => {
  message('pair-status', event.detail.message, true);
  $('pair-code').setAttribute('aria-invalid', 'true');
});

engine.addEventListener('state', updateMic);
engine.addEventListener('microphone', updateMic);
$('phone-microphone').addEventListener('change', async () => {
  message('mic-message');
  try {
    if ($('phone-microphone').checked) await engine.enableMicrophone();
    else engine.disableMicrophone();
  } catch (error) {
    message('mic-message', friendlyError(error), true);
  }
  updateMic();
});
engine.addEventListener('warning', (event) => {
  const target = $('settings-dialog').open
    ? 'settings-message'
    : phase === 'control'
      ? 'mic-message'
      : 'pair-status';
  message(target, event.detail.message, true);
  $('resume-mic').hidden = !(engine.state === 'on' && engine.context?.state !== 'running');
});
$('mute-mic').addEventListener('click', () => engine.setMuted(!engine.muted));
$('resume-mic').addEventListener('click', async () => {
  try {
    await engine.resume();
    $('resume-mic').hidden = engine.context?.state === 'running';
    if ($('resume-mic').hidden) message('mic-message');
  } catch (error) {
    message('mic-message', friendlyError(error), true);
  }
});
$('gain').addEventListener('input', () => {
  const value = Number($('gain').value);
  engine.setGain(value / 100);
  $('gain-value').textContent = `${value}%`;
});

function updateVoice() {
  if (controller.presets.length) {
    $('voice-effect').replaceChildren(...controller.presets.map((p) => new Option(p.name, p.id)));
    $('voice-effect').value = controller.voice;
  }
  $('voice-effect').disabled = controller.state !== 'on' || controller.voicePending;
  $('voice-status').textContent = controller.voicePending
    ? '正在切换电脑变声'
    : `当前为${$('voice-effect').selectedOptions[0]?.textContent || '原声'}`;
}
controller.addEventListener('voice', updateVoice);
controller.addEventListener('state', updateVoice);
$('voice-effect').addEventListener('change', () => {
  try {
    controller.setVoice($('voice-effect').value);
  } catch (error) {
    updateVoice();
    message('mic-message', error.message, true);
  }
});
function updateInputHint() {
  const input = controller.input;
  $('phone-input-hint').hidden = !engine.track;
  $('phone-input-hint').textContent =
    input?.phone && input.enabled
      ? '电脑正在使用手机输入'
      : '手机采集中；请在电脑选择「手机」并开启输入';
}
controller.addEventListener('input', updateInputHint);

$('open-settings').addEventListener('click', () => $('settings-dialog').showModal());
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
const hints = {
  lan: '手机和电脑连接同一网络。',
  server: '使用已配置音频中继的 PocketLink 服务。',
  usb: 'USB 直连请使用新版 iOS App；无需热点或局域网，手机网页不支持此模式。',
};
document.querySelectorAll('[name="mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    mode = input.value;
    $('server-field').hidden = mode !== 'server';
    $('mode-hint').textContent = hints[mode];
  });
});
$('record-button').addEventListener('click', () => {
  try {
    if (engine.recording) engine.stopRecording();
    else engine.startRecording();
  } catch (error) {
    message('mic-message', friendlyError(error), true);
  }
});
engine.addEventListener('recording', () => {
  $('record-button').classList.toggle('recording', engine.recording);
  $('record-label').textContent = engine.finishing
    ? '保存中…'
    : engine.recording
      ? '停止录音'
      : '手机录音';
  $('record-button').disabled =
    engine.state !== 'on' || engine.finishing || (!engine.track && !engine.recording);
  $('record-time').hidden = !engine.recording;
  $('record-time').textContent = '00:00';
});
engine.addEventListener('recorded', (event) => {
  const data = event.detail;
  const extension = data.mime.includes('mp4') ? 'm4a' : data.mime.includes('ogg') ? 'ogg' : 'webm';
  const stamp = new Date(data.startedAt).toISOString().replace(/[:.]/g, '-');
  const record = {
    ...data,
    url: URL.createObjectURL(data.blob),
    name: `PocketLink-${stamp}.${extension}`,
  };
  recordings.unshift(record);
  const row = document.createElement('article');
  row.className = 'recording-item';
  const number = String(recordings.length).padStart(2, '0');
  row.innerHTML = `<div class="recording-meta"><strong>录音 ${number}</strong><time>${duration(record.duration)}</time><a href="${record.url}" download="${record.name}" aria-label="下载录音 ${number}">${icon('download')}</a></div><audio controls preload="metadata" src="${record.url}" aria-label="回听录音 ${number}"></audio>`;
  $('recording-list').prepend(row);
  $('recording-count').textContent = recordings.length;
  $('recordings').hidden = false;
  $('recordings').open = true;
});

setInterval(() => {
  if (engine.recording)
    $('record-time').textContent = duration(Date.now() - engine.recordStartedAt);
  if (link.connectedAt) $('session-time').textContent = duration(Date.now() - link.connectedAt);
}, 500);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && engine.state === 'on') {
    engine.acquireWakeLock();
    $('resume-mic').hidden = engine.context?.state === 'running';
  }
});
window.addEventListener('beforeunload', (event) => {
  if (engine.recording || recordings.length || phase !== 'pair') {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('pagehide', () => {
  phase = 'closing';
  controller.detach();
  link.close();
  cancelAnimationFrame(animation);
  void engine.stop();
  for (const record of recordings) URL.revokeObjectURL(record.url);
});
updateView();
// A QR carries a pairing code and optional mode; it always uses this page's service.
// Consume it once so refresh/back navigation does not restart capture.
function consumeScannedCode() {
  const scanParameters = new URLSearchParams(location.hash.slice(1));
  if (!scanParameters.has('pair')) return;
  const code = scanParameters.get('pair');
  const scannedMode = scanParameters.get('mode');
  const validMode = !scannedMode || ['lan', 'usb', 'server'].includes(scannedMode);
  scanParameters.delete('pair');
  scanParameters.delete('mode');
  history.replaceState(
    null,
    '',
    location.pathname + location.search + (scanParameters.size ? '#' + scanParameters : ''),
  );
  if (phase !== 'pair') return;
  if (/^\d{8}$/.test(code || '') && validMode) {
    if (scannedMode) {
      mode = scannedMode;
      document.querySelector(`[name="mode"][value="${mode}"]`).checked = true;
      $('server-field').hidden = mode !== 'server';
      $('mode-hint').textContent = hints[mode];
    }
    $('pair-code').value = code.slice(0, 4) + ' ' + code.slice(4);
    void connectPhone({ automatic: true });
  } else {
    message('pair-status', '二维码无效，请重新扫码或输入配对码。', true);
  }
}
window.addEventListener('hashchange', consumeScannedCode);
consumeScannedCode();
