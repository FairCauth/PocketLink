export const VOICES = ['original', 'deep', 'cartoon', 'robot'];

// Two overlapping, windowed delay taps change pitch without changing duration.
// Keep this processor independent of browser globals so its audio can be tested.
export class VoiceDSP {
  constructor(rate) {
    this.rate = rate;
    this.span = rate * 0.06;
    this.baseDelay = rate * 0.008;
    this.buffer = new Float32Array(Math.ceil(rate * 0.1));
    this.write = 0;
    this.lowPhase = 0;
    this.highPhase = 0;
    this.robotPhase = 0;
    this.lowStep = (1 - 2 ** (-5 / 12)) / this.span;
    this.highStep = (1 - 2 ** (7 / 12)) / this.span;
    this.weights = new Float64Array([1, 0, 0, 0]);
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
    const low = this.shifted(this.lowPhase),
      high = this.shifted(this.highPhase);
    const robot = sample * (0.1 + 0.9 * Math.sin(this.robotPhase));
    this.lowPhase = (this.lowPhase + this.lowStep + 1) % 1;
    this.highPhase = (this.highPhase + this.highStep + 1) % 1;
    this.robotPhase = (this.robotPhase + (2 * Math.PI * 70) / this.rate) % (2 * Math.PI);
    for (let i = 0; i < 4; i++)
      this.weights[i] += ((i === this.selected ? 1 : 0) - this.weights[i]) * this.smoothing;
    const output =
      sample * this.weights[0] +
      low * this.weights[1] +
      high * this.weights[2] +
      robot * this.weights[3];
    this.write = (this.write + 1) % this.buffer.length;
    return output;
  }
}
