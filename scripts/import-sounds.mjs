import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultDestination = fileURLToPath(new URL('../html/dist/sounds/', import.meta.url));
const extensions = new Set(['.mp3', '.wav', '.m4a']);
const hash = (data) => createHash('sha256').update(data).digest('hex');

export async function importSounds(source, destination = defaultDestination) {
  const files = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  if (!files.length) throw new Error('目录中没有 MP3、WAV 或 M4A 音效。');
  if (files.length > 50) throw new Error('每次最多导入 50 个音效。');
  const pending = [];
  for (const entry of files) {
    const bytes = await readFile(path.join(source, entry.name));
    if (!bytes.length || bytes.length > 10 * 1024 * 1024)
      throw new Error(`${entry.name}：文件不能为空或超过 10 MB。`);
    const filename = hash(bytes) + path.extname(entry.name).toLowerCase();
    pending.push({
      bytes,
      filename,
      sound: {
        id: hash(entry.name),
        name: path.parse(entry.name).name,
        url: `/sounds/${filename}`,
      },
    });
  }
  await mkdir(destination, { recursive: true });
  for (const { filename, bytes } of pending) {
    await writeFile(path.join(destination, filename), bytes);
  }
  const manifest = { sounds: pending.map(({ sound }) => sound) };
  const temporary = path.join(destination, `.index-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n');
  // Replace the list only after every file is ready. The source folder is never changed.
  await rename(temporary, path.join(destination, 'index.json'));
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (!process.argv[2]) throw new Error('用法：npm run import:sounds -- "音效目录"');
    const result = await importSounds(path.resolve(process.argv[2]));
    console.log(`已导入 ${result.sounds.length} 个音效。刷新手机页面并连接后即可使用。`);
    for (const sound of result.sounds) console.log(`  ${sound.name}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
