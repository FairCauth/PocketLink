import { randomInt } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { listUSBDevices, connectUSBDevice } from './usbmux.mjs';

export const MAX_FRAME = 65536;
export function frame(payload) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}
export const jsonFrame = (value) =>
  frame(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(value))]));
export function frameReader(onFrame) {
  let buffer = Buffer.alloc(0);
  return (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32BE(0);
      if (size < 1 || size > MAX_FRAME) throw new Error('USB 数据帧长度无效。');
      if (buffer.length < size + 4) return;
      const payload = buffer.subarray(4, size + 4);
      buffer = buffer.subarray(size + 4);
      onFrame(payload);
    }
  };
}
export function installUSBBridge(server, { muxOptions, retryMs = 1500 } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const loopback = (host) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(host);
  function upgrade(req, socket, head) {
    if (req.url !== '/usb') return false;
    socket.on('error', () => socket.destroy());
    let allowed = false;
    try {
      const origin = new URL(req.headers.origin);
      allowed =
        loopback(req.socket.remoteAddress) &&
        ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) &&
        origin.host === req.headers.host &&
        origin.protocol === (req.socket.encrypted ? 'https:' : 'http:');
    } catch {}
    if (!allowed || wss.clients.size) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
    return true;
  }
  wss.on('connection', (ws) => {
    const code = String(randomInt(0, 100000000)).padStart(8, '0');
    const abort = new AbortController();
    let tunnel,
      retry,
      expiry,
      heartbeat,
      ready = false,
      lastPong = Date.now();
    const send = (message) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const options = { ...muxOptions, signal: abort.signal };
    const stop = () => {
      abort.abort();
      clearTimeout(retry);
      clearTimeout(expiry);
      clearInterval(heartbeat);
      tunnel?.destroy();
    };
    const fail = (message) => {
      send({ type: 'error', message });
      stop();
      ws.close();
    };
    ws.on('close', stop);
    ws.on('error', stop);
    ws.on('pong', () => {
      lastPong = Date.now();
    });
    heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 15000) {
        stop();
        ws.terminate();
      } else ws.ping();
    }, 5000);
    ws.on('message', (data, binary) => {
      if (binary || !ready || !tunnel || data.length > MAX_FRAME - 1) return;
      try {
        const value = JSON.parse(data);
        if (value.type !== 'control' || !value.message || typeof value.message !== 'object') return;
        if (tunnel.writableLength > 128 * 1024) return fail('USB 控制队列已满，请重新连接。');
        tunnel.write(jsonFrame({ type: 'control', message: value.message }));
      } catch {
        fail('USB 控制消息无效。');
      }
    });
    send({ type: 'created', code, expiresAt: Date.now() + 600000 });
    expiry = setTimeout(() => fail('USB 配对码已过期，请重新创建。'), 600000);
    async function connect() {
      try {
        const devices = await listUSBDevices(options);
        if (abort.signal.aborted) return;
        if (!devices.length)
          send({
            type: 'notice',
            message: '未检测到 USB iPhone。请插入数据线、解锁并信任电脑；无需开启热点。',
          });
        for (const device of devices) {
          if (abort.signal.aborted) return;
          try {
            const socket = await connectUSBDevice(device, 23456, options);
            if (abort.signal.aborted) {
              socket.destroy();
              return;
            }
            tunnel = socket;
            const paired = await new Promise((resolve) => {
              let authenticated = false;
              const timer = setTimeout(() => socket.destroy(), 3000);
              socket.setTimeout(12000, () => socket.destroy());
              socket.on('error', () => socket.destroy());
              socket.on('close', () => {
                clearTimeout(timer);
                if (authenticated && !abort.signal.aborted)
                  fail('USB 数据线或 App 已断开，请重新连接。');
                resolve(false);
              });
              const receive = frameReader((payload) => {
                if (payload[0] === 1) {
                  const message = JSON.parse(payload.subarray(1).toString());
                  if (!authenticated) {
                    if (message.type !== 'ready' || message.protocol !== 'pocketlink-usb-v1')
                      throw new Error('USB App 版本或配对码不匹配。');
                    authenticated = ready = true;
                    clearTimeout(timer);
                    clearTimeout(expiry);
                    send({ type: 'connected' });
                    resolve(true);
                  } else if (message.type === 'ping') socket.write(jsonFrame({ type: 'pong' }));
                  else if (message.type === 'control') send(message);
                } else if (payload[0] === 2 && authenticated) {
                  const rate = payload.length >= 7 ? payload.readUInt32LE(1) : 0;
                  if (rate < 8000 || rate > 192000 || (payload.length - 5) % 2)
                    throw new Error('USB 音频格式无效。');
                  // Bound latency instead of retaining stale audio when the browser stalls.
                  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 128 * 1024)
                    ws.send(payload);
                } else throw new Error('USB 数据类型无效。');
              });
              socket.on('data', (data) => {
                try {
                  receive(data);
                } catch {
                  socket.destroy();
                }
              });
              socket.write(jsonFrame({ type: 'hello', protocol: 'pocketlink-usb-v1', code }));
              socket.resume();
            });
            if (paired || abort.signal.aborted) return;
          } catch (error) {
            if (!abort.signal.aborted) send({ type: 'notice', message: error.message });
          }
        }
        if (devices.length)
          send({
            type: 'notice',
            message:
              '等待 App：选择 USB 有线，输入上方配对码并点击连接。请确认已安装支持 USB 直连的新版 App。',
          });
      } catch (error) {
        if (!abort.signal.aborted)
          send({
            type: 'notice',
            message: `Apple USB 服务不可用，请安装或修复 Apple Devices。${error.code || error.message}`,
          });
      }
      if (!abort.signal.aborted) retry = setTimeout(connect, retryMs);
    }
    void connect();
  });
  function close() {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }
  server.once('close', close);
  return { upgrade, close };
}
