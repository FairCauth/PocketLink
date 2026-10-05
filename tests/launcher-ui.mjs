// Run against the local launcher with Playwright available via NODE_PATH.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import QRCode from 'qrcode';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.env.POCKETLINK_TEST_URL || 'https://localhost:18787';
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || 'chrome',
  headless: true,
});
try {
  // Deliberately do not ignore TLS errors: the launcher must establish computer trust.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/receiver');
  await page.locator('#create-code').click();
  await page.locator('#open-setup').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('phone-qr').naturalWidth > 0);
  const config = await page.evaluate(async () => (await fetch('/api/config')).json());
  assert.ok(config.phoneURLs[0].startsWith('https://'));
  assert.equal(await page.locator('#phone-url').getAttribute('href'), config.phoneURLs[0]);
  const code = (await page.locator('#receiver-code').textContent()).replace(/\D/g, '');
  const scannedURL = new URL(config.phoneURLs[0]);
  scannedURL.hash = `pair=${code}`;
  const qrSVG = await page.evaluate(async () =>
    (await fetch(document.getElementById('phone-qr').src)).text(),
  );
  assert.equal(
    qrSVG,
    await QRCode.toString(scannedURL.href, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' }),
  );
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await page.screenshot({ path: 'artifacts/receiver-ready.png', fullPage: true });
  await page.locator('#open-setup').click();
  await page.waitForFunction(() => document.getElementById('setup-qr').naturalWidth > 0);
  assert.match(
    await page.locator('#certificate-fingerprint').textContent(),
    new RegExp(config.certificate.fingerprint),
  );
  assert.equal(await page.locator('#setup-url').getAttribute('href'), config.setupURLs[0]);
  await page.screenshot({ path: 'artifacts/receiver-setup.png', fullPage: true });
  await page.locator('#close-setup').click();
  if (config.phoneURLs.length > 1) {
    await page.locator('#open-settings').click();
    await page.locator('#advanced-settings > summary').click();
    await page.locator('#phone-network').selectOption('1');
    assert.equal(await page.locator('#phone-url').getAttribute('href'), config.phoneURLs[1]);
    assert.equal(await page.locator('#setup-url').getAttribute('href'), config.setupURLs[1]);
    await page.locator('#phone-network').selectOption('0');
    await page.locator('#close-settings').click();
  }
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const bounds = await page.evaluate(() => {
      const code = document.getElementById('receiver-code').getBoundingClientRect();
      const copy = document.getElementById('copy-code').getBoundingClientRect();
      return { right: code.right, left: copy.left };
    });
    assert.ok(bounds.right <= bounds.left, `copy button overlaps code at ${width}`);
  }
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  // Use the LAN URL exactly as advertised, not a localhost substitute.
  await phone.goto(config.setupURLs[0]);
  assert.match(await phone.locator('h1').textContent(), /iPhone/);
  const certURL = new URL('/rootCA.cer', config.setupURLs[0]).href;
  const response = await context.request.get(certURL);
  assert.equal(response.status(), 200);
  const cert = new X509Certificate(await response.body());
  assert.equal(cert.fingerprint256, config.certificate.fingerprint);
  assert.equal(cert.ca, true);
  await phone.screenshot({ path: 'artifacts/iphone-setup.png', fullPage: true });
  await phone.getByRole('link', { name: '打开麦克风' }).click();
  assert.equal(await phone.locator('#pair-view').isVisible(), true);
  assert.deepEqual(errors, []);
  await page.locator('#disconnect').click();
  console.log(
    'PASS trusted HTTPS, LAN phone URL, receiver layout, both QR codes, network switching, public CA download and onboarding return',
  );
} finally {
  await browser.close();
}
