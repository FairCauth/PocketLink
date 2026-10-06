import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomInt, createHmac } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.wasm': 'application/wasm',
};
const ROOM_TTL = 10 * 60 * 1000;
const localAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((x) => x.family === 'IPv4' && !x.internal)
    .map((x) => x.address);

export async function createPocketServer(options = {}) {
  const env = options.env || process.env;
  const port = options.port ?? Number(env.PORT || 8787);
  if (Boolean(env.TLS_CERT) !== Boolean(env.TLS_KEY))
    throw new Error('TLS_CERT and TLS_KEY must be configured together.');
  const tls = env.TLS_CERT
    ? { cert: await readFile(env.TLS_CERT), key: await readFile(env.TLS_KEY) }
    : null;
  const protocol = tls ? 'https' : 'http';
  const allowedOrigins = new Set(
    (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
  const publicOrigin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : null;
  if (publicOrigin) allowedOrigins.add(publicOrigin);
  const configuredIce = env.ICE_SERVERS_JSON ? JSON.parse(env.ICE_SERVERS_JSON) : [];
  if (!Array.isArray(configuredIce)) throw new Error('ICE_SERVERS_JSON must be an array.');
  function iceServers() {
    if (env.TURN_URL && env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 3600}:pocketlink`;
      return [
        {
          urls: env.TURN_URL.split(','),
          username,
          credential: createHmac('sha1', env.TURN_SECRET).update(username).digest('base64'),
        },
      ];
    }
    return configuredIce;
  }
  const relayAvailable = iceServers().some((s) =>
    [s.urls].flat().some((u) => typeof u === 'string' && /^turns?:/.test(u)),
  );
  const knownHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...localAddresses()]);
  if (publicOrigin) knownHosts.add(new URL(publicOrigin).hostname);
  const phoneAddresses = options.phoneAddresses || localAddresses();
  function clientConfig() {
    const actualPort = server.address()?.port || port;
    return {
      protocol: 'pocketlink-v1',
      iceServers: iceServers(),
      relayAvailable,
      secure: Boolean(tls || publicOrigin?.startsWith('https:')),
      phoneURLs: publicOrigin
        ? [publicOrigin]
        : phoneAddresses.map((ip) => `${protocol}://${ip}:${actualPort}`),
      setupURLs:
        options.setup && !publicOrigin
          ? phoneAddresses.map((ip) => `http://${ip}:${options.setup.port}/setup`)
          : [],
      certificate: options.setup?.certificate,
    };
  }
  function isAllowed(req) {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) return true;
    try {
      const host = new URL(`${protocol}://${req.headers.host}`);
      return knownHosts.has(host.hostname) && (!origin || origin === host.origin);
    } catch {
      return false;
    }
  }
  const handler = async (req, res) => {
    const origin = req.headers.origin;
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Permissions-Policy': 'microphone=(self), camera=()',
    };
    if (origin && isAllowed(req)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD, OPTIONS' }).end();
      return;
    }
    if (!isAllowed(req)) {
      res.writeHead(403, headers).end('Origin or host is not allowed');
      return;
    }
    if (req.method === 'OPTIONS') {
      res
        .writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' })
        .end();
      return;
    }
    try {
      const url = new URL(req.url, `${protocol}://localhost`);
      if (url.pathname === '/api/config') {
        const config = clientConfig();
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(config));
        return;
      }
      if (url.pathname === '/api/qr.svg') {
        const config = clientConfig(),
          index = Number(url.searchParams.get('index') || 0);
        const isSetup = url.searchParams.get('kind') === 'setup';
        let target = (isSetup ? config.setupURLs : config.phoneURLs)[index];
        if (!Number.isInteger(index) || !target) {
          res.writeHead(404, headers).end();
          return;
        }
        const code = url.searchParams.get('code');
        if (!isSetup && code !== null) {
          if (!/^\d{8}$/.test(code)) {
            res.writeHead(400, headers).end('Invalid pairing code');
            return;
          }
          const pairingURL = new URL(target);
          pairingURL.hash = new URLSearchParams({ pair: code }).toString();
          target = pairingURL.href;
        }
        const svg = await QRCode.toString(target, {
          type: 'svg',
          margin: 4,
          errorCorrectionLevel: 'M',
        });
        res
          .writeHead(200, { ...headers, 'Content-Type': 'image/svg+xml' })
          .end(req.method === 'HEAD' ? undefined : svg);
        return;
      }
      if (url.pathname === '/health') {
        res
          .writeHead(200, { ...headers, 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok: true }));
        return;
      }
      let base = path.join(root, 'html/dist');
      let relative =
        url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      if (['/receiver', '/receiver/', '/receiver/index.html'].includes(url.pathname)) {
        base = path.join(root, 'client');
        relative = 'index.html';
      }
      if (url.pathname === '/receiver.js') {
        base = path.join(root, 'client');
        relative = 'receiver.js';
      }
      if (
        env.ENABLE_BROWSER_TESTS === '1' &&
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
        url.pathname.startsWith('/__tests__/')
      ) {
        base = path.join(root, 'tests');
        relative = url.pathname.slice('/__tests__/'.length);
      }
      const file = path.resolve(base, relative);
      if (
        !file.startsWith(base + path.sep) ||
        relative.split(/[\\/]/).some((part) => part.startsWith('.'))
      ) {
        res.writeHead(403, headers).end();
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, {
        ...headers,
        'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, headers).end('Not found');
    }
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const rooms = new Map();
  const addresses = new Map();
  const joinAttempts = new Map();
  const send = (ws, data) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };
  const error = (ws, message) => send(ws, { type: 'error', message });
  function leave(ws) {
    const room = rooms.get(ws.room);
    ws.room = null;
    if (!room) return;
    if (room.receiver === ws) {
      rooms.delete(room.code);
      if (room.sender) {
        room.sender.room = null;
        send(room.sender, { type: 'peer-left' });
      }
    } else if (room.sender === ws) {
      room.sender = null;
      room.expiresAt = Date.now() + ROOM_TTL;
      send(room.receiver, { type: 'peer-left', code: room.code, expiresAt: room.expiresAt });
    }
  }
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/signal' || !isAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = req.socket.remoteAddress;
    if ((addresses.get(ip) || 0) >= 20) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    addresses.set(ip, (addresses.get(ip) || 0) + 1);
    ws.alive = true;
    ws.rate = { since: Date.now(), count: 0 };
    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => {
      if (Date.now() - ws.rate.since > 10000) ws.rate = { since: Date.now(), count: 0 };
      if (++ws.rate.count > 120 || isBinary) {
        ws.close(1008, 'Rate limit or invalid message');
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        error(ws, '无法识别配对消息');
        return;
      }
      if (!message || typeof message !== 'object') {
        error(ws, '无效消息');
        return;
      }
      if (message.type === 'create') {
        if (ws.room) {
          error(ws, '该连接已有配对会话');
          return;
        }
        if (rooms.size >= 1000) {
          error(ws, '服务器繁忙，请稍后重试');
          return;
        }
        let code;
        do {
          code = String(randomInt(0, 100000000)).padStart(8, '0');
        } while (rooms.has(code));
        const room = { code, receiver: ws, sender: null, expiresAt: Date.now() + ROOM_TTL };
        rooms.set(code, room);
        ws.room = code;
        ws.role = 'receiver';
        send(ws, { type: 'created', code, expiresAt: room.expiresAt });
        return;
      }
      if (message.type === 'join') {
        if (ws.room) {
          error(ws, '该连接已有配对会话');
          return;
        }
        let attempt = joinAttempts.get(ip);
        if (!attempt || Date.now() - attempt.since > 60000)
          joinAttempts.set(ip, (attempt = { since: Date.now(), count: 0 }));
        if (++attempt.count > 10) {
          error(ws, '配对尝试过于频繁，请一分钟后重试');
          return;
        }
        if (
          typeof message.code !== 'string' ||
          !/^\d{8}$/.test(message.code) ||
          !['lan', 'usb', 'server'].includes(message.mode)
        ) {
          error(ws, '配对码或传输方式无效');
          return;
        }
        if (message.mode === 'server' && !relayAvailable) {
          error(ws, '服务器尚未配置 TURN 音频中继');
          return;
        }
        const room = rooms.get(message.code);
        if (!room || (!room.sender && room.expiresAt < Date.now())) {
          error(ws, '配对码无效或已过期，请在电脑重新创建');
          return;
        }
        if (room.sender) {
          error(ws, '此电脑已连接其他设备');
          return;
        }
        room.sender = ws;
        ws.room = room.code;
        ws.role = 'sender';
        send(room.receiver, { type: 'peer-joined', mode: message.mode });
        send(ws, { type: 'joined' });
        return;
      }
      if (message.type === 'signal') {
        const room = rooms.get(ws.room);
        if (!room) {
          error(ws, '请先完成配对');
          return;
        }
        const target = ws.role === 'sender' ? room.receiver : room.sender;
        if (!target) {
          error(ws, '另一端尚未连接');
          return;
        }
        const description = message.description;
        const candidate = message.candidate;
        if (description) {
          const expected = ws.role === 'sender' ? 'offer' : 'answer';
          if (
            description.type !== expected ||
            typeof description.sdp !== 'string' ||
            description.sdp.length > 60000
          ) {
            error(ws, '音频协商数据无效');
            return;
          }
          send(target, {
            type: 'signal',
            description: { type: description.type, sdp: description.sdp },
          });
        }
        if (candidate) {
          if (typeof candidate.candidate !== 'string' || candidate.candidate.length > 4096) {
            error(ws, '网络候选数据无效');
            return;
          }
          send(target, { type: 'signal', candidate });
        }
        return;
      }
      error(ws, '未知消息类型');
    });
    ws.on('close', () => {
      leave(ws);
      const count = (addresses.get(ip) || 1) - 1;
      if (count) addresses.set(ip, count);
      else addresses.delete(ip);
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
    for (const room of rooms.values()) {
      if (!room.sender && room.expiresAt < Date.now()) {
        error(room.receiver, '配对码已过期，请重新创建');
        room.receiver.close(1000, 'Pairing expired');
        rooms.delete(room.code);
      }
    }
    for (const [ip, attempt] of joinAttempts) {
      if (Date.now() - attempt.since > 60000) joinAttempts.delete(ip);
    }
  }, 15000);
  heartbeat.unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });
  return {
    server,
    rooms,
    wss,
    port,
    protocol,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = await createPocketServer();
  app.server.listen(app.port, process.env.HOST || '0.0.0.0', () => {
    console.log(`PocketLink: ${app.protocol}://localhost:${app.port}`);
    console.log(`Receiver: ${app.protocol}://localhost:${app.port}/receiver`);
    for (const ip of localAddresses()) console.log(`Phone: ${app.protocol}://${ip}:${app.port}`);
    if (app.protocol === 'http')
      console.log('iPhone requires trusted HTTPS. See README.md for TLS setup.');
  });
  process.on('SIGINT', async () => {
    await app.close();
    process.exit(0);
  });
}
