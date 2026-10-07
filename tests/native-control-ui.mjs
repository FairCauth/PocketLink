// Exercise the native client's data-channel protocol through real browser WebRTC.
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
  await receiver.goto(base + '/receiver');
  if (!(await receiver.locator('#phone-dialog').isVisible()))
    await receiver.locator('#open-phone').click();
  await receiver.locator('#create-code').click();
  await receiver.waitForFunction(() =>
    /^\d{4} \d{4}$/.test(document.getElementById('receiver-code').textContent),
  );
  await phone.goto(base);
  const connect = async () => {
    const code = (await receiver.locator('#receiver-code').textContent()).replace(/\D/g, '');
    await phone.evaluate(
      async ({ base, code }) => {
        const { AudioLink } = await import('/connection.js');
        window.nativeLink = new AudioLink();
        window.messages = [];
        const createPeer = nativeLink.createPeer.bind(nativeLink);
        nativeLink.createPeer = (mode) => {
          createPeer(mode);
          window.control = nativeLink.peer.createDataChannel('pocketlink-control-v1');
          control.onmessage = ({ data }) => messages.push(JSON.parse(data));
        };
        const ctx = new AudioContext();
        window.silentContext = ctx;
        const output = ctx.createMediaStreamDestination();
        const oscillator = ctx.createOscillator();
        oscillator.frequency.value = 660;
        const gain = ctx.createGain();
        gain.gain.value = 0.1;
        oscillator.connect(gain).connect(output);
        oscillator.start();
        await ctx.resume();
        window.nativeTrack = output.stream.getAudioTracks()[0];
        output.stream.getTracks().forEach((track) => {
          track.enabled = false;
        });
        await nativeLink.open({ role: 'sender', code, server: base, stream: output.stream });
      },
      { base, code },
    );
    await phone.waitForFunction(() => messages.some((message) => message.type === 'catalog'));
    assert.deepEqual(
      await phone.evaluate(() => messages.find((message) => message.type === 'catalog').sounds),
      [{ id: 'tone', name: '测试音效' }],
    );
    await receiver.locator('#audio-section').waitFor({ state: 'visible' });
  };
  const command = (message) =>
    phone.evaluate((message) => control.send(JSON.stringify(message)), message);
  await connect();
  await phone.waitForFunction(() =>
    messages.some(
      (m) =>
        m.type === 'input-state' &&
        m.devices?.some((d) => d.id === 'phone' && d.name === '手机（无线）'),
    ),
  );
  assert.ok(
    await phone.evaluate(() =>
      messages
        .filter((m) => m.type === 'input-state')
        .at(-1)
        .devices.some((d) => d.id === 'hardware'),
    ),
  );
  await command({ type: 'set-input', id: 'removed-device', requestId: 'invalid' });
  await phone.waitForFunction(() =>
    messages.some((m) => m.type === 'input-result' && m.requestId === 'invalid' && m.error),
  );
  assert.equal(await receiver.locator('#input-device').inputValue(), 'none');
  await command({ type: 'set-input', id: 'hardware', enabled: true, requestId: 'enable-pc' });
  await phone.waitForFunction(() =>
    messages.some((m) => m.type === 'input-result' && m.requestId === 'enable-pc' && !m.error),
  );
  assert.equal(await receiver.locator('#input-toggle').getAttribute('aria-pressed'), 'true');
  await command({ type: 'set-input', id: 'none', requestId: 'sound-only' });
  await phone.waitForFunction(() =>
    messages.some((m) => m.type === 'input-result' && m.requestId === 'sound-only'),
  );
  assert.equal(await receiver.locator('#input-toggle').getAttribute('aria-pressed'), 'false');
  // An empty installation can receive its first sound without another pairing.
  await receiver.route('**/sounds/index.json', (route) => route.fulfill({ status: 404, body: '' }));
  await command({ type: 'refresh-catalog' });
  await phone.waitForFunction(
    () => messages.filter((m) => m.type === 'catalog').at(-1)?.sounds.length === 0,
  );
  await receiver.unroute('**/sounds/index.json');
  await command({ type: 'refresh-catalog' });
  await phone.waitForFunction(
    () => messages.filter((m) => m.type === 'catalog').at(-1)?.sounds[0]?.id === 'tone',
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
  await command({ type: 'play-sound', id: 'tone' });
  await receiver.waitForFunction(() => level(880) > -35);
  await command({ type: 'stop-sound' });
  await receiver.waitForFunction(() => level(880) < -65);
  await command({ type: 'play-sound', id: 'unsafe', url: 'https://example.com/untrusted.wav' });
  await phone.waitForFunction(() => messages.some((message) => message.type === 'sound-error'));
  await receiver.locator('#input-device').selectOption('hardware');
  await receiver.locator('#input-toggle').click();
  await receiver.waitForFunction(() => level(440) > -35);
  await receiver.evaluate(() => {
    testDevices.push({ kind: 'audioinput', deviceId: 'new-usb', label: 'New USB microphone' });
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await receiver.waitForFunction(() =>
    [...document.getElementById('input-device').options].some((o) => o.value === 'new-usb'),
  );
  assert.equal(await receiver.locator('#input-device').inputValue(), 'hardware');
  await phone.waitForFunction(() =>
    messages.some((m) => m.type === 'voice-state' && m.presets.length === 8),
  );
  await phone.evaluate(() => {
    nativeTrack.enabled = true;
  });
  await receiver.waitForFunction(() => level(440) > -35 && level(660) < -65);
  await command({ type: 'set-input', id: 'phone', requestId: 'phone' });
  await receiver.waitForFunction(() => level(660) > -35 && level(440) < -65);
  await command({ type: 'set-voice', id: 'deep' });
  await phone.waitForFunction(() =>
    messages.some((m) => m.type === 'voice-state' && m.selected === 'deep'),
  );
  try {
    await receiver.waitForFunction(
      () => level(330) < -65 && level(494) > -40 && level(440) < -45 && level(660) < -45,
      null,
      { timeout: 5000 },
    );
  } catch (error) {
    console.log(
      'voice diagnostic',
      await receiver.evaluate(() => ({
        levels: [310, 320, 330, 340, 440, 480, 490, 494, 500, 510, 660].map((hz) => [
          hz,
          level(hz),
        ]),
        state: document.getElementById('receiver-voice').value,
        error: document.getElementById('settings-status').textContent,
      })),
      errors,
    );
    throw error;
  }
  await command({ type: 'play-sound', id: 'tone' });
  await receiver.waitForFunction(() => level(880) > -35 && level(494) > -40);
  await command({ type: 'set-input', id: 'hardware', requestId: 'computer' });
  await receiver.waitForFunction(() => level(330) > -40 && level(494) < -65);
  await receiver.locator('#receiver-voice').selectOption('original');
  await phone.waitForFunction(
    () => messages.at(-1)?.type === 'voice-state' && messages.at(-1).selected === 'original',
  );
  await command({ type: 'stop-sound' });
  await phone.evaluate(() => {
    nativeTrack.enabled = false;
  });
  await receiver.waitForFunction(() => level(660) < -65 && level(440) > -35);
  await command({ type: 'set-voice', id: 'unknown' });
  await phone.waitForFunction(() => messages.some((m) => m.type === 'voice-error'));

  await command({ type: 'play-sound', id: 'tone' });
  await receiver.waitForFunction(() => level(440) > -35 && level(880) > -35);
  await phone.evaluate(() => nativeLink.close());
  await receiver.waitForFunction(() => !document.getElementById('pair-section').hidden);
  await receiver.waitForFunction(() => level(440) > -35 && level(880) > -35);
  await receiver.waitForFunction(() => level(440) > -35 && level(880) < -65);
  assert.equal(
    await receiver.evaluate(
      () => document.getElementById('remote-audio').srcObject === originalOutput,
    ),
    true,
  );
  await connect();
  await command({ type: 'play-sound', id: 'tone' });
  await receiver.waitForFunction(() => level(440) > -35 && level(880) > -35);
  await receiver
    .locator('#sound-files')
    .setInputFiles({ name: '新增音效.wav', mimeType: 'audio/wav', buffer: wave });
  await phone.waitForFunction(() =>
    messages.some((m) => m.type === 'catalog' && m.sounds.some((s) => s.name === '新增音效')),
  );
  assert.equal(
    await receiver.locator('#sound-upload-status').textContent(),
    '已添加 1 个音效，手机列表已更新。',
  );
  assert.equal(await phone.evaluate(() => control.readyState), 'open');
  await receiver.evaluate(() => {
    testDevices = testDevices.filter((device) => device.deviceId !== 'hardware');
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await receiver.waitForFunction(
    () => document.getElementById('input-toggle').getAttribute('aria-pressed') === 'false',
  );

  await receiver.waitForFunction(() => level(440) < -65);
  await phone.waitForFunction(() => {
    const state = messages.filter((m) => m.type === 'input-state').at(-1);
    return (
      state?.selected === 'none' &&
      !state.enabled &&
      !state.devices.some((d) => d.id === 'hardware')
    );
  });
  await phone.evaluate(() => nativeLink.close());
  await receiver.waitForFunction(() => !document.getElementById('pair-section').hidden);
  await receiver.waitForFunction(() => level(880) > -35);
  await receiver.waitForFunction(() => level(880) < -65);
  assert.equal(
    await receiver.evaluate(
      () => document.getElementById('remote-audio').srcObject === originalOutput,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS native control: live catalog/upload, exclusive microphone selection and voice processing with sound bypass, hotplug, play/stop, disconnect persistence and reconnect',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(soundDirectory, { recursive: true, force: true });
}
