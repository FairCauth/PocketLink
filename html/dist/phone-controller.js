// The same control protocol is shared by the native App and the phone web page.
export class PhoneController extends EventTarget {
  constructor() {
    super();
    this.state = 'off';
    this.sounds = [];
    this.voice = 'original';
    this.presets = [];
    this.sound = null;
  }
  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  send(message) {
    if (this.channel?.readyState !== 'open') throw new Error('电脑控制通道未就绪，请重新连接。');
    this.channel.send(JSON.stringify(message));
  }
  detach() {
    clearTimeout(this.readyTimer);
    clearTimeout(this.voiceTimer);
    if (this.channel) this.channel.onopen = this.channel.onmessage = this.channel.onclose = null;
    this.channel = null;
    this.state = 'off';
    this.voicePending = false;
    this.sound = null;
    this.sounds = [];
    this.presets = [];
    this.input = null;
    this.emit('catalog');
    this.emit('state');
    this.emit('input');
  }
  attach(channel) {
    this.detach();
    this.channel = channel;
    const ready = () => {
      this.send({ type: 'refresh-catalog' });
      this.readyTimer = setTimeout(() => {
        if (this.state !== 'on')
          this.emit('error', { message: '电脑控制未就绪，请更新并刷新电脑工作台后重新配对。' });
      }, 8000);
    };
    channel.onopen = ready;
    channel.onclose = () => {
      if (this.channel !== channel) return;
      this.detach();
      this.emit('error', { message: '电脑控制通道已断开，请重新配对。' });
    };
    channel.onmessage = ({ data }) => {
      if (this.channel !== channel || typeof data !== 'string' || data.length > 65536) return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message?.type === 'catalog' && Array.isArray(message.sounds)) {
        const ids = new Set();
        this.sounds = message.sounds
          .filter((s) => {
            if (typeof s?.id !== 'string' || typeof s.name !== 'string' || ids.has(s.id))
              return false;
            ids.add(s.id);
            return true;
          })
          .slice(0, 50);
        if (this.sound)
          this.sound.name = this.sounds.find((s) => s.id === this.sound.id)?.name || '音效';
        this.emit('catalog');
      }
      if (message?.type === 'voice-state' && Array.isArray(message.presets)) {
        this.presets = message.presets
          .filter((p) => typeof p?.id === 'string' && typeof p.name === 'string')
          .slice(0, 20);
        if (!this.presets.some((p) => p.id === message.selected)) return;
        this.voice = message.selected;
        this.voicePending = false;
        clearTimeout(this.readyTimer);
        clearTimeout(this.voiceTimer);
        this.state = 'on';
        this.emit('voice');
        this.emit('state');
      }
      if (message?.type === 'input-state') {
        this.input = { phone: message.phone === true, enabled: message.enabled === true };
        this.emit('input');
      }
      if (message?.type === 'sound-state' || message?.type === 'sound-loading') {
        const sound = this.sounds.find((s) => s.id === message.id);
        this.sound = message.id
          ? {
              id: message.id,
              name: sound?.name || '音效',
              loading: message.type === 'sound-loading',
            }
          : null;
        this.emit('sound');
      }
      if (message?.type === 'voice-error') {
        clearTimeout(this.voiceTimer);
        this.voicePending = false;
        this.emit('voice');
        this.emit('error', { message: message.message || '变声切换失败。' });
      }
      if (message?.type === 'sound-error')
        this.emit('sound-error', { message: message.message || '音效播放失败。' });
    };
    if (channel.readyState === 'open') ready();
  }
  load() {
    if (this.channel?.readyState === 'open') this.send({ type: 'refresh-catalog' });
  }
  playSound(sound) {
    this.send({ type: 'play-sound', id: sound.id });
  }
  stopSound() {
    this.send({ type: 'stop-sound' });
  }
  setVoice(id) {
    this.send({ type: 'set-voice', id });
    this.voicePending = true;
    this.emit('voice');
    clearTimeout(this.voiceTimer);
    this.voiceTimer = setTimeout(() => {
      this.voicePending = false;
      this.emit('voice');
      this.emit('error', { message: '电脑未确认变声设置，请重新连接。' });
    }, 8000);
  }
}
