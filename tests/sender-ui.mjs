// Run with Playwright available in node_modules or NODE_PATH; uses synthetic audio only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createPocketServer } from '../server/index.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const app = await createPocketServer({ port: 0, env: { ENABLE_BROWSER_TESTS: '1' } });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser;
const errors = [];
const soundURLs = ['a', 'b'].map((letter) => `/sounds/${letter.repeat(64)}.wav`);
function soundFixture(frequency) {
  const rate = 48000;
  const frames = rate * 3;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 6000), 44 + i * 2);
  return wav;
}
const expectVisible = async (page, selector) =>
  page.locator(selector).waitFor({ state: 'visible' });
const expectReleased = async (page) =>
  page.waitForFunction(() => window.captureTracks.every((track) => track.readyState === 'ended'));
try {
  // Keep same-machine ICE candidates resolvable in the headless test environment.
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--mute-audio',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const receiver = await context.newPage();
  await receiver.goto(`${base}/receiver`);
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  assert.equal(await receiver.locator('#audio-section').isVisible(), false);
  await receiver.locator('#create-code').click();
  await receiver.waitForFunction(() =>
    /^\d{4} \d{4}$/.test(document.getElementById('receiver-code').textContent),
  );
  await receiver.waitForFunction(() => document.getElementById('phone-qr').naturalWidth > 0);
  for (const width of [320, 390, 1440]) {
    await receiver.setViewportSize({ width, height: 900 });
    assert.equal(
      await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `receiver overflow at ${width}`,
    );
  }
  await receiver.screenshot({ path: 'artifacts/receiver-pair.png', fullPage: true });
  await receiver.locator('#open-settings').click();
  assert.equal(await receiver.locator('#use-virtual-mic').isVisible(), true);
  assert.equal(await receiver.locator('#output-device').isVisible(), false);
  await receiver.locator('#close-settings').click();
  const code = (await receiver.locator('#receiver-code').textContent()).replace(/\D/g, '');
  const phone = await context.newPage();
  let failFirstSound = true;
  let delaySecondSound = true;
  let releaseSound;
  await phone.route('**/sounds/index.json', (route) =>
    route.fulfill({
      json: {
        sounds: soundURLs.map((url, i) => ({
          id: String(i),
          name: ['测试音效', '切换音效'][i],
          url,
        })),
      },
    }),
  );
  await phone.route(`**${soundURLs[0]}`, (route) => {
    if (failFirstSound) {
      failFirstSound = false;
      return route.fulfill({ status: 404 });
    }
    return route.fulfill({ contentType: 'audio/wav', body: soundFixture(880) });
  });
  await phone.route(`**${soundURLs[1]}`, async (route) => {
    if (delaySecondSound) {
      delaySecondSound = false;
      await new Promise((resolve) => {
        releaseSound = resolve;
      });
    }
    await route.fulfill({ contentType: 'audio/wav', body: soundFixture(1320) }).catch(() => {});
  });
  await phone.addInitScript(() => {
    // Pure-tone voice/routing fixtures must bypass speech-oriented AI suppression.
    try {
      localStorage.setItem(
        'pocketlink-audio-settings',
        JSON.stringify({ noiseSuppression: false, echoCancellation: true }),
      );
    } catch {
      /* about:blank has no storage. */
    }
    window.captureTracks = [];
    window.captureCount = 0;
    window.denyCapture = false;
    navigator.mediaDevices.getUserMedia = async () => {
      window.captureCount++;
      if (window.denyCapture) throw new DOMException('Denied for test', 'NotAllowedError');
      const context = new AudioContext();
      await context.resume();
      const tone = context.createOscillator();
      const gain = context.createGain();
      const output = context.createMediaStreamDestination();
      gain.gain.value = 0.12;
      tone.connect(gain).connect(output);
      tone.start();
      const track = output.stream.getAudioTracks()[0];
      window.captureTracks.push(track);
      const stop = track.stop.bind(track);
      track.stop = () => {
        stop();
        tone.stop();
        void context.close();
      };
      return output.stream;
    };
  });
  await phone.goto(base);
  assert.equal(await phone.locator('#mic-view').isVisible(), false);
  assert.equal(await phone.locator('#recordings').isVisible(), false);
  assert.equal(await phone.locator('#connect-button').isDisabled(), true);
  assert.equal(await phone.evaluate(() => window.captureCount), 0);
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await phone.screenshot({ path: 'artifacts/pair-mobile.png', fullPage: true });
  for (const width of [320, 390, 430, 1440]) {
    await phone.setViewportSize({ width, height: 844 });
    assert.equal(
      await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `pair overflow at ${width}`,
    );
  }
  await phone.screenshot({ path: 'artifacts/pair-desktop.png', fullPage: true });
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.locator('#pair-code').fill('123');
  assert.equal(await phone.locator('#connect-button').isDisabled(), true);
  assert.equal(await phone.evaluate(() => window.captureCount), 0);
  console.log('PASS pairing-only first screen, mobile/desktop layout, no early capture');

  await phone.evaluate(() => (window.denyCapture = true));
  await phone.locator('#pair-code').fill(code);
  await phone.locator('#connect-button').click();
  await phone.waitForFunction(
    () =>
      document.getElementById('pair-status').textContent.includes('权限被拒绝') &&
      !document.getElementById('connect-button').disabled,
  );
  assert.equal(await phone.locator('#mic-view').isVisible(), false);
  await phone.evaluate(() => (window.denyCapture = false));
  console.log('PASS permission denial stays on pairing page and can retry');

  await phone.locator('#pair-code').fill(code === '11111111' ? '22222222' : '11111111');
  await phone.locator('#connect-button').click();
  await phone.waitForFunction(
    () =>
      document.getElementById('pair-status').classList.contains('error') &&
      !document.getElementById('connect-button').disabled,
  );
  await expectReleased(phone);
  console.log('PASS invalid pair code releases microphone');

  const connect = async () => {
    await phone.locator('#pair-code').fill(code);
    await phone.locator('#connect-button').click();
    try {
      await expectVisible(phone, '#mic-view');
    } catch (error) {
      console.error(
        'Connection diagnostics:',
        await phone.locator('#pair-status').textContent(),
        await receiver.locator('#receiver-status').textContent(),
        errors,
      );
      throw error;
    }
    await receiver.waitForFunction(() =>
      document.getElementById('receiver-status').textContent.includes('已连接'),
    );
  };
  await connect();
  assert.equal(await phone.locator('#pair-view').isVisible(), false);
  await receiver.evaluate(async () => {
    const audio = document.getElementById('remote-audio');
    const context = new AudioContext();
    await context.resume();
    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    let source;
    window.refreshReceivedStream = () => {
      source?.disconnect();
      source = context.createMediaStreamSource(audio.srcObject);
      source.connect(analyser);
    };
    window.refreshReceivedStream();
    window.receivedRms = () => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    };
    window.receivedPeak = () => {
      const values = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(values);
      let peak = -Infinity,
        frequency = 0;
      for (let i = 1; i < values.length; i++) {
        const hz = (i * context.sampleRate) / analyser.fftSize;
        if (hz > 100 && hz < 1500 && values[i] > peak) {
          peak = values[i];
          frequency = hz;
        }
      }
      return frequency;
    };
  });
  await receiver.waitForFunction(() => window.receivedRms() > 0.02);
  const capturesBeforeVoice = await phone.evaluate(() => window.captureCount);
  for (const [voice, lower, upper] of [
    ['deep', 315, 345],
    ['cartoon', 640, 680],
    ['robot', 360, 520],
    ['original', 430, 450],
  ]) {
    await phone.locator('#voice-effect').selectOption(voice);
    await phone.waitForFunction(() => !document.getElementById('voice-effect').disabled);
    assert.equal(await phone.locator('#voice-effect').inputValue(), voice);
    await receiver.waitForFunction(
      ({ lower, upper, voice }) => {
        const peak = window.receivedPeak();
        return peak > lower && peak < upper && (voice !== 'robot' || Math.abs(peak - 440) > 40);
      },
      { lower, upper, voice },
    );
  }
  assert.equal(await phone.evaluate(() => window.captureCount), capturesBeforeVoice);
  await phone.locator('#voice-effect').selectOption('deep');
  await phone.waitForFunction(() => !document.getElementById('voice-effect').disabled);
  await phone.locator('#mute-mic').click();
  await receiver.waitForFunction(() => window.receivedRms() < 0.003);
  await phone.locator('#voice-effect').selectOption('robot');
  await phone.waitForFunction(() => !document.getElementById('voice-effect').disabled);
  assert.ok((await receiver.evaluate(() => window.receivedRms())) < 0.003);
  await phone.locator('#mute-mic').click();
  await receiver.waitForFunction(() => window.receivedRms() > 0.02);
  await phone.locator('#voice-effect').selectOption('original');
  await phone.waitForFunction(() => !document.getElementById('voice-effect').disabled);
  console.log(
    'PASS real receiver hears each voice effect; changing voice preserves capture and mute',
  );
  // Assert soundboard audio reaches the actual WebRTC receiver while microphone input is muted.
  await phone.locator('#mute-mic').click();
  await receiver.waitForFunction(() => window.receivedRms() < 0.003);
  const firstSound = phone.locator('.sound-button').nth(0);
  const secondSound = phone.locator('.sound-button').nth(1);
  await firstSound.click();
  await phone.waitForFunction(() =>
    document.getElementById('sound-status').textContent.includes('加载失败'),
  );
  assert.equal(await firstSound.getAttribute('aria-pressed'), 'false');
  await firstSound.click();
  await receiver.waitForFunction(
    () => window.receivedPeak() > 860 && window.receivedPeak() < 900 && window.receivedRms() > 0.02,
  );
  assert.equal(await phone.locator('#mute-mic').getAttribute('aria-pressed'), 'true');
  await phone.waitForFunction(() => document.getElementById('stop-sound').hidden);
  await receiver.waitForFunction(() => window.receivedRms() < 0.003);
  await secondSound.click();
  await phone.waitForFunction(() =>
    document.getElementById('sound-status').textContent.includes('正在加载'),
  );
  await phone.locator('#stop-sound').click();
  // Flush the cancelled network request, then prove no sound starts later.
  while (!releaseSound) await new Promise((resolve) => setTimeout(resolve, 10));
  releaseSound();
  await phone.waitForTimeout(200);
  assert.equal(await phone.locator('#stop-sound').isVisible(), false);
  assert.ok((await receiver.evaluate(() => window.receivedRms())) < 0.003);
  await secondSound.click();
  await receiver.waitForFunction(
    () =>
      window.receivedPeak() > 1300 && window.receivedPeak() < 1340 && window.receivedRms() > 0.02,
  );
  await firstSound.click();
  await receiver.waitForFunction(() => window.receivedPeak() > 860 && window.receivedPeak() < 900);
  assert.equal(await secondSound.getAttribute('aria-pressed'), 'false');
  await firstSound.click();
  await receiver.waitForFunction(() => window.receivedRms() < 0.003);
  assert.equal(await firstSound.getAttribute('aria-pressed'), 'false');
  assert.equal(await phone.evaluate(() => window.captureCount), capturesBeforeVoice);
  await phone.locator('#mute-mic').click();
  await receiver.waitForFunction(() => window.receivedRms() > 0.02);
  console.log(
    'PASS soundboard reaches WebRTC while mic is muted; error retry, natural end, cancellation and switching',
  );
  assert.equal(await receiver.locator('#pair-section').isVisible(), false);
  await receiver.locator('#output-volume').fill('35');
  assert.equal(await receiver.locator('#remote-audio').evaluate((audio) => audio.volume), 0.35);
  await receiver.locator('#resume-audio').click();
  assert.equal(await receiver.locator('#remote-audio').evaluate((audio) => audio.paused), true);
  await receiver.locator('#resume-audio').click();
  assert.equal(await receiver.locator('#remote-audio').evaluate((audio) => audio.paused), false);
  await receiver.screenshot({ path: 'artifacts/receiver-connected.png', fullPage: true });
  await phone.screenshot({ path: 'artifacts/mic-mobile.png', fullPage: true });
  await phone.locator('#mute-mic').click();
  assert.equal(await phone.locator('#mute-mic').getAttribute('aria-pressed'), 'true');
  await receiver.waitForFunction(() => window.receivedRms() < 0.003);
  await phone.screenshot({ path: 'artifacts/muted-mobile.png', fullPage: true });
  await phone.locator('#mute-mic').click();
  await receiver.waitForFunction(() => window.receivedRms() > 0.02);
  await phone.locator('#gain').fill('25');
  await receiver.waitForFunction(() => window.receivedRms() > 0.003 && window.receivedRms() < 0.03);
  assert.equal(await phone.locator('#gain-value').textContent(), '25%');
  console.log('PASS one-click capture + real WebRTC audio, mute/unmute and gain');

  await phone.locator('#open-settings').click();
  assert.equal(await phone.locator('input[name="mode"]').first().isDisabled(), true);
  await phone.locator('#close-settings').click();
  for (const width of [320, 390, 430, 1440]) {
    await phone.setViewportSize({ width, height: 844 });
    assert.equal(
      await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `mic overflow at ${width}`,
    );
  }
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.locator('#voice-effect').selectOption('cartoon');
  await phone.waitForFunction(() => !document.getElementById('voice-effect').disabled);
  await phone.screenshot({ path: 'artifacts/voice-mobile.png', fullPage: true });
  await phone.locator('#record-button').click();
  await phone.waitForFunction(() => document.getElementById('record-time').textContent !== '00:00');
  await phone.locator('#record-button').click();
  await expectVisible(phone, '#recordings');
  assert.equal(await phone.locator('#recording-count').textContent(), '1');
  const recordingBytes = await phone
    .locator('#recording-list a')
    .evaluate(async (a) => (await (await fetch(a.href)).blob()).size);
  assert.ok(recordingBytes > 100);
  const recordedPeak = await phone.locator('#recording-list a').evaluate(async (a) => {
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(await (await fetch(a.href)).arrayBuffer());
      const samples = decoded.getChannelData(0).subarray(Math.floor(decoded.length / 3));
      let peak = 0,
        frequency = 0;
      for (let hz = 250; hz < 800; hz += 2) {
        const coefficient = 2 * Math.cos((2 * Math.PI * hz) / decoded.sampleRate);
        let first = 0,
          second = 0;
        for (const sample of samples) {
          const value = sample + coefficient * first - second;
          second = first;
          first = value;
        }
        const power = first * first + second * second - coefficient * first * second;
        if (power > peak) {
          peak = power;
          frequency = hz;
        }
      }
      return frequency;
    } finally {
      await context.close();
    }
  });
  assert.ok(
    recordedPeak > 640 && recordedPeak < 680,
    `recording is missing voice effect: ${recordedPeak}`,
  );
  const downloadPromise = phone.waitForEvent('download');
  await phone.locator('#recording-list a').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^PocketLink-.*\.(m4a|webm|ogg)$/);
  console.log('PASS recording, playback controls and downloadable audio');

  await phone.locator('#disconnect').click();
  await expectVisible(phone, '#pair-view');
  await expectReleased(phone);
  await receiver.waitForFunction(() =>
    document.getElementById('receiver-status').textContent.includes('等待手机'),
  );
  assert.equal(await phone.locator('#recordings').isVisible(), true);
  await connect();
  assert.equal(await phone.locator('#voice-effect').inputValue(), 'cartoon');
  await receiver.evaluate(() => window.refreshReceivedStream());
  await receiver.waitForFunction(() => window.receivedPeak() > 640 && window.receivedPeak() < 680);
  await receiver.locator('#disconnect').click();
  await phone.waitForFunction(
    () =>
      !document.getElementById('connect-button').disabled &&
      document.getElementById('pair-status').textContent.includes('接收端已关闭'),
  );
  await expectReleased(phone);
  console.log('PASS local/remote disconnect releases capture, recordings survive and retry works');

  let releaseConfig;
  await phone.route('**/api/config', async (route) => {
    await new Promise((resolve) => (releaseConfig = resolve));
    await route.continue().catch(() => {});
  });
  await phone.locator('#pair-code').fill(code);
  await phone.locator('#connect-button').click();
  await expectVisible(phone, '#cancel-connect');
  await phone.locator('#cancel-connect').click();
  releaseConfig?.();
  await expectReleased(phone);
  await phone.waitForFunction(() => !document.getElementById('connect-button').disabled);
  await phone.unroute('**/api/config');
  console.log('PASS cancel pending connection releases capture');

  // Exercise failure recovery on the real engine without replacing the active UI's engine.
  await phone.evaluate(async () => {
    const { AudioEngine } = await import('/audio-engine.js');
    window.voiceEngine = new AudioEngine();
    voiceEngine.options.noiseSuppression = false;
    window.voiceWarnings = [];
    voiceEngine.addEventListener('warning', (e) => voiceWarnings.push(e.detail.message));
    await voiceEngine.start();
  });
  const failedLoad = await phone.evaluate(async () => {
    const worklet = voiceEngine.context.audioWorklet;
    window.originalAddModule = worklet.addModule.bind(worklet);
    worklet.addModule = () => Promise.reject(new DOMException('Module unavailable', 'AbortError'));
    await voiceEngine.setVoice('deep');
    return {
      voice: voiceEngine.voice,
      state: voiceEngine.state,
      track: voiceEngine.stream.getAudioTracks()[0].readyState,
      warnings: voiceWarnings.length,
    };
  });
  assert.deepEqual(failedLoad, { voice: 'original', state: 'on', track: 'live', warnings: 1 });
  await phone.waitForFunction(() => {
    const samples = new Float32Array(2048);
    voiceEngine.analyser.getFloatTimeDomainData(samples);
    return samples.some((sample) => Math.abs(sample) > 0.02);
  });
  const recovery = await phone.evaluate(async () => {
    voiceEngine.context.audioWorklet.addModule = window.originalAddModule;
    await voiceEngine.setVoice('robot');
    const loaded = Boolean(voiceEngine.voiceNode);
    voiceEngine.voiceNode.dispatchEvent(new Event('processorerror'));
    return {
      loaded,
      voice: voiceEngine.voice,
      node: voiceEngine.voiceNode,
      state: voiceEngine.state,
    };
  });
  assert.deepEqual(recovery, { loaded: true, voice: 'original', node: null, state: 'on' });
  await phone.waitForFunction(() => {
    const samples = new Float32Array(2048);
    voiceEngine.analyser.getFloatTimeDomainData(samples);
    return samples.some((sample) => Math.abs(sample) > 0.02);
  });
  await phone.evaluate(async () => {
    await voiceEngine.stop();
    await voiceEngine.start();
    Object.defineProperty(voiceEngine.context, 'audioWorklet', { value: undefined });
    await voiceEngine.setVoice('cartoon');
  });
  assert.equal(await phone.evaluate(() => voiceEngine.voice), 'original');
  assert.equal(await phone.evaluate(() => voiceEngine.state), 'on');
  await phone.evaluate(async () => {
    await voiceEngine.stop();
    await voiceEngine.start();
  });
  await phone.evaluate(() => {
    voiceEngine.context.audioWorklet.addModule = () =>
      new Promise((resolve) => {
        window.releaseVoice = resolve;
      });
    window.pendingVoice = voiceEngine.setVoice('deep');
  });
  await phone.evaluate(async () => {
    await voiceEngine.stop();
  });
  await phone.evaluate(async () => {
    releaseVoice();
    await pendingVoice;
  });
  assert.equal(await phone.evaluate(() => voiceEngine.state), 'off');
  assert.equal(await phone.evaluate(() => voiceEngine.voiceNode), null);
  await expectReleased(phone);
  console.log(
    'PASS failed/unsupported worklet and processor error restore original; disconnect during load releases capture',
  );

  assert.deepEqual(errors, []);
  console.log('ALL PASS (synthetic microphone, Chromium)');
} finally {
  await browser?.close();
  await app.close();
}
