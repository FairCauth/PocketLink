// Standalone Web Audio processing; replace only hardware capture/sink selection.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { createPocketServer } from '../server/index.mjs';
const app = await createPocketServer({ port: 0, env: {} });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser;
try {
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--mute-audio',
    ],
  });
  const context = await browser.newContext();
  context.setDefaultTimeout(15000);
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const receiver = await context.newPage();
  const phone = await context.newPage();
  for (const [page, frequency] of [
    [receiver, 440],
    [phone, 660],
  ]) {
    await page.addInitScript(
      ({ frequency }) => {
        window.captureTracks = [];
        window.captureCount = 0;
        navigator.mediaDevices.getUserMedia = async () => {
          captureCount++;
          if (window.denyCapture) throw new DOMException('Denied', 'NotAllowedError');
          const ctx = new AudioContext();
          await ctx.resume();
          const osc = ctx.createOscillator();
          osc.frequency.value = frequency;
          const gain = ctx.createGain();
          gain.gain.value = 0.12;
          const dest = ctx.createMediaStreamDestination();
          osc.connect(gain).connect(dest);
          osc.start();
          const track = dest.stream.getAudioTracks()[0];
          captureTracks.push(track);
          const stop = track.stop.bind(track);
          track.stop = () => {
            stop();
            osc.stop();
            void ctx.close();
          };
          if (window.deferCapture)
            await new Promise((resolve) => {
              window.releaseCapture = resolve;
            });
          return dest.stream;
        };
        try {
          localStorage.setItem(
            'pocketlink-audio-settings',
            JSON.stringify({ noiseSuppression: false, echoCancellation: false }),
          );
        } catch {
          /* about:blank */
        }
      },
      { frequency },
    );
  }
  await receiver.addInitScript(() => {
    window.signalSockets = [];
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(Target, args) {
        const socket = new Target(...args);
        signalSockets.push(socket);
        return socket;
      },
    });
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'audiooutput', deviceId: 'cable', label: 'CABLE Input (VB-Audio Virtual Cable)' },
      { kind: 'audioinput', deviceId: 'default', label: 'Default - CABLE Output' },
      {
        kind: 'audioinput',
        deviceId: 'loopback',
        label: 'PocketLink 麦克风 (VB-Audio Virtual Cable)',
      },
      { kind: 'audioinput', deviceId: 'hardware', label: 'USB Microphone' },
    ];
    Object.defineProperty(HTMLMediaElement.prototype, 'sinkId', {
      get() {
        return this.testSink || '';
      },
    });
    HTMLMediaElement.prototype.setSinkId = async function (id) {
      this.testSink = id;
    };
  });
  // A five-second preset, distinct from both microphone tones.
  const frames = 48000 * 5,
    wave = Buffer.alloc(44 + frames * 2);
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
  wave.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    wave.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 880 * i) / 48000) * 6000), 44 + i * 2);
  const url = `/sounds/${'a'.repeat(64)}.wav`;
  await receiver.route('**/sounds/index.json', (route) =>
    route.fulfill({ json: { sounds: [{ id: 'one', name: '测试音效', url }] } }),
  );
  await receiver.route(`**${url}`, (route) =>
    route.fulfill({ contentType: 'audio/wav', body: wave }),
  );
  await receiver.goto(base + '/receiver');
  assert.equal(await receiver.locator('#audio-section').isVisible(), true);
  assert.equal(await receiver.locator('#phone-dialog').isVisible(), false);
  assert.equal(await receiver.evaluate(() => captureCount), 0);
  assert.equal(await receiver.locator('#computer-microphone').count(), 0);
  assert.equal(await receiver.locator('#input-device option[value=phone]').count(), 0);
  assert.equal(await receiver.locator('#input-device option[value=loopback]').count(), 0);
  await receiver.locator('.sound-tile').click();
  await receiver.waitForFunction(() => !!document.getElementById('remote-audio').srcObject);
  await receiver.evaluate(async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const stream = document.getElementById('remote-audio').srcObject;
    window.originalStream = stream;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(stream).connect(analyser);
    window.level = (hz) => {
      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      const bin = Math.round((hz * analyser.fftSize) / ctx.sampleRate);
      return Math.max(...bins.slice(bin - 1, bin + 2));
    };
  });
  await receiver.waitForFunction(() => level(880) > -35);
  assert.equal(await receiver.evaluate(() => captureCount), 0);
  await receiver.locator('#stop-sound').click();
  await receiver.waitForFunction(() => level(880) < -65);
  await receiver.locator('#input-device').selectOption('hardware');
  await receiver.locator('#input-toggle').click();
  await receiver.waitForFunction(() => level(440) > -35);
  assert.equal(
    await receiver.evaluate(() => signalSockets.length),
    0,
    'Standalone studio needs no phone signaling',
  );
  await receiver.locator('#receiver-voice').selectOption('deep');
  await receiver.waitForFunction(() => level(330) > -40 && level(440) < -45);
  await receiver.locator('.sound-tile').click();
  await receiver.waitForFunction(() => level(330) > -40 && level(880) > -35);
  await receiver.locator('#input-gain').fill('0');
  await receiver.waitForFunction(() => level(330) < -65 && level(880) > -35);
  await receiver.locator('#input-gain').fill('100');
  await receiver.locator('#receiver-voice').selectOption('original');
  await receiver.locator('#stop-sound').click();
  await receiver.locator('#open-settings').click();
  await receiver.locator('#use-virtual-mic').click();
  await receiver.waitForFunction(() => document.getElementById('remote-audio').sinkId === 'cable');
  await receiver.locator('#use-speakers').click();
  await receiver.locator('#close-settings').click();
  await receiver.waitForFunction(() => level(440) > -35);
  assert.equal(await receiver.evaluate(() => captureCount), 1, 'Routing does not restart capture');
  await receiver.screenshot({ path: 'artifacts/standalone-studio.png', fullPage: true });
  await receiver.locator('#input-toggle').click();
  await receiver.waitForFunction(() =>
    captureTracks.every((track) => track.readyState === 'ended'),
  );
  await receiver.waitForFunction(() => level(440) < -65);
  await receiver.evaluate(() => {
    window.denyCapture = true;
  });
  await receiver.locator('#input-toggle').click();
  await receiver.waitForFunction(() =>
    document.getElementById('input-status').textContent.includes('请允许'),
  );
  await receiver.locator('.sound-tile').click();
  await receiver.waitForFunction(() => level(880) > -35);
  await receiver.locator('#stop-sound').click();
  await receiver.evaluate(() => {
    window.denyCapture = false;
    window.deferCapture = true;
  });
  await receiver.locator('#input-toggle').click();
  await receiver.waitForFunction(() => !!window.releaseCapture);
  await receiver.locator('#input-toggle').click();
  await receiver.evaluate(() => releaseCapture());
  await receiver.waitForFunction(() =>
    captureTracks.every((track) => track.readyState === 'ended'),
  );
  assert.equal(await receiver.locator('#input-toggle').getAttribute('aria-pressed'), 'false');
  await receiver.evaluate(() => {
    window.deferCapture = false;
  });
  await receiver.locator('#input-toggle').click();
  await receiver.waitForFunction(() => level(440) > -35);
  await receiver.evaluate(() => captureTracks.at(-1).dispatchEvent(new Event('ended')));
  await receiver.waitForFunction(() =>
    document.getElementById('input-status').textContent.includes('已断开'),
  );
  await receiver.locator('#input-toggle').click();
  await receiver.waitForFunction(() => level(440) > -35);
  await receiver.locator('#input-device').selectOption('none');
  await receiver.waitForFunction(() =>
    captureTracks.every((track) => track.readyState === 'ended'),
  );
  await receiver.locator('#input-device').selectOption('hardware');
  await receiver.locator('#input-toggle').click();
  await receiver.waitForFunction(() => level(440) > -35);
  for (const width of [320, 390, 1440]) {
    await receiver.setViewportSize({ width, height: 900 });
    assert.equal(
      await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  assert.equal(
    await receiver.evaluate(() => {
      const stream = document.getElementById('remote-audio').srcObject;
      const same = stream === originalStream;
      window.dispatchEvent(new Event('pagehide'));
      return (
        same &&
        stream.getTracks().every((t) => t.readyState === 'ended') &&
        captureTracks.every((t) => t.readyState === 'ended') &&
        !document.getElementById('remote-audio').srcObject
      );
    }),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS standalone studio: no pairing, voice, sound bypass, gain, output routing, denied/cancelled capture, source stop, track loss, layout and page cleanup',
  );
} finally {
  await browser?.close();
  await app.close();
}
