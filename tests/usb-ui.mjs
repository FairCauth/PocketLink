import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPocketServer } from '../server/index.mjs';
import { fakeUSB } from './usb-fixture.mjs';
import { mkdir } from 'node:fs/promises';

// Real browser PCM/audio graph; simulated Apple service/iOS hardware.
const fake = await fakeUSB();
const app = await createPocketServer({
  port: 0,
  env: { TLS_CERT: process.env.TEST_TLS_CERT, TLS_KEY: process.env.TEST_TLS_KEY },
  phoneAddresses: [],
  usbBridge: { muxOptions: { address: fake.address }, retryMs: 30 },
});
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
let browser, audioTimer;
try {
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const receiver = await browser.newPage();
  const errors = [];
  receiver.on('pageerror', (error) => errors.push(error.message));
  // Any accidental WebRTC fallback fails immediately, even if Wi-Fi is available.
  await receiver.addInitScript(() => {
    window.RTCPeerConnection = class {
      constructor() {
        throw new Error('USB must not use WebRTC');
      }
    };
  });
  const base = `${process.env.TEST_TLS_CERT ? 'https' : 'http'}://127.0.0.1:${app.server.address().port}`;
  await receiver.goto(`${base}/receiver`);
  await receiver.locator('#open-phone').click();
  await receiver.locator('#connect-usb').click();
  assert.match(await receiver.locator('#usb-hint').textContent(), /无需热点/);
  if (!(await receiver.locator('#phone-dialog').isVisible()))
    await receiver.locator('#open-phone').click();
  await receiver.locator('#create-code').click();
  await receiver
    .locator('#input-device option[value=phone]')
    .waitFor({ state: 'attached', timeout: 15000 });
  assert.equal(
    await receiver.locator('#input-device option[value=phone]').textContent(),
    '手机（USB 有线）',
  );
  fake.control({ type: 'set-input', id: 'phone', enabled: true, requestId: 'usb-phone' });
  await receiver.waitForFunction(
    () => document.getElementById('input-toggle').getAttribute('aria-pressed') === 'true',
  );
  assert.equal(await receiver.locator('#input-device').inputValue(), 'phone');
  assert.equal(await receiver.locator('#phone-entry').isVisible(), false);
  assert.equal(fake.connections[0].DeviceID, 9);
  audioTimer = setInterval(() => fake.audio(), 10);
  await receiver.waitForFunction(
    () => parseFloat(document.getElementById('receiver-level-bar').style.width) > 10,
  );
  await receiver.waitForFunction(() => !document.getElementById('receiver-voice').disabled);
  fake.control({ type: 'set-voice', id: 'robot' });
  await receiver.waitForFunction(() => document.getElementById('receiver-voice').value === 'robot');
  assert.ok(
    fake.commands.some(
      (message) => message.type === 'control' && message.message.type === 'catalog',
    ),
  );
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await receiver.screenshot({ path: 'artifacts/receiver-usb.png', fullPage: true });
  for (const width of [320, 390, 1440]) {
    await receiver.setViewportSize({ width, height: 900 });
    assert.equal(
      await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  clearInterval(audioTimer);
  fake.unplug();
  await receiver.waitForFunction(() => !document.getElementById('pair-section').hidden);
  await receiver.waitForFunction(() =>
    document.getElementById('receiver-status').textContent.includes('断开'),
  );
  assert.equal(await receiver.locator('#input-toggle').isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log(
    'PASS native USB PCM playout, voice control, no WebRTC/no phone network, unplug cleanup and responsive UI (simulated hardware)',
  );
} finally {
  clearInterval(audioTimer);
  await browser?.close();
  await app.close();
  await fake.close();
}
