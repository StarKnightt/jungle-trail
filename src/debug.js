const formatCount = (value) => {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}m`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
};

const browserName = () => {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Unknown browser';
};

const platformName = () => {
  const platform = navigator.userAgentData?.platform || navigator.platform || 'Unknown';
  const mobile = navigator.userAgentData?.mobile ? ' mobile' : '';
  return `${platform}${mobile}`;
};

function gpuDetails(renderer) {
  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER),
    vendor: debug
      ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
      : gl.getParameter(gl.VENDOR),
    webgl: gl.getParameter(gl.VERSION),
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
}

export class DebugOverlay {
  constructor(game) {
    this.game = game;
    this.expanded = true;
    this.rows = new Map();
    this.gpu = gpuDetails(game.renderer);

    this.root = document.createElement('aside');
    this.root.id = 'debug-overlay';
    this.root.className = 'debug-overlay';
    this.root.setAttribute('aria-label', 'Performance debug overlay');

    const header = document.createElement('button');
    header.className = 'debug-overlay__header';
    header.type = 'button';
    header.setAttribute('aria-expanded', 'true');
    header.title = 'Collapse debug overlay (F3)';

    const title = document.createElement('span');
    title.className = 'debug-overlay__title';
    title.textContent = 'Debug';

    this.summary = document.createElement('span');
    this.summary.className = 'debug-overlay__summary';

    this.chevron = document.createElement('span');
    this.chevron.className = 'debug-overlay__chevron';
    this.chevron.setAttribute('aria-hidden', 'true');
    this.chevron.textContent = '−';

    header.append(title, this.summary, this.chevron);

    this.body = document.createElement('div');
    this.body.className = 'debug-overlay__body';
    this.addSection('Performance', [
      ['fps', 'FPS'],
      ['frame', 'CPU frame'],
      ['draws', 'Scene draws'],
      ['triangles', 'Triangles'],
    ]);
    this.addSection('Renderer', [
      ['tier', 'Quality'],
      ['resolution', 'Resolution'],
      ['resources', 'GPU resources'],
      ['gpu', 'GPU'],
      ['graphics', 'Graphics API'],
    ]);
    this.addSection('System', [
      ['platform', 'Platform'],
      ['browser', 'Browser'],
      ['hardware', 'Hardware'],
    ]);

    this.root.append(header, this.body);
    document.body.append(this.root);

    this._toggle = () => this.setExpanded(!this.expanded);
    this._key = (event) => {
      if (event.code !== 'F3') return;
      event.preventDefault();
      this._toggle();
    };
    header.addEventListener('click', this._toggle);
    window.addEventListener('keydown', this._key);
    this.header = header;

    this.update();
    this._timer = window.setInterval(() => this.update(), 250);
  }

  addSection(title, rows) {
    const section = document.createElement('section');
    section.className = 'debug-overlay__section';

    const heading = document.createElement('h2');
    heading.textContent = title;
    section.append(heading);

    for (const [key, label] of rows) {
      const row = document.createElement('div');
      row.className = 'debug-overlay__row';
      const name = document.createElement('span');
      name.textContent = label;
      const value = document.createElement('output');
      value.textContent = '—';
      row.append(name, value);
      section.append(row);
      this.rows.set(key, value);
    }
    this.body.append(section);
  }

  setExpanded(expanded) {
    this.expanded = expanded;
    this.root.classList.toggle('is-collapsed', !expanded);
    this.header.setAttribute('aria-expanded', String(expanded));
    this.header.title = `${expanded ? 'Collapse' : 'Expand'} debug overlay (F3)`;
    this.chevron.textContent = expanded ? '−' : '+';
  }

  set(key, value, title = '') {
    const row = this.rows.get(key);
    if (!row) return;
    row.textContent = value;
    row.title = title || value;
  }

  update() {
    const { game } = this;
    const info = game.info();
    const renderer = game.renderer;
    const canvas = renderer.domElement;
    const fps = game.fps || 0;

    this.summary.textContent = `${fps.toFixed(0)} FPS`;
    this.set('fps', fps ? fps.toFixed(1) : '—');
    this.set('frame', game.frameMs ? `${game.frameMs.toFixed(2)} ms` : '—');
    this.set('draws', formatCount(info.calls));
    this.set('triangles', formatCount(info.triangles), `${info.triangles.toLocaleString()} triangles`);
    this.set('tier', `${game.tier} · ${game.frameCap} fps cap`);
    this.set(
      'resolution',
      `${canvas.width} × ${canvas.height} · ${renderer.getPixelRatio().toFixed(2)} dpr`,
    );
    this.set(
      'resources',
      `${info.geometries} geo · ${info.textures} tex · ${info.programs} programs`,
    );
    this.set('gpu', this.gpu.renderer, `${this.gpu.vendor} · ${this.gpu.renderer}`);
    this.set(
      'graphics',
      `${this.gpu.webgl.replace('WebGL ', '')} · ${this.gpu.maxTexture}px max texture`,
    );
    this.set('platform', platformName());
    this.set('browser', browserName(), navigator.userAgent);

    const cores = navigator.hardwareConcurrency
      ? `${navigator.hardwareConcurrency} logical cores`
      : 'core count unavailable';
    const memory = navigator.deviceMemory ? ` · ${navigator.deviceMemory} GB memory` : '';
    this.set('hardware', cores + memory);
  }

  dispose() {
    clearInterval(this._timer);
    window.removeEventListener('keydown', this._key);
    this.header.removeEventListener('click', this._toggle);
    this.root.remove();
  }
}
