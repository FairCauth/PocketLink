// Real RNNoise/WASM in a browser, using generated noise only (no hardware capture).
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createPocketServer } from '../server/index.mjs';

const app = await createPocketServer({ port: 0, env: {} });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser;
async function assertNoiseReduction(page, label) {
  // Let the model adapt and exclude its silent startup buffers. This is a
  // routing/DSP regression check, not a promised suppression level for all noise.
  await page.waitForTimeout(3000);
  const levels = await page.evaluate(async () => {
    let raw = 0;
    let processed = 0;
    for (let i = 0; i < 30; i++) {
      raw += rms(false) ** 2;
      processed += rms() ** 2;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { raw: Math.sqrt(raw / 30), processed: Math.sqrt(processed / 30) };
  });
  console.log(label, levels);
  assert.ok(levels.raw > 0.05, 'The noise source must be audible');
  assert.ok(levels.processed > 0.00001, 'The processor must not simply mute the stream');
  assert.ok(levels.processed < levels.raw * 0.9, 'RNNoise must reduce average noise energy');
}
try {
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const html = (
    await readFile(new URL('../html/dist/index.html', import.meta.url), 'utf8')
  ).replace('<script type="module" src="/app.js"></script>', '');
  await page.route('**/noise-test', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto(base + '/noise-test');
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/audio-engine.js');
    const { setupSoundSettings } = await import('/sound-settings.js');
    window.captureTracks = [];
    navigator.mediaDevices.getUserMedia = async ({ audio }) => {
      const context = new AudioContext({ sampleRate: 48000 });
      await context.resume();
      const buffer = context.createBuffer(1, 48000, 48000);
      let seed = 12345;
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        data[i] = ((seed / 0xffffffff) * 2 - 1) * 0.15;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const destination = context.createMediaStreamDestination();
      source.connect(destination);
      source.start();
      const track = destination.stream.getAudioTracks()[0];
      const settings = { ...audio };
      track.getSettings = () => ({ ...settings });
      track.applyConstraints = async (constraints) => {
        Object.assign(settings, constraints);
      };
      const stop = track.stop.bind(track);
      track.stop = () => {
        stop();
        source.stop();
        void context.close();
      };
      captureTracks.push(track);
      return destination.stream;
    };
    window.engine = new AudioEngine();
    setupSoundSettings(engine);
    await engine.start();
    const rawMeter = engine.context.createAnalyser();
    engine.source.connect(rawMeter);
    window.rms = (processed = true) => {
      const meter = processed ? engine.analyser : rawMeter;
      const data = new Float32Array(meter.fftSize);
      meter.getFloatTimeDomainData(data);
      return Math.sqrt(data.reduce((sum, n) => sum + n * n, 0) / data.length);
    };
    document.getElementById('settings-dialog').showModal();
  });
  assert.equal(await page.evaluate(() => engine.noiseMode), 'ai');
  const outputTrack = await page.evaluate(() => engine.stream.getAudioTracks()[0].id);
  assert.equal(await page.evaluate(() => engine.track.getSettings().noiseSuppression), false);
  await assertNoiseReduction(page, 'RNNoise noise RMS:');
  assert.match(await page.locator('#echo-status').textContent(), /已启用/);
  await page.evaluate(() => {
    engine.track.getSettings = () => ({});
    engine.emit('processing');
  });
  assert.match(await page.locator('#echo-status').textContent(), /未报告/);
  await page.evaluate(() => {
    engine.track.getSettings = () => ({ echoCancellation: false, noiseSuppression: true });
    engine.emit('processing');
  });
  assert.match(await page.locator('#echo-status').textContent(), /未启用/);

  // Capture both branches at once; playback must gate the outgoing microphone.
  await page.locator('#noise-preview').click();
  await page.locator('#preview-controls').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => engine.previewing), false);
  await page.locator('#preview-after').click();
  assert.equal(await page.evaluate(() => engine.previewing), true);
  await page.waitForFunction(() => !engine.previewing);
  await page.evaluate(() => engine.setMuted(true));
  await page.locator('#preview-before').click();
  await page.locator('#preview-stop').click();
  assert.equal(await page.evaluate(() => engine.muted && !engine.previewing), true);
  await page.evaluate(() => engine.setMuted(false));
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.getElementById('settings-dialog').scrollWidth <=
            document.getElementById('settings-dialog').clientWidth,
      ),
      true,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/noise-settings.png' });

  await page.locator('#noise-suppression').uncheck();
  await page.waitForFunction(() => engine.noiseMode === 'off');
  await page.waitForFunction(() => rms() > 0.05);
  await page.evaluate(async () => {
    await engine.setVoice('robot');
    engine.voiceNode.dispatchEvent(new Event('processorerror'));
  });
  await page.waitForFunction(() => rms() > 0.05);
  assert.equal(await page.evaluate(() => engine.voice), 'original');
  await page.locator('#noise-suppression').check();
  await page.waitForFunction(() => engine.noiseMode === 'ai');
  await assertNoiseReduction(page, 'Re-enabled RNNoise RMS:');
  assert.equal(await page.evaluate(() => engine.stream.getAudioTracks()[0].id), outputTrack);
  await page.evaluate(async () => {
    await engine.setVoice('robot');
    engine.voiceNode.dispatchEvent(new Event('processorerror'));
  });
  assert.equal(await page.evaluate(() => engine.noiseMode), 'ai');
  await assertNoiseReduction(page, 'After voice fallback RMS:');
  await page.evaluate(() => engine.noiseProcessor.node.dispatchEvent(new Event('processorerror')));
  await page.waitForFunction(() => engine.noiseMode === 'browser' && rms() > 0.05);
  assert.match(await page.locator('#noise-status').textContent(), /已切换浏览器/);

  // Failed download must never silence capture or prevent connection.
  await page.route('**/vendor/rnnoise/rnnoise.wasm', (route) => route.fulfill({ status: 404 }));
  await page.evaluate(async () => {
    await engine.stop();
    await engine.start();
  });
  assert.equal(await page.evaluate(() => engine.noiseMode), 'browser');
  assert.equal(await page.evaluate(() => engine.state), 'on');
  await page.locator('#noise-preview').click();
  await page.evaluate(() => document.getElementById('settings-dialog').close());
  assert.equal(await page.evaluate(() => engine.previewing), false);
  await page.evaluate(() => engine.stop());
  assert.equal(
    await page.evaluate(() => captureTracks.every((track) => track.readyState === 'ended')),
    true,
  );

  // A successful HTTP response with a corrupt WASM body must also fall back.
  await page.unroute('**/vendor/rnnoise/rnnoise.wasm');
  await page.route('**/vendor/rnnoise/rnnoise.wasm', (route) =>
    route.fulfill({ body: 'invalid wasm' }),
  );
  await page.evaluate(() => engine.start());
  assert.equal(await page.evaluate(() => engine.noiseMode), 'browser');
  await page.evaluate(() => {
    document.getElementById('settings-dialog').showModal();
  });
  await page.locator('#noise-preview').click();
  await page.evaluate(() => engine.stop());
  assert.equal(await page.locator('#preview-controls').isVisible(), false);
  assert.equal(await page.evaluate(() => engine.previewing), false);

  // Cancellation while loading, followed by a new session, must not wire stale nodes.
  await page.unroute('**/vendor/rnnoise/rnnoise.wasm');
  let release;
  await page.route('**/vendor/rnnoise/rnnoise.wasm', async (route) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.continue().catch(() => {});
  });
  await page.evaluate(() => {
    window.pendingStart = engine.start();
  });
  await page.waitForFunction(() => engine.noiseMode === 'loading');
  await page.evaluate(() => engine.stop());
  release?.();
  await page.evaluate(() => pendingStart);
  assert.equal(await page.evaluate(() => engine.state), 'off');
  assert.equal(await page.evaluate(() => engine.noiseProcessor), null);
  assert.deepEqual(errors, []);
  console.log('Noise DSP, status, preview, fallback, cancellation and mobile layout passed.');
} finally {
  await browser?.close();
  await app.close();
}
