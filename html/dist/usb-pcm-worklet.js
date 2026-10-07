// Bounded mono PCM queue, resampled to the receiver clock. Underruns output silence.
class USBPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(65536);
    this.read = 0;
    this.write = 0;
    this.rate = 48000;
    this.playing = false;
    this.port.onmessage = ({ data }) => {
      if (data.stop) {
        this.stopped = true;
        return;
      }
      const bytes = new DataView(data);
      if (bytes.byteLength < 7 || bytes.getUint8(0) !== 2) return;
      const rate = bytes.getUint32(1, true);
      if (rate !== this.rate) {
        this.read = this.write = 0;
        this.playing = false;
      }
      this.rate = rate;
      for (let i = 5; i + 1 < bytes.byteLength; i += 2) {
        this.samples[this.write++ % this.samples.length] = bytes.getInt16(i, true) / 32768;
      }
      if (this.write - this.read > rate * 0.12) this.read = this.write - rate * 0.04;
      if (!this.playing && this.write - this.read >= rate * 0.03) this.playing = true;
    };
  }
  process(inputs, outputs) {
    if (this.stopped) return false;
    const out = outputs[0][0];
    const step = this.rate / sampleRate;
    for (let i = 0; i < out.length; i++) {
      if (!this.playing || this.read + 1 >= this.write) {
        this.playing = false;
        break;
      }
      const index = Math.floor(this.read),
        fraction = this.read - index;
      const a = this.samples[index % this.samples.length];
      const b = this.samples[(index + 1) % this.samples.length];
      out[i] = a + (b - a) * fraction;
      this.read += step;
    }
    return true;
  }
}
registerProcessor('pocketlink-usb-pcm', USBPCM);
