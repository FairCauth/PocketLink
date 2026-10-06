import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
const vendor = new URL('../html/dist/vendor/rnnoise/', import.meta.url);
const dependency = new URL('../node_modules/@sapphi-red/web-noise-suppressor/', import.meta.url);
await mkdir(vendor, { recursive: true });
for (const [source, target] of [
  ['dist/rnnoise.wasm', 'rnnoise.wasm'],
  ['LICENSE', 'web-noise-suppressor-LICENSE'],
])
  await copyFile(new URL(source, dependency), new URL(target, vendor));
// Pinned 0.4.1 needs a readiness/error handshake and a started MessagePort.
// Keep audio on the bypass until WASM is ready, including on slow iPhones.
let worklet = await readFile(new URL('dist/rnnoise/workletProcessor.js', dependency), 'utf8');
for (const [before, after] of [
  ['super(),this.destroyed=!1', 'super(),this.port.start(),this.destroyed=!1'],
  [
    'this.destroyed&&this.destroy()})()',
    'this.destroyed?this.destroy():this.port.postMessage("ready")})().catch(()=>this.port.postMessage("error"))',
  ],
]) {
  if (!worklet.includes(before))
    throw new Error('RNNoise adapter needs review after dependency update.');
  worklet = worklet.replace(before, after);
}
worklet =
  '// PocketLink adaptation: readiness, error reporting and destroy messages. See THIRD-PARTY.md.\n' +
  worklet.replace(/\/\/# sourceMappingURL=.*$/m, '');
await writeFile(new URL('worklet.js', vendor), worklet);
await mkdir(new URL('../html/dist/receiver/', import.meta.url), { recursive: true });
await copyFile(
  new URL('../client/index.html', import.meta.url),
  new URL('../html/dist/receiver/index.html', import.meta.url),
);
await copyFile(
  new URL('../client/receiver.js', import.meta.url),
  new URL('../html/dist/receiver.js', import.meta.url),
);
console.log('Static receiver copied. Real-time connections require the PocketLink Node service.');
