import { mkdir, copyFile } from 'node:fs/promises';
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
