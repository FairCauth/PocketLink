import { friendlyError } from './audio-engine.js';

export function setupSoundSettings(engine) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('settings-dialog');
  const inputs = [$('noise-suppression'), $('echo-cancellation')];
  const player = new Audio();
  player.preload = 'auto';
  let busy = false;
  let capturing = false;
  let generation = 0;
  let timer;
  let frame;
  let analyser;
  let meteredNode;
  let captures = [];
  let urls = [];
  try {
    const saved = JSON.parse(localStorage.getItem('pocketlink-audio-settings'));
    for (const key of ['noiseSuppression', 'echoCancellation'])
      if (typeof saved?.[key] === 'boolean') engine.options[key] = saved[key];
  } catch {
    /* Private browsing/storage restrictions use the defaults. */
  }
  inputs[0].checked = engine.options.noiseSuppression;
  inputs[1].checked = engine.options.echoCancellation;

  function update() {
    const status = engine.processingStatus();
    $('noise-status').textContent = !status.active
      ? engine.options.noiseSuppression
        ? '连接后启用 · 本地处理'
        : '已关闭'
      : status.noise === 'ai'
        ? 'RNNoise · 本地处理'
        : status.noise === 'loading'
          ? '正在准备 AI 降噪…'
          : status.noise === 'browser'
            ? status.browserNoise === true
              ? 'AI 不可用 · 已切换浏览器降噪'
              : status.browserNoise === false
                ? 'AI 不可用 · 浏览器降噪未启用'
                : 'AI 不可用 · 浏览器未报告降噪状态'
            : status.browserNoise === true
              ? 'AI 已关闭 · 系统仍在降噪'
              : '已关闭';
    $('echo-status').textContent = !status.active
      ? engine.options.echoCancellation
        ? '连接后启用'
        : '已关闭'
      : status.echo === true || typeof status.echo === 'string'
        ? engine.options.echoCancellation
          ? '已启用 · 浏览器处理'
          : '系统仍在处理回声'
        : status.echo === false
          ? engine.options.echoCancellation
            ? '当前设备未启用回声消除'
            : '已关闭'
          : '浏览器未报告生效状态';
    inputs.forEach((input) => (input.disabled = busy || capturing));
    $('noise-preview').disabled =
      engine.state !== 'on' || busy || capturing || status.noise === 'loading';
    $('noise-preview').textContent = capturing ? '录制中…' : urls.length ? '重新录制' : '听效果';
    $('preview-controls').hidden = !urls.length;
  }
  function stopPlayback() {
    player.pause();
    player.removeAttribute('src');
    player.load();
    engine.setPreviewing(false);
    for (const id of ['preview-before', 'preview-after'])
      $(id).setAttribute('aria-pressed', 'false');
  }
  function clearPreview() {
    ++generation;
    clearTimeout(timer);
    stopPlayback();
    for (const capture of captures) {
      capture.recorder.onstop = null;
      capture.recorder.ondataavailable = null;
      capture.recorder.onerror = null;
      if (capture.recorder.state !== 'inactive') capture.recorder.stop();
      try {
        capture.source.disconnect(capture.destination);
      } catch {
        /* Engine may have stopped. */
      }
      capture.destination.stream.getTracks().forEach((track) => track.stop());
    }
    captures = [];
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls = [];
    capturing = false;
    update();
  }
  function failPreview(error) {
    clearPreview();
    $('preview-status').textContent = friendlyError(error);
  }
  async function updateOptions() {
    const previous = { ...engine.options };
    clearPreview();
    busy = true;
    update();
    $('settings-message').hidden = true;
    try {
      await engine.setOptions({
        noiseSuppression: inputs[0].checked,
        echoCancellation: inputs[1].checked,
      });
      try {
        localStorage.setItem('pocketlink-audio-settings', JSON.stringify(engine.options));
      } catch {
        /* Optional. */
      }
    } catch (error) {
      inputs[0].checked = previous.noiseSuppression;
      inputs[1].checked = previous.echoCancellation;
      engine.options = previous;
      $('settings-message').textContent = friendlyError(error);
      $('settings-message').hidden = false;
    } finally {
      busy = false;
      update();
    }
  }
  inputs.forEach((input) => input.addEventListener('change', updateOptions));
  $('noise-preview').addEventListener('click', async () => {
    clearPreview();
    const request = generation;
    capturing = true;
    update();
    $('preview-status').textContent = '请说话，正在录制 4 秒…';
    try {
      if (!window.MediaRecorder) throw new Error('此浏览器不支持试听录音。');
      await engine.resume();
      if (request !== generation || engine.state !== 'on') return;
      const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const results = [engine.source, engine.micInput].map((source) => {
        const destination = engine.context.createMediaStreamDestination();
        source.connect(destination);
        let recorder;
        try {
          recorder = new MediaRecorder(destination.stream, mimeType ? { mimeType } : undefined);
        } catch (error) {
          source.disconnect(destination);
          destination.stream.getTracks().forEach((track) => track.stop());
          throw error;
        }
        const capture = { source, destination, recorder };
        captures.push(capture);
        return new Promise((resolve, reject) => {
          const chunks = [];
          recorder.ondataavailable = ({ data }) => {
            if (data.size) chunks.push(data);
          };
          recorder.onerror = () => reject(new Error('试听录音失败，请重试。'));
          recorder.onstop = () => {
            try {
              source.disconnect(destination);
            } catch {
              /* Already stopped. */
            }
            destination.stream.getTracks().forEach((track) => track.stop());
            const blob = new Blob(chunks, { type: recorder.mimeType });
            if (!blob.size) reject(new Error('未录到声音，请重试。'));
            else resolve(blob);
          };
          recorder.start();
        });
      });
      timer = setTimeout(
        () =>
          captures.forEach(({ recorder }) => {
            if (recorder.state !== 'inactive') recorder.stop();
          }),
        4000,
      );
      const blobs = await Promise.all(results);
      if (request !== generation) return;
      captures = [];
      urls = blobs.map((blob) => URL.createObjectURL(blob));
      capturing = false;
      $('preview-status').textContent = '点击对比；回放时暂停发送麦克风，避免回声。';
      $('preview-after').textContent = engine.noiseMode === 'ai' ? '降噪后' : '当前处理';
      update();
    } catch (error) {
      if (request === generation) failPreview(error);
    }
  });
  for (const [index, id] of ['preview-before', 'preview-after'].entries()) {
    $(id).addEventListener('click', async () => {
      stopPlayback();
      if (!urls[index] || engine.state !== 'on') return;
      engine.stopSound();
      engine.setPreviewing(true);
      player.src = urls[index];
      $(id).setAttribute('aria-pressed', 'true');
      try {
        await player.play();
      } catch (error) {
        if (error.name !== 'AbortError') failPreview(error);
      }
    });
  }
  player.addEventListener('ended', stopPlayback);
  player.addEventListener('error', () => {
    if (player.hasAttribute('src')) failPreview(new Error('无法回放，请重新录制。'));
  });
  $('preview-stop').addEventListener('click', stopPlayback);
  function stopMeter() {
    cancelAnimationFrame(frame);
    try {
      if (analyser) meteredNode?.disconnect(analyser);
    } catch {
      /* Engine stopped. */
    }
    analyser?.disconnect();
    analyser = null;
    meteredNode = null;
    $('noise-meter').value = 0;
  }
  function meter() {
    stopMeter();
    if (!dialog.open || !engine.micInput || engine.state !== 'on') return;
    meteredNode = engine.micInput;
    analyser = engine.context.createAnalyser();
    analyser.fftSize = 512;
    meteredNode.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
      $('noise-meter').value = Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-8) + 60) / 60));
      frame = requestAnimationFrame(tick);
    };
    tick();
  }
  new MutationObserver(meter).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  dialog.addEventListener('close', () => {
    clearPreview();
    stopMeter();
    $('preview-status').textContent = '连接后可录制 4 秒，对比降噪效果。';
  });
  engine.addEventListener('processing', update);
  engine.addEventListener('state', () => {
    if (engine.state !== 'on') clearPreview();
    update();
    meter();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearPreview();
      stopMeter();
    } else meter();
  });
  update();
}
