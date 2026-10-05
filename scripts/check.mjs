import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function checkDirectory(relative) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      await checkDirectory(file);
    } else if (/\.(?:mjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], {
        cwd: root,
        stdio: 'inherit',
      });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}

for (const directory of ['client', 'server', 'scripts', 'tests', 'html/dist']) {
  await checkDirectory(directory);
}

// Static hosting must serve the same receiver as the Node server.
for (const [source, target] of [
  ['client/index.html', 'html/dist/receiver/index.html'],
  ['client/receiver.js', 'html/dist/receiver.js'],
]) {
  const contents = await Promise.all(
    [source, target].map((file) => readFile(path.join(root, file))),
  );
  if (!contents[0].equals(contents[1])) {
    throw new Error(`${target} is out of date. Run npm run build:static.`);
  }
}

console.log('JavaScript syntax and static receiver copies are valid.');
