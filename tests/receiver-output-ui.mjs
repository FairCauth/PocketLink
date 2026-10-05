// Test browser routing and permission handling without installing a system driver.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createPocketServer } from '../server/index.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const app = await createPocketServer({ port: 0, env: {} });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.routing = {
      permission: false,
      captures: 0,
      stops: 0,
      installed: true,
      denied: false,
      failSink: false,
      sink: '',
      renamed: false,
    };
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'audiooutput', deviceId: 'default', label: 'System default' },
      {
        kind: 'audioinput',
        deviceId: 'mic',
        label: routing.permission ? 'Computer microphone' : '',
      },
      ...(routing.permission
        ? [
            { kind: 'audiooutput', deviceId: 'speaker', label: 'Speakers' },
            // CABLE Output is an input and must never be chosen as a playback sink.
            {
              kind: 'audioinput',
              deviceId: 'cable-recording',
              label: routing.renamed
                ? 'PocketLink 麦克风 (VB-Audio Virtual Cable)'
                : 'CABLE Output (VB-Audio Virtual Cable)',
            },
            ...(routing.installed
              ? [
                  {
                    kind: 'audiooutput',
                    deviceId: 'cable-playback',
                    label: 'CABLE Input (VB-Audio Virtual Cable)',
                  },
                ]
              : []),
          ]
        : []),
    ];
    navigator.mediaDevices.getUserMedia = async () => {
      routing.captures++;
      if (routing.denied) throw new DOMException('Denied', 'NotAllowedError');
      routing.permission = true;
      return { getTracks: () => [{ stop: () => routing.stops++ }] };
    };
    Object.defineProperty(HTMLMediaElement.prototype, 'sinkId', { get: () => routing.sink });
    HTMLMediaElement.prototype.setSinkId = async (id) => {
      if (routing.failSink) throw new DOMException('Cannot route', 'NotAllowedError');
      routing.sink = id;
    };
  });
  const open = async () => {
    await page.goto(base + '/receiver');
    await page.locator('#open-settings').click();
    assert.equal(await page.evaluate(() => routing.captures), 0);
  };
  const route = async () => {
    await page.locator('#use-virtual-mic').click();
    await page.waitForFunction(() => !document.getElementById('use-virtual-mic').disabled);
  };
  const message = () => page.locator('#settings-status').textContent();
  await open();
  await route();
  assert.match(await message(), /已启用系统麦克风/);
  assert.equal(
    await page.locator('#output-device').isVisible(),
    false,
    'Technical routing stays collapsed',
  );
  assert.match(await page.locator('#mic-device-hint').textContent(), /CABLE Output/);
  assert.equal(await page.locator('#output-device').inputValue(), 'cable-playback');
  assert.deepEqual(await page.evaluate(() => [routing.sink, routing.captures, routing.stops]), [
    'cable-playback',
    1,
    1,
  ]);
  await route();
  assert.equal(
    await page.evaluate(() => routing.captures),
    1,
    'No further capture when devices are visible',
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('pocketlink.virtualMic')), 'true');
  // A browser restart/reload loses sinkId. Restore the named cable (even if its ID
  // changed) before creating a room; otherwise the phone would play to speakers.
  await open();
  await page.evaluate(() => {
    routing.permission = true;
  });
  await page.locator('#close-settings').click();
  await page.locator('#create-code').click();
  await page.waitForFunction(() =>
    /^\d{4} \d{4}$/.test(document.getElementById('receiver-code').textContent),
  );
  assert.equal(await page.evaluate(() => routing.sink), 'cable-playback');
  assert.equal(
    await page.evaluate(() => routing.captures),
    0,
    'Restore must not open computer microphone',
  );
  assert.equal(await page.locator('#output-route').textContent(), '系统麦克风');
  await open();
  await page.evaluate(() => {
    routing.permission = true;
    routing.installed = false;
  });
  await page.locator('#close-settings').click();
  await page.locator('#create-code').click();
  await page.waitForFunction(() =>
    document.getElementById('receiver-status').textContent.includes('恢复输出设备'),
  );
  assert.equal(
    await page.locator('#receiver-code').textContent(),
    '—— ——',
    'No room/audio when remembered output is missing',
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem('pocketlink.virtualMic')),
    'true',
    'Keep preference for retry',
  );
  await page.evaluate(() => {
    routing.installed = true;
  });
  await page.locator('#open-settings').click();
  await route();
  await page.locator('#use-speakers').click();
  await page.waitForFunction(() => routing.sink === '');
  assert.equal(await page.evaluate(() => localStorage.getItem('pocketlink.virtualMic')), null);
  assert.equal(await page.locator('#use-speakers').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#output-route').textContent(), '电脑试听');
  await page.locator('#advanced-settings > summary').click();
  await page.locator('#output-device').selectOption('speaker');
  await page.waitForFunction(() => routing.sink === 'speaker');
  assert.equal(
    await page.evaluate(() => localStorage.getItem('pocketlink.virtualMic')),
    null,
    'Manual override clears preference',
  );
  await page.evaluate(() => {
    routing.failSink = true;
  });
  await route();
  assert.match(await message(), /无法切换输出/);
  assert.equal(await page.locator('#output-device').inputValue(), 'speaker');
  await open();
  await page.evaluate(() => {
    routing.installed = false;
  });
  await route();
  assert.match(await message(), /未找到虚拟麦克风/);
  assert.equal(await page.evaluate(() => routing.sink), '');
  assert.equal(await page.evaluate(() => routing.stops), 1);
  await open();
  await page.evaluate(() => {
    routing.denied = true;
  });
  await route();
  assert.match(await message(), /允许浏览器麦克风权限/);
  assert.equal(await page.evaluate(() => routing.sink), '');
  await page.evaluate(() => {
    routing.denied = false;
    routing.renamed = true;
  });
  await route();
  assert.match(await message(), /已启用系统麦克风/);
  assert.match(await page.locator('#mic-device-hint').textContent(), /PocketLink 麦克风/);
  assert.equal(
    await page.evaluate(() => routing.sink),
    'cable-playback',
    'Recording endpoint rename must not change playback routing',
  );
  assert.equal(await page.locator('#use-virtual-mic').getAttribute('aria-pressed'), 'true');
  for (const width of [320, 460, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await page.screenshot({ path: 'artifacts/receiver-system-mic.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    'PASS receiver output: correct sink, renamed microphone, simple mode switch, collapsed advanced controls, restart restoration, missing output, permission release/retry, failed switch, manual override, layout.',
  );
} finally {
  await browser?.close();
  await app.close();
}
