import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export const MAX_SOUND_BYTES = 10 * 1024 * 1024;

export async function addSound(directory, filename, bytes) {
  const extension = path.extname(filename).toLowerCase();
  const valid =
    extension === '.wav'
      ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
      : extension === '.m4a'
        ? bytes.toString('ascii', 4, 8) === 'ftyp'
        : extension === '.mp3' &&
          (bytes.toString('ascii', 0, 3) === 'ID3' ||
            (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
  if (!bytes.length || bytes.length > MAX_SOUND_BYTES || !valid)
    throw new Error('请添加有效的 MP3、WAV 或 M4A 文件，单个不超过 10 MB。');
  const name =
    Array.from(
      path
        .basename(filename.replaceAll('\\', '/'), extension)
        .replace(/[\u0000-\u001f]/g, '')
        .trim(),
    )
      .slice(0, 80)
      .join('') || '音效';
  const hash = createHash('sha256').update(bytes).digest('hex');
  let catalog = { sounds: [] };
  try {
    catalog = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('音效目录无法读取，原列表未修改。');
  }
  if (!Array.isArray(catalog.sounds)) throw new Error('音效目录格式错误。');
  const url = `/sounds/${hash}${extension}`;
  const existing = catalog.sounds.find((sound) => sound.url === url);
  if (existing) return existing;
  if (catalog.sounds.length >= 50) throw new Error('最多保存 50 个音效，请先整理音效目录。');
  const sound = { id: randomUUID(), name, url };
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${hash}${extension}`), bytes);
  const temporary = path.join(directory, `.index-${randomUUID()}.json`);
  try {
    await writeFile(
      temporary,
      JSON.stringify({ sounds: [...catalog.sounds, sound] }, null, 2) + '\n',
    );
    await rename(temporary, path.join(directory, 'index.json'));
  } finally {
    await rm(temporary, { force: true });
  }
  return sound;
}
