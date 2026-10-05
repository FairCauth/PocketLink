// Opt-in hardware diagnostic: sends a quiet test tone ONLY to VB-CABLE and reads
// ONLY its recording endpoint. No physical microphone, speaker or audio file.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPocketServer } from '../server/index.mjs';
if (process.env.ENABLE_VIRTUAL_CABLE_TEST !== '1')
  throw new Error('Set ENABLE_VIRTUAL_CABLE_TEST=1 to test an installed VB-CABLE driver.');
const { chromium } = createRequire(import.meta.url)('playwright');
const app = await createPocketServer({ port: 0, env: {} });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
    ignoreDefaultArgs: ['--mute-audio'],
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${app.server.address().port}/receiver`);
  const result = await page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const source = devices.find(
      (d) =>
        d.kind === 'audioinput' &&
        /^(?:CABLE Output\b|PocketLink 麦克风(?:\s*\(|$))/i.test(d.label) &&
        !['default', 'communications'].includes(d.deviceId),
    );
    const sink = devices.find(
      (d) =>
        d.kind === 'audiooutput' &&
        /^CABLE Input\b/i.test(d.label) &&
        !['default', 'communications'].includes(d.deviceId),
    );
    if (!source || !sink)
      return {
        error: 'VB-CABLE endpoints not visible',
        devices: devices.map((d) => ({ kind: d.kind, label: d.label })),
      };
    let capture, ctx, oscillator, playback;
    try {
      capture = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: source.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      // The test graph needs a clock, not the computer's default speaker. A
      // disconnected/default device can leave currentTime at zero in Chromium.
      ctx = new AudioContext({ sinkId: { type: 'none' } });
      await ctx.resume();
      const input = ctx.createMediaStreamSource(capture),
        analyser = ctx.createAnalyser();
      analyser.fftSize = 32768;
      analyser.smoothingTimeConstant = 0;
      input.connect(analyser);
      const destination = ctx.createMediaStreamDestination();
      const gain = ctx.createGain();
      gain.gain.value = 0.05;
      oscillator = ctx.createOscillator();
      oscillator.frequency.value = 997;
      oscillator.connect(gain).connect(destination);
      playback = new Audio();
      playback.srcObject = destination.stream;
      await playback.setSinkId(sink.deviceId);
      await playback.play();
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      const amplitude = () => {
        analyser.getFloatFrequencyData(spectrum);
        const bin = Math.round((997 * analyser.fftSize) / ctx.sampleRate);
        return Math.max(...spectrum.slice(bin - 2, bin + 3));
      };
      await new Promise((resolve) => setTimeout(resolve, 500));
      const before = amplitude();
      oscillator.start();
      let peak = -Infinity;
      for (let i = 0; i < 12; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        peak = Math.max(peak, amplitude());
      }
      return {
        input: source.label,
        output: sink.label,
        contextState: ctx.state,
        contextTime: ctx.currentTime,
        captureMuted: capture.getAudioTracks()[0].muted,
        playbackPaused: playback.paused,
        beforeDB: Number.isFinite(before) ? before : null,
        toneDB: Number.isFinite(peak) ? peak : null,
        passed: peak > -65 && peak > before + 10,
      };
    } finally {
      try {
        oscillator?.stop();
      } catch {
        /* Not started. */
      }
      playback?.pause();
      if (playback) playback.srcObject = null;
      capture?.getTracks().forEach((track) => track.stop());
      await ctx?.close();
    }
  });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.passed, true, 'No test tone received through VB-CABLE.');
} finally {
  await browser?.close();
  await app.close();
}
