import { VoiceDSP, VOICES } from './voice-dsp.js';

class PocketVoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.effect = new VoiceDSP(sampleRate);
    this.port.onmessage = ({ data }) => {
      if (data?.stop) this.stopped = true;
      if (VOICES.includes(data?.voice)) this.effect.setVoice(data.voice);
    };
  }
  process(inputs, outputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0],
      output = outputs[0][0];
    for (let i = 0; i < output.length; i++) output[i] = this.effect.process(input?.[i] || 0);
    return true;
  }
}
registerProcessor('pocketlink-voice', PocketVoiceProcessor);
