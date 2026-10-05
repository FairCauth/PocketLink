import { VOICES } from './voice-dsp.js';

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.state = 'off';
    this.gainValue = 1;
    this.muted = false;
    this.voice = 'original';
    this.voiceGeneration = 0;
    this.options = { noiseSuppression: true, echoCancellation: true };
    this.recording = false;
    this.generation = 0;
  }
  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  async start({ automatic = false } = {}) {
    if (this.state !== 'off') return;
    if (!window.isSecureContext)
      throw new Error('iPhone 录音需要可信 HTTPS。请按连接指南配置证书后打开网页。');
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('当前浏览器无法访问麦克风，请使用最新版 Safari、Chrome 或 Edge。');
    const generation = ++this.generation;
    this.state = 'starting';
    this.emit('state');
    try {
      this.context = new (window.AudioContext || window.webkitAudioContext)();
      // A scanned link has no page gesture. Obtain permission before resuming audio.
      if (!automatic) await this.context.resume();
      const raw = await navigator.mediaDevices.getUserMedia({
        audio: { ...this.options, channelCount: 1, sampleRate: 48000, autoGainControl: false },
        video: false,
      });
      if (generation !== this.generation) {
        raw.getTracks().forEach((t) => t.stop());
        return;
      }
      this.raw = raw;
      this.track = raw.getAudioTracks()[0];
      if (automatic) {
        let timer;
        try {
          await Promise.race([
            this.context.resume(),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('已识别配对码，请点击「连接」启用麦克风。')),
                2000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (generation !== this.generation) return;
      }
      this.source = this.context.createMediaStreamSource(raw);
      this.gain = this.context.createGain();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;
      this.destination = this.context.createMediaStreamDestination();
      this.source.connect(this.gain);
      this.gain.connect(this.analyser);
      this.analyser.connect(this.destination);
      this.stream = this.destination.stream;
      this.stream.getAudioTracks()[0].contentHint = 'speech';
      if (this.voice !== 'original') await this.setVoice(this.voice);
      if (generation !== this.generation) return;
      this.setGain(this.gainValue);
      this.state = 'on';
      this.track.onended = () => {
        this.stop();
        this.emit('warning', { message: '麦克风已被系统关闭，请重新启用。' });
      };
      this.track.onmute = () =>
        this.emit('warning', { message: '音频输入被系统暂停，请保持页面在前台。' });
      this.context.onstatechange = () => {
        if (this.state === 'on' && this.context.state !== 'running')
          this.emit('warning', { message: '音频已暂停，回到页面并点击启用以恢复。' });
      };
      this.emit('state');
      this.acquireWakeLock();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async acquireWakeLock() {
    try {
      if (this.state === 'on' && document.visibilityState === 'visible' && navigator.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        if (this.state !== 'on') await this.wakeLock.release();
      }
    } catch {
      /* Screen wake locks are optional. */
    }
  }
  async resume() {
    if (this.context && this.context.state !== 'running') await this.context.resume();
    this.acquireWakeLock();
  }
  setGain(value) {
    this.gainValue = value;
    if (this.gain)
      this.gain.gain.setTargetAtTime(this.muted ? 0 : value, this.context.currentTime, 0.015);
  }
  setMuted(value) {
    this.muted = value;
    this.setGain(this.gainValue);
    this.emit('state');
  }
  async setVoice(name) {
    if (!VOICES.includes(name)) throw new Error('未知变声效果');
    const request = ++this.voiceGeneration,
      context = this.context;
    if (!context || !this.source) {
      this.voice = name;
      this.emit('voice');
      return;
    }
    try {
      if (name !== 'original' && !this.voiceNode) {
        if (!context.audioWorklet || !window.AudioWorkletNode)
          throw new Error('当前浏览器不支持实时变声');
        this.voiceLoading ||= context.audioWorklet.addModule(
          new URL('./voice-worklet.js', import.meta.url),
        );
        await this.voiceLoading;
        if (context !== this.context || request !== this.voiceGeneration) return;
        const node = new AudioWorkletNode(context, 'pocketlink-voice', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
        });
        node.addEventListener(
          'processorerror',
          () => {
            if (this.voiceNode !== node) return;
            this.resetVoice();
            this.emit('warning', { message: '变声处理已中断，已恢复原声。' });
          },
          { once: true },
        );
        node.connect(this.gain);
        this.source.disconnect();
        this.source.connect(node);
        this.voiceNode = node;
      }
      if (context !== this.context || request !== this.voiceGeneration) return;
      this.voiceNode?.port.postMessage({ voice: name });
      this.voice = name;
      this.emit('voice');
    } catch {
      if (context !== this.context || request !== this.voiceGeneration) return;
      this.resetVoice();
      this.emit('warning', {
        message: '变声暂不可用，已恢复原声。请刷新重试，或检查 Safari 是否已信任此 HTTPS 网站。',
      });
    }
  }
  resetVoice() {
    if (this.voiceNode) {
      this.voiceNode.disconnect();
      this.voiceNode.port.close();
      this.voiceNode = null;
      this.source?.disconnect();
      if (this.source && this.gain) this.source.connect(this.gain);
    }
    this.voiceLoading = null;
    this.voice = 'original';
    this.emit('voice');
  }
  async setOptions(options) {
    if (this.track) {
      await this.track.applyConstraints({ ...options, autoGainControl: false });
    }
    this.options = { ...options };
    if (this.track) {
      const actual = this.track.getSettings();
      const unsupported = Object.keys(options).filter(
        (k) => options[k] === true && actual[k] !== true,
      );
      if (unsupported.length)
        this.emit('warning', { message: '部分声音处理选项由浏览器管理，实际效果取决于设备支持。' });
    }
  }
  startRecording() {
    if (
      this.state !== 'on' ||
      this.recording ||
      (this.recorder?.state === 'inactive' && this.finishing)
    )
      return;
    if (!window.MediaRecorder)
      throw new Error('当前浏览器不支持录音，请升级 Safari 或换用 Chrome。');
    const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
    this.recorder = new MediaRecorder(
      this.stream,
      mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined,
    );
    const chunks = [];
    let bytes = 0;
    const startedAt = Date.now();
    this.recordStartedAt = startedAt;
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) {
        chunks.push(e.data);
        bytes += e.data.size;
        if (bytes > 50 * 1024 * 1024) {
          this.stopRecording();
          this.emit('warning', { message: '单段录音达到 50 MB，已自动停止。请下载保存。' });
        }
      }
    };
    this.recorder.onstop = () => {
      clearTimeout(this.recordLimit);
      const mime = this.recorder.mimeType || chunks[0]?.type || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      this.finishing = false;
      if (blob.size)
        this.emit('recorded', {
          blob,
          mime,
          startedAt,
          duration: (this.recordStoppedAt || Date.now()) - startedAt,
        });
      this.emit('recording');
    };
    this.recorder.onerror = (e) => {
      this.stopRecording();
      this.emit('warning', { message: e.error?.message || '录音发生错误，请重新录制。' });
    };
    this.recordStoppedAt = null;
    this.recorder.start(1000);
    this.recording = true;
    this.emit('recording');
    this.recordLimit = setTimeout(
      () => {
        this.stopRecording();
        this.emit('warning', { message: '已完成 30 分钟录音，请下载后继续。' });
      },
      30 * 60 * 1000,
    );
  }
  stopRecording() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recordStoppedAt = Date.now();
      this.finishing = true;
      this.recording = false;
      clearTimeout(this.recordLimit);
      this.recorder.stop();
      this.emit('recording');
    }
  }
  async stop() {
    ++this.generation;
    ++this.voiceGeneration;
    this.stopRecording();
    this.state = 'off';
    this.muted = false;
    if (this.track) {
      this.track.onended = null;
      this.track.onmute = null;
    }
    this.raw?.getTracks().forEach((t) => t.stop());
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.gain?.disconnect();
    this.analyser?.disconnect();
    if (this.voiceNode) {
      this.voiceNode.disconnect();
      this.voiceNode.port.close();
      this.voiceNode = null;
    }
    this.voiceLoading = null;
    const context = this.context;
    this.context = null;
    if (context) {
      context.onstatechange = null;
      await context.close().catch(() => {});
    }
    await this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.raw = null;
    this.stream = null;
    this.track = null;
    this.source = null;
    this.analyser = null;
    this.gain = null;
    this.emit('state');
  }
}
export function friendlyError(error) {
  return (
    {
      NotAllowedError: '麦克风权限被拒绝，请在浏览器的网站设置中允许麦克风。',
      NotFoundError: '没有找到可用麦克风，请检查设备连接。',
      NotReadableError: '麦克风被其他程序占用，或设备暂时不可用。',
      OverconstrainedError: '当前麦克风不支持此音频设置。',
      SecurityError: '浏览器限制了麦克风访问，请使用可信 HTTPS 地址。',
    }[error.name] ||
    error.message ||
    '操作未完成，请重试。'
  );
}
