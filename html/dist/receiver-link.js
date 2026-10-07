import { AudioLink } from './connection.js';

class USBLink extends EventTarget {
  constructor() {
    super();
    this.status = 'idle';
    this.generation = 0;
  }
  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  setStatus(status) {
    this.status = status;
    this.emit('status', { status });
  }
  async open({ context, server }) {
    this.close();
    const generation = ++this.generation;
    this.setStatus('connecting');
    try {
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ||
        (server && new URL(server).origin !== location.origin)
      )
        throw new Error('USB 接收页请在运行服务的电脑上通过 localhost 打开。');
      const response = await fetch('/api/config', { signal: AbortSignal.timeout(8000) });
      this.config = await response.json();
      if (this.config.usbProtocol !== 'pocketlink-usb-v1')
        throw new Error('请重启新版 PocketLink 电脑服务。');
      await context.audioWorklet.addModule('/usb-pcm-worklet.js');
      if (generation !== this.generation) return;
      this.context = context;
      this.node = new AudioWorkletNode(context, 'pocketlink-usb-pcm', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.destination = context.createMediaStreamDestination();
      this.node.connect(this.destination);
      const socket = (this.socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/usb`,
      ));
      socket.binaryType = 'arraybuffer';
      const channel = (this.channel = {
        readyState: 'connecting',
        send: (data) => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: 'control', message: JSON.parse(data) }));
        },
      });
      socket.onmessage = ({ data }) => {
        if (generation !== this.generation) return;
        try {
          if (data instanceof ArrayBuffer) {
            if (this.context.state === 'running') this.node.port.postMessage(data, [data]);
            return;
          }
          const message = JSON.parse(data);
          if (message.type === 'created') {
            this.setStatus('waiting');
            this.emit('code', message);
          } else if (message.type === 'connected') {
            this.setStatus('connected');
            this.emit('stream', { stream: this.destination.stream });
            channel.readyState = 'open';
            this.emit('control', { channel });
          } else if (message.type === 'control')
            channel.onmessage?.({ data: JSON.stringify(message.message) });
          else if (message.type === 'error') this.fail(message.message);
          else if (message.type === 'notice') this.emit('notice', message);
        } catch (error) {
          this.fail(error.message);
        }
      };
      socket.onerror = () => {
        if (generation === this.generation)
          this.fail('USB 服务连接失败，请关闭其他 USB 接收页并重试。');
      };
      socket.onclose = () => {
        if (generation === this.generation) this.fail('USB 连接已关闭，请重新配对。');
      };
    } catch (error) {
      if (generation === this.generation) {
        this.close();
        throw error;
      }
    }
  }
  fail(message) {
    this.close();
    this.emit('error', { message });
  }
  close() {
    ++this.generation;
    if (this.channel) {
      this.channel.readyState = 'closed';
      this.channel.onclose?.();
    }
    this.socket?.close();
    this.socket = null;
    this.node?.port.postMessage({ stop: true });
    this.node?.disconnect();
    this.node?.port.close();
    this.destination?.stream.getTracks().forEach((track) => track.stop());
    this.node = this.destination = this.channel = null;
    this.setStatus('idle');
  }
}
export class ReceiverLink extends EventTarget {
  constructor() {
    super();
    this.wireless = new AudioLink();
    this.usb = new USBLink();
    this.active = this.wireless;
    for (const link of [this.wireless, this.usb]) {
      for (const type of [
        'status',
        'code',
        'stream',
        'control',
        'sounds-changed',
        'notice',
        'error',
      ]) {
        link.addEventListener(type, ({ detail }) => {
          if (link === this.active) this.dispatchEvent(new CustomEvent(type, { detail }));
        });
      }
    }
  }
  get status() {
    return this.active.status;
  }
  get config() {
    return this.active.config;
  }
  open(options) {
    this.close();
    this.active = options.mode === 'usb' ? this.usb : this.wireless;
    return this.active.open(options);
  }
  close() {
    this.active.close();
  }
}
