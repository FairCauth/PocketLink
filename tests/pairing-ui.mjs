// Real browser capture/RTC using Chrome's synthetic microphone, with normal autoplay policy.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createPocketServer } from '../server/index.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const app = await createPocketServer({
  port: 0,
  env: {},
  phoneAddresses: ['127.0.0.1', 'localhost'],
});
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser;
try {
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  const wave = Buffer.alloc(44 + 48000 * 2);
  wave.write('RIFF');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(48000, 24);
  wave.writeUInt32LE(96000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(wave.length - 44, 40);
  for (let i = 0; i < 48000; i++)
    wave.writeInt16LE(Math.round(4000 * Math.sin((2 * Math.PI * 440 * i) / 48000)), 44 + i * 2);
  const wavePath = fileURLToPath(new URL('../artifacts/pairing-test-tone.wav', import.meta.url));
  await writeFile(wavePath, wave);
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavePath}`,
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--mute-audio',
    ],
  });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    // This suite verifies transmission of a 440 Hz tone, not speech denoising.
    try {
      localStorage.setItem(
        'pocketlink-audio-settings',
        JSON.stringify({ noiseSuppression: false, echoCancellation: true }),
      );
    } catch {
      /* about:blank has no storage. */
    }
  });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const receiver = await context.newPage();
  await receiver.goto(base + '/receiver');
  if (!(await receiver.locator('#phone-dialog').isVisible()))
    await receiver.locator('#open-phone').click();
  await receiver.locator('#create-code').click();
  const waitCode = async () => {
    await receiver.waitForFunction(
      () =>
        /^\d{4} \d{4}$/.test(document.getElementById('receiver-code').textContent) &&
        document.getElementById('phone-qr').naturalWidth > 0,
    );
    return (await receiver.locator('#receiver-code').textContent()).replace(/\D/g, '');
  };
  let code = await waitCode();
  const verifyQR = async (host = '127.0.0.1') => {
    const url = `http://${host}:${app.server.address().port}/#pair=${code}`;
    const src = await receiver.locator('#phone-qr').getAttribute('src');
    assert.equal(new URL(src).searchParams.get('code'), code);
    const response = await context.request.get(src);
    assert.equal(
      await response.text(),
      await QRCode.toString(url, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' }),
    );
    assert.equal(new URL(await receiver.locator('#phone-url').getAttribute('href')).hash, '');
    return url;
  };
  const firstQR = await verifyQR();
  if (await receiver.locator('#phone-dialog').isVisible())
    await receiver.locator('#close-phone').click();
  await receiver.locator('#open-settings').click();
  await receiver.locator('#advanced-settings > summary').click();
  await receiver.locator('#phone-network').selectOption('1');
  await verifyQR('localhost');
  await receiver.locator('#phone-network').selectOption('0');
  await receiver.locator('#close-settings').click();
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await receiver.screenshot({ path: 'artifacts/receiver-connection-methods.png', fullPage: true });

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.addInitScript(() => {
    window.captureCount = 0;
    window.captureTracks = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (options) => {
      window.captureCount++;
      if (sessionStorage.denyCapture === 'true')
        throw new DOMException('Test denial', 'NotAllowedError');
      const stream = await capture({
        ...options,
        audio: { ...options.audio, noiseSuppression: false, echoCancellation: false },
      });
      captureTracks.push(...stream.getTracks());
      return stream;
    };
    if (sessionStorage.suspendAudio === 'true') {
      const NativeContext = window.AudioContext;
      window.AudioContext = class extends NativeContext {
        resume() {
          return window.allowAudioResume ? super.resume() : new Promise(() => {});
        }
      };
    }
  });
  const connected = async () => {
    await phone.locator('#mic-view').waitFor({ state: 'visible', timeout: 15000 });
    await receiver.locator('#input-device option[value=phone]').waitFor({ state: 'attached' });
    await receiver.locator('#input-device').selectOption('phone');
    await receiver.locator('#input-toggle').click();
  };
  const released = () =>
    phone.waitForFunction(() => captureTracks.every((track) => track.readyState === 'ended'));
  const disconnect = async () => {
    await phone.locator('#disconnect').click();
    await released();
    await receiver.waitForFunction(() =>
      document.getElementById('receiver-status').textContent.includes('等待手机'),
    );
  };
  // Open the exact QR payload without clicking anything on the phone page.
  await phone.goto(firstQR);
  await connected();
  assert.equal(await phone.evaluate(() => captureCount), 0);
  await phone.locator('#phone-microphone').click();
  await phone.locator('#microphone-controls').waitFor({ state: 'visible' });
  assert.equal(await phone.evaluate(() => captureCount), 1);
  assert.equal(new URL(phone.url()).hash, '');
  await receiver.waitForFunction(
    () => parseFloat(document.getElementById('receiver-level-bar').style.width) > 5,
  );
  await disconnect();
  await phone.reload();
  assert.equal(await phone.evaluate(() => captureCount), 0);
  assert.equal(await phone.locator('#pair-code').inputValue(), '');
  assert.equal(await phone.locator('#pair-view').isVisible(), true);
  console.log(
    'PASS exact QR opens, pairs without capture; microphone starts only after a tap; refresh returns to manual entry',
  );

  if (!(await receiver.locator('#phone-dialog').isVisible()))
    await receiver.locator('#open-phone').click();
  await receiver.locator('#create-code').click();
  await receiver.waitForFunction((old) => {
    const value = document.getElementById('receiver-code').textContent.replace(/\D/g, '');
    return value.length === 8 && value !== old;
  }, code);
  code = await waitCode();
  const currentQR = await verifyQR();
  await phone.goto(firstQR);
  await phone.waitForFunction(
    () =>
      document.getElementById('pair-status').textContent.includes('过期') &&
      !document.getElementById('connect-button').disabled,
  );
  await released();
  assert.equal(await phone.locator('#pair-code').isVisible(), true);
  const previousCaptures = await phone.evaluate(() => captureCount);
  await phone.goto(base + '/#pair=broken');
  await phone.waitForFunction(() =>
    document.getElementById('pair-status').textContent.includes('二维码无效'),
  );
  assert.equal(await phone.evaluate(() => captureCount), previousCaptures);
  assert.match(await phone.locator('#pair-status').textContent(), /二维码无效/);
  console.log('PASS refreshed codes invalidate old QR; malformed QR never captures');

  await phone.evaluate(() => (sessionStorage.denyCapture = 'true'));
  await phone.reload();
  await phone.goto(currentQR);
  await connected();
  assert.equal(await phone.evaluate(() => captureCount), 0);
  await phone.locator('#phone-microphone').click();
  await phone.waitForFunction(() =>
    document.getElementById('mic-message').textContent.includes('权限被拒绝'),
  );
  assert.equal(await phone.locator('#mic-view').isVisible(), true);
  await phone.evaluate(() => sessionStorage.removeItem('denyCapture'));
  await phone.locator('#phone-microphone').click();
  await phone.locator('#microphone-controls').waitFor({ state: 'visible' });
  await disconnect();
  await phone.evaluate(() => (sessionStorage.suspendAudio = 'true'));
  await phone.reload();
  await phone.goto(currentQR);
  await connected();
  assert.equal(await phone.evaluate(() => captureCount), 0);
  await phone.evaluate(() => (window.allowAudioResume = true));
  await phone.locator('#phone-microphone').click();
  await phone.locator('#microphone-controls').waitFor({ state: 'visible' });
  await disconnect();
  if (!(await receiver.locator('#phone-dialog').isVisible()))
    await receiver.locator('#open-phone').click();
  await receiver.locator('#disconnect').click();
  assert.equal(await receiver.locator('#phone-entry').isVisible(), false);
  assert.equal(await receiver.locator('#phone-qr').getAttribute('src'), null);
  console.log(
    'PASS permission denial and suspended audio keep sound-only pairing available; cancel removes QR',
  );
  assert.deepEqual(errors, []);
  console.log('ALL PASS (Chromium synthetic microphone, normal autoplay policy)');
} finally {
  await browser?.close();
  await app.close();
}
