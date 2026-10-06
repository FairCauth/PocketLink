import { VOICES } from './voice-dsp.js';
import { createNoiseProcessor } from './noise-processor.js';

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.state = 'off';
    this.gainValue = 1;
    this.muted = false;
    this.voice = 'original';
    this.voiceGeneration = 0;
    this.options = { noiseSuppression: true, echoCancellation: true };
    this.noiseMode = 'off';
    this.noiseGeneration = 0;
    this.previewing = false;
    this.recording = false;
    this.generation = 0;
    this.soundGeneration = 0;
    this.sound = null;
    this.soundBuffers = new Map();
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
      const Context = window.AudioContext || window.webkitAudioContext;
      try {
        this.context = new Context({ sampleRate: 48000 });
      } catch (error) {
        if (error.name !== 'NotSupportedError') throw error;
        this.context = new Context();
      }
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
      // Stable microphone bus: capture → denoise → voice → gain → mix.
      // Soundboard audio joins the mix afterwards, so denoising never removes effects.
      this.micInput = this.context.createGain();
      this.source.connect(this.micInput);
      this.micInput.connect(this.gain);
      this.gain.connect(this.analyser);
      this.analyser.connect(this.destination);
      this.stream = this.destination.stream;
      this.stream.getAudioTracks()[0].contentHint = 'speech';
      await this.configureProcessing();
      if (generation !== this.generation) return;
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
      this.gain.gain.setTargetAtTime(
        this.muted || this.previewing ? 0 : value,
        this.context.currentTime,
        0.015,
      );
  }
  setPreviewing(value) {
    this.previewing = value;
    this.setGain(this.gainValue);
  }
  setMuted(value) {
    this.muted = value;
    this.setGain(this.gainValue);
    this.emit('state');
  }
  stopSound() {
    ++this.soundGeneration;
    this.soundRequest?.abort();
    this.soundRequest = null;
    if (this.soundSource) {
      this.soundSource.onended = null;
      this.soundSource.stop();
      this.soundSource.disconnect();
      this.soundSource = null;
    }
    this.sound = null;
    this.emit('sound');
  }
  async playSound(sound) {
    if (this.state !== 'on') throw new Error('请先连接麦克风。');
    this.stopSound();
    const request = this.soundGeneration;
    const context = this.context;
    const controller = new AbortController();
    this.soundRequest = controller;
    this.sound = { ...sound, loading: true };
    this.emit('sound');
    try {
      // Resume inside the tap gesture, before fetching/decoding on iPhone.
      await context.resume();
      let buffer = this.soundBuffers.get(sound.url);
      if (!buffer) {
        const response = await fetch(sound.url, { signal: controller.signal });
        if (!response.ok) throw new Error('音效加载失败，请刷新页面重试。');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('音效不能超过 10 MB。');
        buffer = await context.decodeAudioData(bytes);
        if (buffer.duration > 60) throw new Error('音效不能超过 60 秒。');
        if (request !== this.soundGeneration || context !== this.context) return;
        if (this.soundBuffers.size >= 8)
          this.soundBuffers.delete(this.soundBuffers.keys().next().value);
        this.soundBuffers.set(sound.url, buffer);
      }
      if (request !== this.soundGeneration || context !== this.context) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      // Mix after microphone gain/voice processing, into the same WebRTC/recording stream.
      // Never connect to context.destination: the phone speaker stays silent.
      source.connect(this.analyser);
      source.onended = () => {
        if (this.soundSource === source) this.stopSound();
      };
      this.soundSource = source;
      source.start();
      this.soundRequest = null;
      this.sound = { ...sound, loading: false };
      this.emit('sound');
    } catch (error) {
      if (request !== this.soundGeneration || context !== this.context) return;
      this.stopSound();
      if (error.name === 'EncodingError') throw new Error('无法解码这个音效，请使用 MP3 或 WAV。');
      throw error;
    }
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
        this.micInput.disconnect(this.gain);
        this.micInput.connect(node);
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
      this.micInput?.disconnect(this.voiceNode);
      this.voiceNode.disconnect();
      this.voiceNode.port.close();
      this.voiceNode = null;
      if (this.micInput && this.gain) this.micInput.connect(this.gain);
    }
    this.voiceLoading = null;
    this.voice = 'original';
    this.emit('voice');
  }
  async setOptions(options) {
    if (this.track) {
      await this.track.applyConstraints({
        ...options,
        noiseSuppression:
          this.noiseMode === 'ai' && options.noiseSuppression ? false : options.noiseSuppression,
        autoGainControl: false,
      });
    }
    this.options = { ...options };
    await this.configureProcessing();
  }
  processingStatus() {
    const actual = this.track?.getSettings() || {};
    return {
      noise: this.noiseMode,
      browserNoise: actual.noiseSuppression,
      echo: actual.echoCancellation,
      active: Boolean(this.track),
    };
  }
  bypassNoise() {
    if (this.noiseProcessor) {
      this.source?.disconnect(this.noiseProcessor.node);
      this.noiseProcessor.destroy();
      this.noiseProcessor = null;
      if (this.source && this.micInput) this.source.connect(this.micInput);
    }
  }
  async configureProcessing() {
    const request = ++this.noiseGeneration;
    this.noiseRequest?.abort();
    const context = this.context;
    if (!context || !this.track) {
      this.emit('processing');
      return;
    }
    if (this.options.noiseSuppression && this.noiseProcessor) {
      this.emit('processing');
      return;
    }
    this.bypassNoise();
    this.noiseMode = this.options.noiseSuppression ? 'loading' : 'off';
    this.emit('processing');
    if (!this.options.noiseSuppression) {
      return;
    }
    const controller = new AbortController();
    this.noiseRequest = controller;
    const timer = setTimeout(() => controller.abort(), 10000);
    let processor;
    try {
      processor = await createNoiseProcessor(context, controller.signal);
      if (context !== this.context || request !== this.noiseGeneration) {
        processor.destroy();
        return;
      }
      // Avoid stacking the browser's denoiser and RNNoise, which can clip quiet speech.
      await this.track.applyConstraints({
        ...this.options,
        noiseSuppression: false,
        autoGainControl: false,
      });
      if (context !== this.context || request !== this.noiseGeneration) {
        processor.destroy();
        return;
      }
      processor.node.connect(this.micInput);
      this.source.disconnect(this.micInput);
      this.source.connect(processor.node);
      this.noiseProcessor = processor;
      this.noiseMode = 'ai';
      processor.node.addEventListener(
        'processorerror',
        () => {
          if (this.noiseProcessor !== processor) return;
          this.bypassNoise();
          void this.fallbackNoise();
        },
        { once: true },
      );
    } catch {
      processor?.destroy();
      if (context !== this.context || request !== this.noiseGeneration) return;
      await this.fallbackNoise();
    } finally {
      clearTimeout(timer);
    }
    this.emit('processing');
  }
  async fallbackNoise() {
    const track = this.track;
    this.noiseMode = 'browser';
    try {
      await track?.applyConstraints({ ...this.options, autoGainControl: false });
    } catch {
      /* Keep the microphone connected even if processing is unsupported. */
    }
    this.emit('processing');
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
    ++this.noiseGeneration;
    this.noiseRequest?.abort();
    this.noiseRequest = null;
    this.bypassNoise();
    this.noiseMode = 'off';
    this.previewing = false;
    this.stopSound();
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
    this.micInput?.disconnect();
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
    this.micInput = null;
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
