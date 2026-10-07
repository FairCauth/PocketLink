// Sound files stay on the computer; the phone sends only catalog IDs.
export function setupSoundboard(controller) {
  const panel = document.getElementById('soundboard');
  const list = document.getElementById('sound-list');
  const status = document.getElementById('sound-status');
  const stop = document.getElementById('stop-sound');
  const buttons = new Map();
  function update() {
    for (const [id, button] of buttons) {
      const active = controller.sound?.id === id;
      button.disabled = controller.state !== 'on';
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', `${active ? '停止' : '播放'}${button.dataset.name}`);
      button.querySelector('span').textContent = active ? '■' : '▶';
    }
    stop.hidden = !controller.sound;
    stop.disabled = controller.state !== 'on';
    status.textContent = controller.sound
      ? `${controller.sound.loading ? '正在加载' : '正在播放'}：${controller.sound.name}`
      : '';
  }
  function render() {
    buttons.clear();
    list.replaceChildren();
    for (const sound of controller.sounds) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sound-button';
      button.dataset.name = sound.name;
      const glyph = document.createElement('span');
      glyph.setAttribute('aria-hidden', 'true');
      const label = document.createElement('strong');
      label.textContent = sound.name;
      button.append(glyph, label);
      button.addEventListener('click', () => {
        try {
          if (controller.sound?.id === sound.id) controller.stopSound();
          else controller.playSound(sound);
        } catch (error) {
          status.textContent = error.message;
        }
      });
      buttons.set(sound.id, button);
      list.append(button);
    }
    panel.hidden = !buttons.size;
    update();
  }
  stop.addEventListener('click', () => {
    try {
      controller.stopSound();
    } catch (error) {
      status.textContent = error.message;
    }
  });
  controller.addEventListener('catalog', render);
  controller.addEventListener('sound', update);
  controller.addEventListener('state', update);
  controller.addEventListener('sound-error', (e) => {
    status.textContent = e.detail.message;
  });
  return { load: () => controller.load() };
}
