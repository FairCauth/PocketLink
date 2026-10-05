import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createPocketServer } from '../server/index.mjs';
import QRCode from 'qrcode';

async function setup(t, env = {}) {
  const app = await createPocketServer({ port: 0, env });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base };
}
async function socket(app, t) {
  const ws = new WebSocket(app.base.replace('http', 'ws') + '/signal', { origin: app.base });
  const messages = [],
    waiters = [];
  ws.on('message', (data) => {
    const value = JSON.parse(data);
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else messages.push(value);
  });
  await once(ws, 'open');
  t.after(() => ws.terminate());
  return {
    ws,
    send: (value) => ws.send(JSON.stringify(value)),
    next: () =>
      messages.length
        ? Promise.resolve(messages.shift())
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('WebSocket response timed out')), 3000);
            waiters.push((value) => {
              clearTimeout(timer);
              resolve(value);
            });
          }),
  };
}

test('serves phone and desktop and protects non-public files', async (t) => {
  const app = await setup(t);
  for (const url of ['/', '/receiver', '/receiver.js', '/audio-engine.js'])
    assert.equal((await fetch(app.base + url)).status, 200);
  assert.equal((await fetch(app.base + '/.env')).status, 403);
  const config = await (await fetch(app.base + '/api/config')).json();
  assert.equal(config.protocol, 'pocketlink-v1');
  assert.equal(config.relayAvailable, false);
  assert.equal(
    (await fetch(app.base + '/api/config', { headers: { origin: 'https://untrusted.example' } }))
      .status,
    403,
  );
});

test('pairing QR encodes the selected phone address and code; plain URL remains manual', async (t) => {
  const app = await setup(t, { PUBLIC_ORIGIN: 'https://audio.example.com' });
  const options = { type: 'svg', margin: 4, errorCorrectionLevel: 'M' };
  assert.equal(
    await (await fetch(app.base + '/api/qr.svg?code=01234567')).text(),
    await QRCode.toString('https://audio.example.com/#pair=01234567', options),
  );
  assert.equal(
    await (await fetch(app.base + '/api/qr.svg')).text(),
    await QRCode.toString('https://audio.example.com', options),
  );
  for (const code of ['123', 'abcdefgh', '123456789', '12345678%26server=evil']) {
    assert.equal((await fetch(app.base + '/api/qr.svg?code=' + code)).status, 400);
  }
  assert.equal((await fetch(app.base + '/api/qr.svg?index=999&code=01234567')).status, 404);
});

test('pairs one phone, relays only within its room, recovers after disconnect', async (t) => {
  const app = await setup(t);
  const desktop = await socket(app, t);
  desktop.send({ type: 'create' });
  const created = await desktop.next();
  assert.match(created.code, /^\d{8}$/);
  const phone = await socket(app, t);
  phone.send({ type: 'join', code: created.code, mode: 'lan' });
  assert.equal((await desktop.next()).type, 'peer-joined');
  assert.equal((await phone.next()).type, 'joined');
  phone.send({ type: 'signal', description: { type: 'offer', sdp: 'test-offer' } });
  assert.equal((await desktop.next()).description.sdp, 'test-offer');
  desktop.send({ type: 'signal', description: { type: 'answer', sdp: 'test-answer' } });
  assert.equal((await phone.next()).description.sdp, 'test-answer');
  const other = await socket(app, t);
  other.send({ type: 'join', code: created.code, mode: 'lan' });
  assert.match((await other.next()).message, /其他设备/);
  phone.ws.close();
  assert.equal((await desktop.next()).type, 'peer-left');
  other.send({ type: 'join', code: created.code, mode: 'usb' });
  assert.equal((await other.next()).type, 'joined');
  assert.equal((await desktop.next()).mode, 'usb');
  desktop.ws.close();
  assert.equal((await other.next()).type, 'peer-left');
  assert.equal(app.rooms.size, 0);
});

test('rejects expired codes, unpaired signaling, malformed messages, and missing TURN', async (t) => {
  const app = await setup(t);
  const desktop = await socket(app, t);
  desktop.send({ type: 'create' });
  const created = await desktop.next();
  app.rooms.get(created.code).expiresAt = Date.now() - 1;
  const phone = await socket(app, t);
  phone.send({ type: 'join', code: created.code, mode: 'lan' });
  assert.match((await phone.next()).message, /过期/);
  phone.send({ type: 'signal', description: { type: 'offer', sdp: 'x' } });
  assert.match((await phone.next()).message, /配对/);
  phone.send(null);
  assert.equal((await phone.next()).type, 'error');
  phone.send({ type: 'join', code: created.code, mode: 'server' });
  assert.match((await phone.next()).message, /TURN/);
});

test('isolates rooms and blocks roles from sending wrong SDP type', async (t) => {
  const app = await setup(t);
  const a = await socket(app, t),
    b = await socket(app, t);
  a.send({ type: 'create' });
  b.send({ type: 'create' });
  const ca = await a.next(),
    cb = await b.next();
  assert.notEqual(ca.code, cb.code);
  const phone = await socket(app, t);
  phone.send({ type: 'join', code: ca.code, mode: 'lan' });
  await phone.next();
  await a.next();
  phone.send({ type: 'signal', description: { type: 'answer', sdp: 'bad-role' } });
  assert.equal((await phone.next()).type, 'error');
  assert.equal(app.rooms.get(cb.code).sender, null);
});

test('provides temporary TURN credentials and explicitly allowed frontend CORS', async (t) => {
  const app = await setup(t, {
    TURN_URL: 'turn:relay.example.com:3478',
    TURN_SECRET: 'test-only-secret',
    ALLOWED_ORIGINS: 'https://studio.example.com',
    PUBLIC_ORIGIN: 'https://audio.example.com',
  });
  const response = await fetch(app.base + '/api/config', {
    headers: { origin: 'https://studio.example.com' },
  });
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://studio.example.com');
  const config = await response.json();
  assert.equal(config.relayAvailable, true);
  assert.ok(config.iceServers[0].credential);
  assert.ok(!JSON.stringify(config).includes('test-only-secret'));
  assert.deepEqual(config.phoneURLs, ['https://audio.example.com']);
});
