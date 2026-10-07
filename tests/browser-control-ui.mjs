// Exercise the real phone webpage controlling the independent desktop studio.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPocketServer } from '../server/index.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const soundDirectory = await mkdtemp(path.join(tmpdir(), 'pocketlink-native-'));

const app = await createPocketServer({ port: 0, env: {}, soundDirectory });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--mute-audio',
    ],
  });
  const receiver = await browser.newPage();
  const phone = await browser.newPage();
  const errors = [];
  for (const page of [receiver, phone]) page.on('pageerror', (error) => errors.push(error.message));
  await receiver.addInitScript(() => {
    window.testDevices = [
      { kind: 'audiooutput', deviceId: 'cable', label: 'CABLE Input (VB-Audio Virtual Cable)' },
      { kind: 'audioinput', deviceId: 'hardware', label: 'USB Microphone' },
    ];
    navigator.mediaDevices.enumerateDevices = async () => testDevices;
    Object.defineProperty(HTMLMediaElement.prototype, 'sinkId', {
      get() {
        return this.testSink || '';
      },
    });
    HTMLMediaElement.prototype.setSinkId = async function (id) {
      this.testSink = id;
    };
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const context = new AudioContext();
      await context.resume();
      const source = context.createOscillator();
      source.frequency.value = 440;
      const gain = context.createGain();
      gain.gain.value = 0.1;
      const output = context.createMediaStreamDestination();
      source.connect(gain).connect(output);
      source.start();
      output.stream.getAudioTracks()[0].getSettings = () => ({
        deviceId: constraints.audio?.deviceId?.exact || 'hardware',
      });
      return output.stream;
    };
  });
  const frames = 48000 * 4;
  const wave = Buffer.alloc(44 + frames * 2);
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
  const url = `/sounds/${'b'.repeat(64)}.wav`;
  await writeFile(
    path.join(soundDirectory, 'index.json'),
    JSON.stringify({
      sounds: [
        { id: 'tone', name: '测试音效', url },
        { id: 'unsafe', name: '无效地址', url: 'https://example.com/untrusted.wav' },
      ],
    }),
  );
  await writeFile(path.join(soundDirectory, path.basename(url)), wave);

  let phoneAssetRequests = 0;
  await phone.route('**/sounds/**', (route) => {
    phoneAssetRequests++;
    return route.abort();
  });
  await phone.addInitScript(() => {
    window.phoneCaptures = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      phoneCaptures++;
      throw new DOMException('Denied', 'NotAllowedError');
    };
  });
  await receiver.goto(base + '/receiver');
  await receiver.locator('#input-device').selectOption('hardware');
  await receiver.locator('#input-toggle').click();
  await receiver.waitForFunction(
    () => document.getElementById('input-toggle').getAttribute('aria-pressed') === 'true',
  );
  await receiver.evaluate(async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const stream = document.getElementById('remote-audio').srcObject;
    window.originalOutput = stream;
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
  await receiver.waitForFunction(() => level(440) > -35);
  await receiver.locator('#open-phone').click();
  await receiver.locator('#create-code').click();
  await receiver.waitForFunction(() =>
    /^\d{4} \d{4}$/.test(document.getElementById('receiver-code').textContent),
  );
  const connect = async () => {
    const code = (await receiver.locator('#receiver-code').textContent()).replace(/\D/g, '');
    await phone.goto(base + '/#pair=' + code);
    await phone.locator('#mic-view').waitFor({ state: 'visible' });
    await phone.waitForFunction(() => !document.getElementById('voice-effect').disabled);
    await phone.locator('.sound-button').waitFor({ state: 'visible' });
  };
  await connect();
  assert.equal(await receiver.locator('#input-device').inputValue(), 'hardware');
  assert.equal(await phone.evaluate(() => phoneCaptures), 0);
  assert.equal(await phone.locator('#voice-effect').isVisible(), true);
  assert.equal(await phone.locator('#microphone-controls').isVisible(), false);
  await phone.locator('#voice-effect').selectOption('deep');
  await receiver.waitForFunction(() => level(330) > -40 && level(440) < -45);
  await phone.locator('.sound-button').click();
  await receiver.waitForFunction(() => level(880) > -35 && level(330) > -40);
  assert.equal(await receiver.locator('.sound-tile').first().getAttribute('aria-pressed'), 'true');
  assert.equal(await phone.evaluate(() => phoneCaptures), 0);
  await receiver.locator('#stop-sound').click();
  await phone.waitForFunction(() => document.getElementById('stop-sound').hidden);
  await receiver.locator('#receiver-voice').selectOption('robot');
  await phone.waitForFunction(() => document.getElementById('voice-effect').value === 'robot');
  await receiver.locator('#receiver-voice').selectOption('original');
  await phone.waitForFunction(() => document.getElementById('voice-effect').value === 'original');
  // Denied phone permission must not disable remote voice or sounds.
  await phone.locator('#phone-microphone').click();
  await phone.waitForFunction(() =>
    document.getElementById('mic-message').textContent.includes('权限被拒绝'),
  );
  await phone.locator('.sound-button').click();
  await receiver.waitForFunction(() => level(880) > -35 && level(440) > -35);
  for (const width of [320, 390, 1440]) {
    await phone.setViewportSize({ width, height: 900 });
    assert.equal(
      await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.screenshot({ path: 'artifacts/phone-web-controller.png', fullPage: true });
  await phone.locator('#disconnect').click();
  await receiver.waitForFunction(() => !document.getElementById('pair-section').hidden);
  await receiver.waitForFunction(() => level(880) > -35 && level(440) > -35);
  await receiver.waitForFunction(() => level(880) < -65 && level(440) > -35);
  assert.equal(
    await receiver.evaluate(
      () => document.getElementById('remote-audio').srcObject === originalOutput,
    ),
    true,
  );
  await connect();
  await receiver
    .locator('#sound-files')
    .setInputFiles({ name: '网页同步.wav', mimeType: 'audio/wav', buffer: wave });
  await phone.waitForFunction(() =>
    [...document.querySelectorAll('.sound-button')].some((b) => b.textContent.includes('网页同步')),
  );
  assert.equal(await receiver.locator('#input-device').inputValue(), 'hardware');
  assert.equal(phoneAssetRequests, 0, 'Phone controller must not fetch or decode sound files');
  assert.deepEqual(errors, []);
  console.log(
    'PASS phone web controller: no mic permission, desktop input preserved, bidirectional voice/sound state, denial, disconnect, reconnect, live catalog and layout',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(soundDirectory, { recursive: true, force: true });
}
