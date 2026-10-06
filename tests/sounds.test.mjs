import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { importSounds } from '../scripts/import-sounds.mjs';

test('sound import preserves names, safely addresses files and atomically replaces the list', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pocketlink-sounds-'));
  try {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'public');
    await mkdir(source);
    await writeFile(path.join(source, '冰冰 & #1.MP3'), 'sample-one');
    await writeFile(path.join(source, 'lets go.wav'), 'sample-two');
    await writeFile(path.join(source, 'private.txt'), 'not audio');
    const first = await importSounds(source, destination);
    assert.equal(first.sounds.length, 2);
    const sound = first.sounds.find((entry) => entry.name === '冰冰 & #1');
    assert.match(sound.url, /^\/sounds\/[a-f0-9]{64}\.mp3$/);
    assert.equal(
      await readFile(path.join(destination, path.basename(sound.url)), 'utf8'),
      'sample-one',
    );
    assert.equal(await readFile(path.join(source, '冰冰 & #1.MP3'), 'utf8'), 'sample-one');
    await writeFile(path.join(source, '冰冰 & #1.MP3'), 'updated');
    const second = await importSounds(source, destination);
    const updated = second.sounds.find((entry) => entry.id === sound.id);
    assert.notEqual(updated.url, sound.url);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(destination, 'index.json'), 'utf8')),
      second,
    );
    await writeFile(path.join(source, 'empty.mp3'), '');
    await assert.rejects(importSounds(source, destination), /不能为空/);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(destination, 'index.json'), 'utf8')),
      second,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
