import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export async function dependencyState(root) {
  const manifest = await readFile(path.join(root, 'package.json'));
  const lockfile = await readFile(path.join(root, 'package-lock.json'));
  const pkg = JSON.parse(manifest);
  const lock = JSON.parse(lockfile);
  const fingerprint = createHash('sha256')
    .update(manifest)
    .update(lockfile)
    .update(`${process.platform}:${process.arch}:${process.versions.node.split('.')[0]}`)
    .digest('hex');
  let valid = true;
  // Verify transitive runtime packages too: a top-level package can remain present
  // while its dependency directory was removed or an install was interrupted.
  for (const [relative, entry] of Object.entries(lock.packages || {})) {
    if (!relative.startsWith('node_modules/') || entry.dev || entry.optional) continue;
    try {
      const installed = JSON.parse(
        await readFile(path.join(root, relative, 'package.json'), 'utf8'),
      );
      if (installed.version !== entry.version) valid = false;
    } catch {
      valid = false;
    }
  }
  for (const name of Object.keys(pkg.dependencies || {})) {
    try {
      const installed = JSON.parse(
        await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
      );
      if (installed.version !== lock.packages?.[`node_modules/${name}`]?.version) valid = false;
    } catch {
      valid = false;
    }
  }
  let saved;
  try {
    saved = JSON.parse(await readFile(path.join(root, '.runtime/dependencies.json'), 'utf8'));
  } catch {}
  return { fingerprint, valid, ready: valid && saved?.fingerprint === fingerprint };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const state = await dependencyState(root);
  if (process.argv.includes('--record')) {
    if (!state.valid)
      throw new Error('Installed runtime dependencies do not match package-lock.json.');
    await mkdir(path.join(root, '.runtime'), { recursive: true });
    await writeFile(
      path.join(root, '.runtime/dependencies.json'),
      JSON.stringify({ fingerprint: state.fingerprint }),
    );
  } else {
    process.exitCode = state.ready ? 0 : 2;
  }
}
