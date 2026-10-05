import { AudioEngine } from '/audio-engine.js';
import { AudioLink } from '/connection.js';
const result = document.getElementById('result');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function event(target, type, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const handler = (e) => {
      if (predicate(e.detail)) {
        clearTimeout(timer);
        target.removeEventListener(type, handler);
        resolve(e.detail);
      }
    };
    const timer = setTimeout(() => {
      target.removeEventListener(type, handler);
      reject(new Error(`${type} timeout`));
    }, 15000);
    target.addEventListener(type, handler);
  });
}
document.getElementById('run').onclick = async () => {
  document.getElementById('run').disabled = true;
  result.textContent = 'RUNNING\n';
  const log = (text) => {
    result.textContent += text + '\n';
  };
  const synth = new AudioContext();
  await synth.resume();
  const oscillator = synth.createOscillator();
  const volume = synth.createGain();
  volume.gain.value = 0.2;
  const destination = synth.createMediaStreamDestination();
  oscillator.connect(volume).connect(destination);
  oscillator.start();
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async () => destination.stream;
  const engine = new AudioEngine(),
    receiver = new AudioLink(),
    sender = new AudioLink();
  const remoteContext = new AudioContext();
  await remoteContext.resume();
  const playback = document.createElement('audio');
  playback.volume = 0;
  document.body.append(playback);
  try {
    await engine.start();
    if (engine.state !== 'on') throw new Error('Mic graph not running');
    log('PASS audio capture graph (synthetic input)');
    const codePromise = event(receiver, 'code');
    await receiver.open({ role: 'receiver' });
    const { code } = await codePromise;
    const connected = event(sender, 'status', (d) => d.status === 'connected');
    const streamPromise = event(receiver, 'stream');
    await sender.open({ role: 'sender', code, mode: 'lan', stream: engine.stream });
    const { stream } = await streamPromise;
    await connected;
    log('PASS WebRTC negotiation + connection');
    playback.srcObject = stream;
    await playback.play();
    const analyser = remoteContext.createAnalyser();
    remoteContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    log(
      `Audio contexts: source=${synth.state}, capture=${engine.context.state}, receiver=${remoteContext.state}`,
    );
    function rms() {
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
    }
    let peak = 0;
    for (let i = 0; i < 12; i++) {
      await sleep(200);
      peak = Math.max(peak, rms());
    }
    if (peak < 0.01) throw new Error(`No received audio: ${peak}`);
    log(`PASS actual received audio RMS ${peak.toFixed(4)}`);
    engine.setMuted(true);
    await sleep(800);
    if (rms() > 0.005) throw new Error('Mute did not silence transmitted audio');
    log('PASS mute affects transmitted audio');
    engine.setMuted(false);
    engine.setGain(0.25);
    await sleep(800);
    const reduced = rms();
    if (reduced >= peak * 0.6 || reduced < 0.001) throw new Error(`Gain not applied: ${reduced}`);
    log('PASS gain affects transmitted audio');
    const recorded = event(engine, 'recorded');
    engine.startRecording();
    await sleep(1400);
    engine.stopRecording();
    const recording = await recorded;
    if (recording.blob.size < 100) throw new Error('Empty recording');
    log(`PASS MediaRecorder: ${recording.mime}, ${recording.blob.size} bytes`);
    const gone = event(receiver, 'status', (d) => d.status === 'waiting');
    sender.close();
    await gone;
    log('PASS peer disconnect restores pairing');
    await engine.stop();
    if (destination.stream.getTracks().some((t) => t.readyState !== 'ended'))
      throw new Error('Capture not released');
    log('PASS stop releases microphone tracks');
    log('ALL PASS');
  } catch (error) {
    log('FAIL ' + error.stack);
  } finally {
    playback.pause();
    playback.srcObject = null;
    playback.remove();
    sender.close();
    receiver.close();
    await engine.stop();
    navigator.mediaDevices.getUserMedia = original;
    oscillator.stop();
    await synth.close();
    await remoteContext.close();
    document.getElementById('run').disabled = false;
  }
};
