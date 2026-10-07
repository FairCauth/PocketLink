import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPocketServer } from '../server/index.mjs';

test('runtime sounds require local token, append safely, deduplicate and reject invalid files', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pocketlink-upload-'));
  const app = await createPocketServer({ port: 0, env: {}, soundDirectory: directory });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { soundUploadToken } = await (await fetch(base + '/api/config')).json();
  assert.equal(typeof soundUploadToken, 'string');
  const proxied = await (
    await fetch(base + '/api/config', { headers: { 'x-forwarded-for': '192.168.1.9' } })
  ).json();
  assert.equal(proxied.soundUploadToken, undefined);
  const body = Buffer.alloc(48);
  body.write('RIFF');
  body.write('WAVE', 8);
  const post = (name, bytes = body, headers = {}) =>
    fetch(base + '/api/sounds?name=' + encodeURIComponent(name), {
      method: 'POST',
      body: bytes,
      headers: { 'X-PocketLink-Upload': soundUploadToken, ...headers },
    });
  assert.equal((await post('a.wav', body, { 'X-PocketLink-Upload': 'bad' })).status, 403);
  assert.equal((await post('a.wav', body, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post('a.wav', body, { 'x-forwarded-for': '192.168.1.9' })).status, 403);
  for (const name of ['a.html', 'a.js', 'a.mp3']) assert.equal((await post(name)).status, 400);
  assert.equal((await post('empty.wav', Buffer.alloc(0))).status, 400);
  assert.equal((await post('huge.wav', Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
  const first = await post('../../笑声.wav');
  assert.equal(first.status, 201);
  const { sound } = await first.json();
  assert.equal(sound.name, '笑声');
  assert.match(sound.url, /^\/sounds\/[a-f0-9]{64}\.wav$/);
  assert.deepEqual(Buffer.from(await (await fetch(base + sound.url)).arrayBuffer()), body);
  assert.equal((await (await post('duplicate.wav')).json()).sound.id, sound.id);
  body[47] = 1;
  assert.equal((await post('第二个.wav')).status, 201);
  const catalog = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8'));
  assert.deepEqual(
    catalog.sounds.map((item) => item.name),
    ['笑声', '第二个'],
  );
});
