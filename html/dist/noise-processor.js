// Local RNNoise assets; no microphone data leaves the browser for processing.
export async function createNoiseProcessor(context, signal) {
  if (!context.audioWorklet || !window.AudioWorkletNode || context.sampleRate !== 48000)
    throw new Error('AudioWorklet at 48 kHz is unavailable');
  const response = await fetch(new URL('./vendor/rnnoise/rnnoise.wasm', import.meta.url), {
    signal,
  });
  if (!response.ok) throw new Error('RNNoise could not be loaded');
  const wasmBinary = await response.arrayBuffer();
  await new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    context.audioWorklet
      .addModule(new URL('./vendor/rnnoise/worklet.js', import.meta.url))
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  const node = new AudioWorkletNode(context, '@sapphi-red/web-noise-suppressor/rnnoise', {
    channelCount: 1,
    channelCountMode: 'explicit',
    outputChannelCount: [1],
    processorOptions: { maxChannels: 1, wasmBinary },
  });
  const destroy = () => {
    node.disconnect();
    node.port.postMessage('destroy');
    node.port.close();
  };
  try {
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        node.removeEventListener('processorerror', failure);
        node.port.onmessage = null;
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
      const failure = () => finish(new Error('RNNoise initialization failed'));
      const timer = setTimeout(() => finish(new Error('RNNoise initialization timed out')), 8000);
      signal.addEventListener('abort', abort, { once: true });
      node.addEventListener('processorerror', failure, { once: true });
      node.port.onmessage = ({ data }) => {
        if (data === 'ready') finish();
        else if (data === 'error') finish(new Error('RNNoise initialization failed'));
      };
    });
    return { node, destroy };
  } catch (error) {
    destroy();
    throw error;
  }
}
