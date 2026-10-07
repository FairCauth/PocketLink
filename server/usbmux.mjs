import net from 'node:net';

// Apple's Windows usbmux service. No network-device fallback is permitted.
const endpoint = { host: '127.0.0.1', port: 27015 };
const MAX = 1024 * 1024;
const escapeXML = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );
export function plistXML(value) {
  if (Array.isArray(value)) return `<array>${value.map(plistXML).join('')}</array>`;
  if (value && typeof value === 'object')
    return `<dict>${Object.entries(value)
      .map(([k, v]) => `<key>${escapeXML(k)}</key>${plistXML(v)}`)
      .join('')}</dict>`;
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (typeof value === 'boolean') return `<${value}/>`;
  return `<string>${escapeXML(value)}</string>`;
}
// Bounded XML plist subset used by usbmux. External entities are never resolved.
export function parsePlist(xml) {
  const tokens = xml.replace(/<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/g, '').match(/<[^>]+>|[^<]+/g) || [];
  let i = 0;
  const skip = () => {
    while (tokens[i]?.trim() === '') i++;
  };
  const decode = (s) =>
    s.replace(
      /&(lt|gt|amp|quot|apos);/g,
      (_, key) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[key],
    );
  function read(depth = 0) {
    if (depth > 24) throw new Error('Invalid usbmux plist depth');
    skip();
    const tag = tokens[i++];
    const match = /^<(dict|array|key|string|integer|data|real|date|true|false)\s*(\/?)>$/.exec(
      tag || '',
    );
    if (!match) throw new Error('Invalid usbmux plist');
    const [, type, empty] = match;
    if (type === 'true' || type === 'false') return type === 'true';
    if (type === 'dict' || type === 'array') {
      const result = type === 'dict' ? Object.create(null) : [];
      if (empty) return result;
      skip();
      while (tokens[i] !== `</${type}>`) {
        if (type === 'dict') {
          if (tokens[i] !== '<key>') throw new Error('Invalid plist key');
          const key = read(depth + 1);
          result[key] = read(depth + 1);
        } else result.push(read(depth + 1));
        skip();
      }
      i++;
      return result;
    }
    let text = '';
    if (!empty) {
      if (!tokens[i]?.startsWith('<')) text = tokens[i++];
      if (tokens[i++] !== `</${type}>`) throw new Error('Invalid plist value');
    }
    return type === 'integer' || type === 'real' ? Number(text) : decode(text);
  }
  skip();
  if (!/^<plist\b/.test(tokens[i++] || '')) throw new Error('Invalid plist root');
  return read();
}
export function muxPacket(value, tag = 1) {
  const body = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${plistXML(value)}</plist>`,
  );
  const header = Buffer.alloc(16);
  [body.length + 16, 1, 8, tag].forEach((v, i) => header.writeUInt32LE(v, i * 4));
  return Buffer.concat([header, body]);
}
async function request(message, { address = endpoint, signal, timeout = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    let buffer = Buffer.alloc(0),
      settled = false;
    const timer = setTimeout(() => fail(new Error('Apple USB 服务响应超时。')), timeout);
    const abort = () => fail(new Error('USB 请求已取消。'));
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.removeListener('data', receive);
      socket.removeListener('close', closed);
    }
    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    }
    function closed() {
      fail(new Error('Apple USB 服务已断开。'));
    }
    function receive(data) {
      buffer = Buffer.concat([buffer, data]);
      try {
        if (buffer.length < 16) return;
        const length = buffer.readUInt32LE(0);
        if (
          length < 16 ||
          length > MAX ||
          buffer.readUInt32LE(4) !== 1 ||
          buffer.readUInt32LE(8) !== 8 ||
          buffer.readUInt32LE(12) !== 1
        )
          throw new Error('Apple USB 协议响应无效。');
        if (buffer.length < length) return;
        const value = parsePlist(buffer.subarray(16, length).toString());
        socket.pause();
        cleanup();
        settled = true;
        if (buffer.length > length) socket.unshift(buffer.subarray(length));
        resolve({ socket, value });
      } catch (error) {
        fail(error);
      }
    }
    socket.on('error', fail);
    socket.on('close', closed);
    socket.on('data', receive);
    socket.on('connect', () =>
      socket.write(
        muxPacket({
          ClientVersionString: 'PocketLink 0.3',
          ProgName: 'PocketLink',
          kLibUSBMuxVersion: 3,
          ...message,
        }),
      ),
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export async function listUSBDevices(options) {
  const { socket, value } = await request({ MessageType: 'ListDevices' }, options);
  socket.destroy();
  if (!Array.isArray(value.DeviceList))
    throw new Error('Apple USB 服务不支持设备列表，请更新 Apple Devices。');
  return value.DeviceList.filter(
    (item) => item.Properties?.ConnectionType === 'USB' && Number.isInteger(item.DeviceID),
  );
}
export async function connectUSBDevice(device, port = 23456, options) {
  const { socket, value } = await request(
    {
      MessageType: 'Connect',
      DeviceID: device.DeviceID,
      PortNumber: ((port & 255) << 8) | (port >> 8),
    },
    options,
  );
  if (value.MessageType !== 'Result' || value.Number !== 0) {
    socket.destroy();
    throw new Error('请解锁 iPhone、信任电脑，并在新版 PocketLink App 选择 USB 有线后点击连接。');
  }
  socket.setNoDelay(true);
  return socket;
}
