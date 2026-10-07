import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceDSP, VOICES, VOICE_PRESETS } from '../html/dist/voice-dsp.js';

function peakFrequency(samples, rate, min = 200, max = 800) {
  let peak = 0,
    frequency = 0;
  for (let hz = min; hz <= max; hz += 2) {
    const coefficient = 2 * Math.cos((2 * Math.PI * hz) / rate);
    let first = 0,
      second = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i] + coefficient * first - second;
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
}
for (const rate of [44100, 48000]) {
  test(`voice effects produce the expected spectrum at ${rate} Hz`, () => {
    for (const name of VOICES) {
      const dsp = new VoiceDSP(rate);
      dsp.setVoice(name);
      const output = new Float32Array(rate);
      for (let i = 0; i < rate * 2; i++) {
        const input = 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate),
          value = dsp.process(input);
        assert.ok(Number.isFinite(value) && Math.abs(value) <= 0.301);
        if (name === 'original') assert.equal(value, input);
        if (i >= rate) output[i - rate] = value;
      }
      const peak = peakFrequency(output, rate);
      if (name === 'original') assert.ok(Math.abs(peak - 440) <= 2);
      if (name === 'deep')
        assert.ok(Math.abs(peak - 440 * 2 ** (-5 / 12)) < 15, `deep peak: ${peak}`);
      if (name === 'cartoon')
        assert.ok(Math.abs(peak - 440 * 2 ** (7 / 12)) < 15, `cartoon peak: ${peak}`);
      if (name === 'robot')
        assert.ok(Math.min(Math.abs(peak - 370), Math.abs(peak - 510)) <= 2, `robot peak: ${peak}`);
      if (['warm', 'bright', 'giant'].includes(name)) {
        const preset = VOICE_PRESETS.find((preset) => preset.id === name);
        assert.ok(
          Math.abs(peak - 440 * 2 ** (preset.semitones / 12)) < 15,
          `${name} peak: ${peak}`,
        );
      }
      if (name === 'alien') {
        const shifted = 440 * 2 ** (5 / 12);
        assert.ok(Math.min(Math.abs(peak - shifted - 35), Math.abs(peak - shifted + 35)) < 15);
      }
    }
  });
}
test('effect changes remain bounded; bypass returns to original; silence drains the delay buffer', () => {
  const rate = 48000,
    dsp = new VoiceDSP(rate);
  let previous = 0;
  for (let i = 0; i < rate * 3; i++) {
    if (i % 2400 === 0) dsp.setVoice(VOICES[(i / 2400) % VOICES.length]);
    const output = dsp.process(0.3 * Math.sin((2 * Math.PI * 440 * i) / rate));
    assert.ok(Math.abs(output - previous) < 0.1, 'abrupt switching transient');
    previous = output;
  }
  dsp.setVoice('original');
  for (let i = 0; i < rate; i++) dsp.process(0.2);
  assert.ok(Math.abs(dsp.process(0.2) - 0.2) < 1e-10);
  dsp.setVoice('deep');
  for (let i = 0; i < rate; i++) dsp.process(0);
  assert.equal(dsp.process(0), 0);
  assert.throws(() => dsp.setVoice('unknown'));
});
