import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createPocketServer } from '../server/index.mjs';
import { listUSBDevices, connectUSBDevice, parsePlist } from '../server/usbmux.mjs';
import { frameReader, frame } from '../server/usb-bridge.mjs';
import { fakeUSB } from './usb-fixture.mjs';

async function setup(t, options = {}) {
  const fake = await fakeUSB(options);
  const app = await createPocketServer({
    port: 0,
    env: {},
    phoneAddresses: [],
    usbBridge: { muxOptions: { address: fake.address }, retryMs: 20 },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    await fake.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { fake, app, base };
}
function messages(ws) {
  const values = [],
    waiting = [];
  ws.on('message', (data, binary) => {
    const value = binary ? data : JSON.parse(data);
    if (waiting.length) waiting.shift()(value);
    else values.push(value);
  });
  return () =>
    values.length
      ? Promise.resolve(values.shift())
      : new Promise((resolve) => waiting.push(resolve));
}
test('USB mux lists only wired devices and uses network byte order for device port', async (t) => {
  const { fake } = await setup(t, { fragment: true });
  const devices = await listUSBDevices({ address: fake.address });
  assert.equal(devices.length, 1);
  assert.equal(devices[0].DeviceID, 9);
  const socket = await connectUSBDevice(devices[0], 23456, { address: fake.address });
  socket.destroy();
  assert.equal(fake.connections[0].PortNumber, 41051);
  assert.throws(() => parsePlist('<plist><dict><key>x</key><bogus/></dict></plist>'));
});
test('USB frame reader handles fragments/coalescing and rejects oversized frames', () => {
  const got = [],
    read = frameReader((v) => got.push(v.toString()));
  const bytes = Buffer.concat([frame(Buffer.from('a')), frame(Buffer.from('bc'))]);
  for (const byte of bytes) read(Buffer.from([byte]));
  assert.deepEqual(got, ['a', 'bc']);
  assert.throws(() => read(Buffer.from([0, 1, 0, 1])));
});
test(
  'USB bridge transports audio/control without any phone network and closes on unplug',
  { timeout: 10000 },
  async (t) => {
    const { fake, base } = await setup(t);
    const ws = new WebSocket(base.replace('http', 'ws') + '/usb', { origin: base });
    t.after(() => ws.terminate());
    const next = messages(ws);
    await once(ws, 'open');
    const created = await next();
    assert.match(created.code, /^\d{8}$/);
    assert.equal((await next()).type, 'connected');
    assert.equal(fake.connections[0].DeviceID, 9);
    assert.equal(fake.commands[0].code, created.code);
    fake.audio();
    const pcm = await next();
    assert.equal(pcm[0], 2);
    assert.equal(pcm.readUInt32LE(1), 48000);
    fake.control({ type: 'set-voice', id: 'robot' });
    assert.equal((await next()).message.id, 'robot');
    ws.send(JSON.stringify({ type: 'control', message: { type: 'catalog', sounds: [] } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fake.commands.at(-1).message.type, 'catalog');
    fake.unplug();
    assert.match((await next()).message, /断开/);
  },
);
test(
  'USB endpoint rejects foreign or missing Origin and a second receiver',
  { timeout: 10000 },
  async (t) => {
    const { base } = await setup(t);
    for (const origin of [undefined, 'http://evil.example', 'http://localhost:1234']) {
      const ws = new WebSocket(base.replace('http', 'ws') + '/usb', origin ? { origin } : {});
      const error = await new Promise((resolve) => ws.once('error', resolve));
      assert.match(error.message, /403/);
    }
    const first = new WebSocket(base.replace('http', 'ws') + '/usb', { origin: base });
    t.after(() => first.terminate());
    await once(first, 'open');
    const second = new WebSocket(base.replace('http', 'ws') + '/usb', { origin: base });
    const error = await new Promise((resolve) => second.once('error', resolve));
    assert.match(error.message, /403/);
  },
);
test(
  'a rejecting app never becomes connected and browser cancellation stops discovery',
  { timeout: 10000 },
  async (t) => {
    const { fake, base } = await setup(t, { rejectPair: true });
    const ws = new WebSocket(base.replace('http', 'ws') + '/usb', { origin: base });
    const received = [];
    ws.on('message', (data) => received.push(JSON.parse(data)));
    await once(ws, 'open');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(!received.some((m) => m.type === 'connected'));
    ws.close();
    await once(ws, 'close');
    // A mux request sent before browser close may still reach the fake daemon.
    // Wait for those sockets to drain before asserting that no new retries start.
    const deadline = Date.now() + 1000;
    while (fake.activeConnections && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fake.activeConnections, 0);
    const count = fake.connections.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fake.connections.length, count);
  },
);
