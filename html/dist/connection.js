export function serviceURL(value = '') {
  const url = new URL(value || location.origin);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('请输入不含路径参数的 http:// 或 https:// 服务器地址。');
  if (location.protocol === 'https:' && url.protocol !== 'https:')
    throw new Error('HTTPS 页面只能连接 HTTPS 服务器。');
  return url.origin;
}
export class AudioLink extends EventTarget {
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
  send(data) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(data));
  }
  async open({ role, code, server, mode = 'lan', stream, control = false }) {
    this.close();
    const generation = ++this.generation;
    this.role = role;
    this.mode = mode;
    this.stream = stream;
    this.useControl = control;
    this.setStatus('connecting');
    try {
      const base = serviceURL(server);
      this.abort = new AbortController();
      const timeout = setTimeout(() => this.abort?.abort(), 8000);
      let response;
      try {
        response = await fetch(`${base}/api/config`, { signal: this.abort.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error('无法访问 PocketLink 服务，请检查服务器地址。');
      try {
        this.config = await response.json();
      } catch {
        throw new Error('此地址没有运行 PocketLink 服务，请先在电脑启动接收服务。');
      }
      if (this.config.protocol !== 'pocketlink-v1')
        throw new Error('此地址不是 PocketLink 接收服务。');
      if (generation !== this.generation) return;
      if (mode === 'server' && !this.config.relayAvailable)
        throw new Error('服务器尚未配置 TURN 音频中继，请配置后使用服务器模式。');
      const endpoint = new URL('/signal', base);
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
      this.socket = new WebSocket(endpoint);
      let queue = Promise.resolve();
      this.socket.onopen = () => {
        if (generation !== this.generation) return;
        this.send(role === 'receiver' ? { type: 'create' } : { type: 'join', code, mode });
      };
      this.socket.onmessage = (e) => {
        queue = queue
          .then(async () => {
            if (generation !== this.generation) return;
            const message = JSON.parse(e.data);
            await this.handle(message);
          })
          .catch((error) => {
            if (generation === this.generation) this.fail(error);
          });
      };
      this.socket.onerror = () => {
        if (generation === this.generation)
          this.fail(new Error('连接服务失败，请确认地址、证书和网络设置。'));
      };
      this.socket.onclose = () => {
        if (generation === this.generation && this.status !== 'idle')
          this.fail(new Error('连接已断开，请重新配对。'));
      };
      this.connectTimeout = setTimeout(() => {
        if (generation === this.generation && this.status === 'connecting')
          this.fail(new Error('配对请求超时，请检查服务是否在线。'));
      }, 12000);
    } catch (error) {
      if (generation !== this.generation) return;
      this.close();
      throw error.name === 'AbortError' ? new Error('服务器响应超时，请检查网络和地址。') : error;
    }
  }
  async handle(message) {
    if (message.type === 'sounds-changed') this.emit('sounds-changed');
    if (message.type === 'error') throw new Error(message.message);
    if (message.type === 'created') {
      clearTimeout(this.connectTimeout);
      this.setStatus('waiting');
      this.emit('code', { code: message.code, expiresAt: message.expiresAt });
    }
    if (message.type === 'joined') {
      clearTimeout(this.connectTimeout);
      this.createPeer(this.mode);
      if (this.useControl) {
        this.controlChannel = this.peer.createDataChannel('pocketlink-control-v1');
        this.emit('control', { channel: this.controlChannel });
      }
      this.setStatus('negotiating');
      this.stream.getTracks().forEach((track) => this.peer.addTrack(track, this.stream));
      await this.peer.setLocalDescription(await this.peer.createOffer());
      this.send({ type: 'signal', description: this.peer.localDescription });
    }
    if (message.type === 'peer-joined') {
      this.mode = message.mode;
      this.createPeer(message.mode);
      this.setStatus('negotiating');
    }
    if (message.type === 'signal') {
      if (!this.peer) throw new Error('连接会话未准备好，请重新配对。');
      if (message.description) {
        await this.peer.setRemoteDescription(message.description);
        for (const candidate of this.pendingCandidates.splice(0))
          await this.peer.addIceCandidate(candidate);
        if (message.description.type === 'offer') {
          await this.peer.setLocalDescription(await this.peer.createAnswer());
          this.send({ type: 'signal', description: this.peer.localDescription });
        }
      }
      if (message.candidate) {
        if (this.peer.remoteDescription) await this.peer.addIceCandidate(message.candidate);
        else this.pendingCandidates.push(message.candidate);
      }
    }
    if (message.type === 'peer-left') {
      this.clearPeer();
      if (this.role === 'receiver') {
        this.setStatus('waiting');
        this.emit('code', { code: message.code, expiresAt: message.expiresAt });
        this.emit('notice', { message: '手机已断开，可以用当前配对码重新连接。' });
      } else this.fail(new Error('电脑接收端已关闭，请重新配对。'));
    }
  }
  createPeer(mode) {
    this.clearPeer();
    this.pendingCandidates = [];
    if (mode === 'server' && !this.config.relayAvailable) throw new Error('服务器未配置音频中继。');
    const peer = (this.peer = new RTCPeerConnection({
      iceServers: mode === 'server' ? this.config.iceServers : [],
      iceTransportPolicy: mode === 'server' ? 'relay' : 'all',
    }));
    peer.onicecandidate = (e) => {
      if (e.candidate) this.send({ type: 'signal', candidate: e.candidate.toJSON() });
    };
    peer.ontrack = (e) =>
      this.emit('stream', { stream: e.streams[0] || new MediaStream([e.track]) });
    peer.ondatachannel = ({ channel }) => {
      if (this.role === 'receiver' && channel.label === 'pocketlink-control-v1')
        this.emit('control', { channel });
      else channel.close();
    };
    peer.onconnectionstatechange = () => {
      if (peer !== this.peer) return;
      if (peer.connectionState === 'connected') {
        clearTimeout(this.peerTimeout);
        clearTimeout(this.disconnectTimeout);
        this.setStatus('connected');
        this.connectedAt = Date.now();
      }
      if (peer.connectionState === 'failed')
        this.fail(new Error('音频连接失败。请检查同一网络、系统防火墙或 TURN 服务。'));
      if (peer.connectionState === 'disconnected') {
        clearTimeout(this.disconnectTimeout);
        this.setStatus('reconnecting');
        this.disconnectTimeout = setTimeout(
          () => this.fail(new Error('音频连接中断，请重新配对。')),
          12000,
        );
      }
    };
    this.peerTimeout = setTimeout(() => {
      if (peer === this.peer && peer.connectionState !== 'connected')
        this.fail(new Error('音频连接超时，请检查网络和防火墙。'));
    }, 25000);
    this.statsTimer = setInterval(async () => {
      try {
        const stats = await peer.getStats();
        for (const report of stats.values()) {
          if (
            report.type === 'candidate-pair' &&
            report.state === 'succeeded' &&
            (report.nominated || report.selected)
          ) {
            this.emit('stats', {
              rtt:
                typeof report.currentRoundTripTime === 'number'
                  ? Math.round(report.currentRoundTripTime * 1000)
                  : null,
            });
          }
        }
      } catch {
        /* Peer may close during getStats. */
      }
    }, 2000);
  }
  fail(error) {
    this.close();
    this.emit('error', { message: error.message });
  }
  clearPeer() {
    this.controlChannel?.close();
    this.controlChannel = null;
    clearTimeout(this.peerTimeout);
    clearTimeout(this.disconnectTimeout);
    clearInterval(this.statsTimer);
    if (this.peer) {
      this.peer.onconnectionstatechange = null;
      this.peer.onicecandidate = null;
      this.peer.ontrack = null;
      this.peer.ondatachannel = null;
      this.peer.close();
      this.peer = null;
    }
  }
  close() {
    ++this.generation;
    this.abort?.abort();
    this.abort = null;
    clearTimeout(this.connectTimeout);
    this.clearPeer();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.onopen = null;
      this.socket.close();
      this.socket = null;
    }
    this.connectedAt = null;
    this.setStatus('idle');
  }
}
