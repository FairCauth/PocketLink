import { VOICES } from './voice-dsp.js';

// One selected microphone feeds the voice bus. Sound effects bypass voice processing.
export class ReceiverMixer extends EventTarget {
  constructor(context, remote) {
    super();
    this.context = context;
    this.destination = context.createMediaStreamDestination();
    this.stream = this.destination.stream;
    this.voiceInput = context.createGain();
    this.voiceInput.connect(this.destination);
    this.voice = 'original';
    this.voiceGeneration = 0;
    this.localGain = context.createGain();
    this.localGain.connect(this.voiceInput);
    // Keep remote WebRTC playout active while Web Audio consumes its samples.
    this.remotePlayback = new Audio();
    this.remotePlayback.autoplay = true;
    this.remotePlayback.muted = true;
    this.generation = 0;
    this.setRemote(remote);
  }
  setRemote(stream) {
    this.remote?.disconnect();
    this.remote = null;
    this.remotePlayback.pause();
    this.remotePlayback.srcObject = stream;
    if (!stream) return;
    void this.remotePlayback.play().catch(() => {});
    this.remote = this.context.createMediaStreamSource(stream);
    this.stopLocal();
    this.remote.connect(this.localGain);
  }
  async setVoice(name) {
    if (!VOICES.includes(name)) throw new Error('未知变声预设');
    const generation = ++this.voiceGeneration;
    if (this.closed) return;
    if (name === 'original') {
      this.resetVoice();
      return;
    }
    try {
      this.voiceLoading ||= this.context.audioWorklet.addModule(
        new URL('./voice-worklet.js', import.meta.url),
      );
      await this.voiceLoading;
      if (this.closed || generation !== this.voiceGeneration) return;
      if (!this.voiceNode) {
        const node = new AudioWorkletNode(this.context, 'pocketlink-voice', {
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
            ++this.voiceGeneration;
            this.resetVoice();
            this.dispatchEvent(new Event('voice-error'));
          },
          { once: true },
        );
        this.voiceInput.disconnect();
        this.voiceInput.connect(node);
        node.connect(this.destination);
        this.voiceNode = node;
      }
      this.voiceNode.port.postMessage({ voice: name });
      this.voice = name;
      this.dispatchEvent(new Event('voice'));
    } catch (error) {
      if (generation !== this.voiceGeneration || this.closed) return;
      this.voiceLoading = null;
      this.resetVoice();
      throw new Error('变声加载失败，已恢复原声。' + error.message);
    }
  }
  resetVoice() {
    this.voiceInput.disconnect();
    if (this.voiceNode) {
      this.voiceNode.port.postMessage({ stop: true });
      this.voiceNode.disconnect();
      this.voiceNode.port.close();
      this.voiceNode = null;
    }
    if (!this.closed) this.voiceInput.connect(this.destination);
    this.voice = 'original';
    this.dispatchEvent(new Event('voice'));
  }
  async startLocal(deviceId) {
    this.setRemote(null);
    this.stopLocal();
    const generation = this.generation;
    const raw = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
      video: false,
    });
    if (generation !== this.generation) {
      raw.getTracks().forEach((track) => track.stop());
      return false;
    }
    try {
      this.raw = raw;
      this.localDeviceId = deviceId;
      this.source = this.context.createMediaStreamSource(raw);
      this.source.connect(this.localGain);
      raw.getAudioTracks()[0].onended = () => {
        this.stopLocal();
        this.dispatchEvent(new Event('ended'));
      };
      return true;
    } catch (error) {
      this.stopLocal();
      throw error;
    }
  }
  setGain(value) {
    this.localGain.gain.setTargetAtTime(value, this.context.currentTime, 0.015);
  }
  playSound(buffer, onEnded) {
    this.stopSound();
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination);
    this.sound = source;
    source.onended = () => {
      if (this.sound !== source) return;
      source.disconnect();
      this.sound = null;
      onEnded();
      this.dispatchEvent(new Event('sound-ended'));
    };
    source.start();
  }
  stopSound() {
    if (!this.sound) return;
    this.sound.onended = null;
    this.sound.stop();
    this.sound.disconnect();
    this.sound = null;
  }
  stopLocal() {
    ++this.generation;
    this.raw?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.source?.disconnect();
    this.raw = this.source = null;
    this.localDeviceId = null;
  }
  close() {
    this.closed = true;
    ++this.voiceGeneration;
    this.resetVoice();
    this.stopSound();
    this.setRemote(null);
    this.stopLocal();
    this.localGain.disconnect();
    this.stream.getTracks().forEach((track) => track.stop());
  }
}
