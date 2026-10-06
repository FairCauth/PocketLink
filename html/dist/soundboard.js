export function setupSoundboard(engine) {
  const panel = document.getElementById('soundboard');
  const list = document.getElementById('sound-list');
  const status = document.getElementById('sound-status');
  const stop = document.getElementById('stop-sound');
  const buttons = new Map();
  let loadRequest = 0;

  function update() {
    for (const [id, button] of buttons) {
      const active = engine.sound?.id === id;
      button.disabled = engine.state !== 'on';
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', `${active ? '停止' : '播放'}${button.dataset.name}`);
      button.querySelector('span').textContent = active ? '■' : '▶';
    }
    stop.hidden = !engine.sound;
    status.textContent = engine.sound
      ? `${engine.sound.loading ? '正在加载' : '正在播放'}：${engine.sound.name}`
      : '';
  }

  async function load() {
    const request = ++loadRequest;
    try {
      const response = await fetch('/sounds/index.json', { cache: 'no-store' });
      if (response.status === 404) {
        panel.hidden = true;
        return;
      }
      if (!response.ok) throw new Error('音效列表加载失败');
      const data = await response.json();
      if (request !== loadRequest) return;
      if (!Array.isArray(data.sounds)) throw new Error('音效列表格式有误');
      buttons.clear();
      list.replaceChildren();
      for (const sound of data.sounds.slice(0, 50)) {
        if (
          typeof sound.id !== 'string' ||
          typeof sound.name !== 'string' ||
          !/^\/sounds\/[a-f0-9]{64}\.(mp3|wav|m4a)$/.test(sound.url) ||
          buttons.has(sound.id)
        )
          continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sound-button';
        button.dataset.name = sound.name;
        const glyph = document.createElement('span');
        glyph.setAttribute('aria-hidden', 'true');
        const label = document.createElement('strong');
        label.textContent = sound.name;
        button.append(glyph, label);
        button.addEventListener('click', async () => {
          if (engine.sound?.id === sound.id) {
            engine.stopSound();
            return;
          }
          try {
            await engine.playSound(sound);
          } catch (error) {
            status.textContent = error.message || '音效播放失败，请重试。';
          }
        });
        buttons.set(sound.id, button);
        list.append(button);
      }
      panel.hidden = !buttons.size;
      update();
    } catch {
      panel.hidden = false;
      status.textContent = '音效列表加载失败，请刷新页面重试。';
    }
  }
  stop.addEventListener('click', () => engine.stopSound());
  engine.addEventListener('sound', update);
  engine.addEventListener('state', update);
  return { load };
}
