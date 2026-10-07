// Catalog and playback belong to the desktop; a phone is an optional controller.
export class RemoteSoundboard extends EventTarget {
  constructor(getMixer, reportError, voiceControl, ensureMixer) {
    super();
    Object.assign(this, { getMixer, reportError, voiceControl, ensureMixer });
    this.base = location.origin;
    this.sounds = [];
    this.playing = null;
    this.revision = 0;
  }
  send(message) {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(message));
  }
  sendVoiceState() {
    this.sendInputState();
    if (this.voiceControl) this.send({ type: 'voice-state', ...this.voiceControl.state() });
  }
  sendInputState() {
    if (this.voiceControl?.input) this.send({ type: 'input-state', ...this.voiceControl.input() });
  }
  sendCatalog() {
    this.send({ type: 'catalog', sounds: this.sounds.map(({ id, name }) => ({ id, name })) });
  }
  state(id) {
    this.playing = id;
    this.send({ type: 'sound-state', id });
    this.dispatchEvent(new Event('change'));
  }
  async refresh(base = this.base) {
    const revision = ++this.revision;
    this.base = base;
    try {
      const response = await fetch(`${base}/sounds/index.json`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok && response.status !== 404) throw new Error('音效列表暂不可用，请重试。');
      const catalog = response.status === 404 ? {} : await response.json();
      const ids = new Set();
      const sounds = (Array.isArray(catalog.sounds) ? catalog.sounds : [])
        .filter((item) => {
          if (
            typeof item?.id !== 'string' ||
            item.id.length > 100 ||
            ids.has(item.id) ||
            typeof item.name !== 'string' ||
            !/^\/sounds\/[a-f0-9]{64}\.(mp3|wav|m4a)$/.test(item.url)
          )
            return false;
          ids.add(item.id);
          return true;
        })
        .slice(0, 50);
      if (revision !== this.revision) return;
      this.sounds = sounds;
      this.sendCatalog();
      this.dispatchEvent(new Event('change'));
    } catch (error) {
      if (revision !== this.revision) return;
      this.send({ type: 'sound-error', message: error.message });
      this.reportError(error.message);
    }
  }
  stop() {
    this.abort?.abort();
    this.getMixer()?.stopSound();
    this.state(null);
  }
  async play(id, owner = null) {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.owner = owner;
    try {
      const sound = this.sounds.find((item) => item.id === id);
      if (!sound) throw new Error('音效不存在，请刷新列表。');
      this.send({ type: 'sound-loading', id: sound.id });
      const base = this.base;
      const mixer = await this.ensureMixer();
      if (abort.signal.aborted) return;
      const response = await fetch(`${base}${sound.url}`, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) throw new Error('无法读取电脑上的音效文件。');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 20 * 1024 * 1024)
        throw new Error('音效超过 20 MB，请使用更短的音效。');
      const buffer = await mixer.context.decodeAudioData(bytes);
      if (abort.signal.aborted || mixer !== this.getMixer()) return;
      mixer.playSound(buffer, () => this.state(null));
      this.state(sound.id);
    } catch (error) {
      if (abort.signal.aborted) return;
      this.send({ type: 'sound-state', id: this.playing });
      this.send({ type: 'sound-error', message: error.message });
      this.reportError(error.message);
    }
  }
  detach() {
    if (this.owner && this.owner === this.channel) this.abort?.abort();
    if (this.channel) this.channel.onmessage = this.channel.onopen = this.channel.onclose = null;
    this.channel = null;
  }
  attach(channel, base) {
    this.detach();
    this.channel = channel;
    const ready = () => {
      this.sendVoiceState();
      this.send({ type: 'sound-state', id: this.playing });
      void this.refresh(base);
    };
    channel.onopen = ready;
    channel.onclose = () => {
      if (this.channel === channel) this.detach();
    };
    channel.onmessage = async ({ data }) => {
      if (typeof data !== 'string' || data.length > 2048) return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message?.type === 'refresh-catalog') {
        this.sendVoiceState();
        this.send({ type: 'sound-state', id: this.playing });
        void this.refresh(base);
      }
      if (message?.type === 'play-sound') void this.play(message.id, channel);
      if (message?.type === 'stop-sound') this.stop();
      if (message?.type === 'set-voice' && this.voiceControl) {
        try {
          await this.voiceControl.set(message.id);
          if (this.channel === channel) this.sendVoiceState();
        } catch (error) {
          if (this.channel === channel) this.send({ type: 'voice-error', message: error.message });
        }
      }
    };
    if (channel.readyState === 'open') ready();
  }
}
