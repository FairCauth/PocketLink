export const VOICE_PRESETS = [
  { id: 'original', name: '原声', semitones: 0 },
  { id: 'deep', name: '低沉', semitones: -5 },
  { id: 'cartoon', name: '卡通', semitones: 7 },
  { id: 'robot', name: '机器人', semitones: 0, modulation: 70 },
  { id: 'warm', name: '磁性', semitones: -3 },
  { id: 'bright', name: '清亮', semitones: 3 },
  { id: 'giant', name: '巨人', semitones: -9 },
  { id: 'alien', name: '外星人', semitones: 5, modulation: 35 },
];
export const VOICES = VOICE_PRESETS.map(({ id }) => id);

// Two overlapping, windowed delay taps change pitch without changing duration.
// Keep this processor independent of browser globals so its audio can be tested.
export class VoiceDSP {
  constructor(rate) {
    this.rate = rate;
    this.span = rate * 0.06;
    this.baseDelay = rate * 0.008;
    this.buffer = new Float32Array(Math.ceil(rate * 0.1));
    this.write = 0;
    this.phases = new Float64Array(VOICES.length);
    this.modulationPhases = new Float64Array(VOICES.length);
    this.steps = VOICE_PRESETS.map(({ semitones }) => (1 - 2 ** (semitones / 12)) / this.span);
    this.weights = new Float64Array(VOICES.length);
    this.weights[0] = 1;
    this.smoothing = 1 - Math.exp(-1 / (rate * 0.012));
    this.selected = 0;
  }
  setVoice(name) {
    const index = VOICES.indexOf(name);
    if (index < 0) throw new Error('Unknown voice');
    this.selected = index;
  }
  read(delay) {
    let position = this.write - delay;
    if (position < 0) position += this.buffer.length;
    const left = Math.floor(position),
      fraction = position - left;
    return (
      this.buffer[left] * (1 - fraction) + this.buffer[(left + 1) % this.buffer.length] * fraction
    );
  }
  shifted(phase) {
    const other = (phase + 0.5) % 1;
    const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
    return (
      this.read(this.baseDelay + phase * this.span) * weight +
      this.read(this.baseDelay + other * this.span) * (1 - weight)
    );
  }
  process(sample) {
    this.buffer[this.write] = sample;
    let output = 0;
    for (let i = 0; i < VOICES.length; i++) {
      const target = i === this.selected ? 1 : 0;
      this.weights[i] += (target - this.weights[i]) * this.smoothing;
      if (Math.abs(this.weights[i] - target) < 1e-12) this.weights[i] = target;
      // Only evaluate audible presets; no allocation in the audio callback.
      if (!this.weights[i]) continue;
      const preset = VOICE_PRESETS[i];
      let value = preset.semitones ? this.shifted(this.phases[i]) : sample;
      this.phases[i] = (this.phases[i] + this.steps[i] + 1) % 1;
      if (preset.modulation) {
        value *= 0.1 + 0.9 * Math.sin(this.modulationPhases[i]);
        this.modulationPhases[i] =
          (this.modulationPhases[i] + (2 * Math.PI * preset.modulation) / this.rate) %
          (2 * Math.PI);
      }
      output += value * this.weights[i];
    }
    this.write = (this.write + 1) % this.buffer.length;
    return output;
  }
}
