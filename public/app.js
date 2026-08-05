/* BUSY Web OS portal — vanilla JS hash router */

const app = document.getElementById('app');

// Official BUSY wordmark (fill="currentColor", tinted by CSS)
fetch('/busy-logo.svg')
  .then((res) => res.text())
  .then((svg) => { document.getElementById('logo-svg').innerHTML = svg; })
  .catch(() => { document.getElementById('logo-svg').textContent = 'BUSY'; });

// --- Helpers ---

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const STATE_LABELS = { running: 'Running', stopped: 'Stopped', error: 'Error' };

// --- Launch modal (widgets with a launchSchema ask for values on Start) ---

function selectHtml(key, field, current) {
  return `<select name="${esc(key)}">${(field.options || []).map((o) =>
    `<option value="${esc(o.value)}" ${o.value === String(current) ? 'selected' : ''}>${esc(o.label || o.value)}</option>`
  ).join('')}</select>`;
}

function promptLaunchValues(widget) {
  return new Promise((resolve) => {
    const schema = widget.launchSchema || {};
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <form class="panel modal">
        <h2 style="margin-top: 0;">Start ${esc(widget.title)}</h2>
        ${Object.entries(schema).map(([key, field]) => {
          const label = `${esc(field.label || key)}${field.required ? ' <span class="required">*</span>' : ''}`;
          if (field.type === 'select') {
            return `<div class="field"><label>${label}</label>${selectHtml(key, field, field.default ?? '')}</div>`;
          }
          const placeholder = field.default !== undefined ? `default: ${esc(field.default)}` : '';
          const inputType = field.type === 'number' ? 'number' : 'text';
          return `<div class="field"><label>${label}</label>
            <input type="${inputType}" name="${esc(key)}" placeholder="${placeholder}"
              ${field.type === 'number' ? 'step="any"' : ''} autocomplete="off" /></div>`;
        }).join('')}
        <div class="form-actions">
          <button class="primary" type="submit">Start</button>
          <button type="button" data-cancel>Cancel</button>
        </div>
      </form>
    `;

    const close = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    overlay.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    overlay.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const values = {};
      for (const key of Object.keys(schema)) {
        const raw = overlay.querySelector(`[name="${key}"]`).value;
        if (raw !== '') values[key] = raw;
      }
      close(values);
    });

    document.body.appendChild(overlay);
    const first = overlay.querySelector('input');
    if (first) first.focus();
  });
}

// --- Device status polling (sidebar) ---

async function pollDevice() {
  const statusEl = document.getElementById('device-status');
  try {
    const status = await api('GET', '/api/device/status');
    const power = status.power || {};
    const battery = power.battery_charge != null ? ` · ${power.battery_charge}%` : '';
    statusEl.innerHTML = `<span class="dot online"></span> Device online${battery}`;
  } catch {
    statusEl.innerHTML = '<span class="dot offline"></span> <a href="#/settings">Device offline</a>';
    document.getElementById('preview-wrap').classList.add('hidden');
  }
}
setInterval(pollDevice, 5000);
pollDevice();

// Real-time screen preview: the server pushes a frame whenever the screen changes
function connectScreenStream() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/screen`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type !== 'screen') return;
    const src = `data:image/bmp;base64,${msg.bmp}`;
    document.getElementById('screen-preview').src = src;
    document.getElementById('screen-preview-full').src = src;
    document.getElementById('preview-wrap').classList.remove('hidden');
  };
  ws.onclose = () => setTimeout(connectScreenStream, 3000);
}
connectScreenStream();

// Full-screen mode for the live preview
const overlay = document.getElementById('preview-overlay');
document.getElementById('preview-expand').addEventListener('click', () => {
  overlay.classList.remove('hidden');
});
overlay.addEventListener('click', () => overlay.classList.add('hidden'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') overlay.classList.add('hidden');
});

// --- Browser sources ---
// Some widgets need data only the browser can capture (mic level today —
// camera, key events, tab audio tomorrow). A widget declares what it consumes
// with `static browserSources = ['microphone']`; the portal renders a capture
// panel per source on the widget's page and streams every payload to
// POST /api/widgets/<id>/message as {source, ...data}. Adding a source =
// adding an entry to this registry; no other portal change needed.
// Capture survives page changes inside the portal; it stops when the tab
// closes, the widget stops, or the user clicks the toggle.
//
// A source implements:
//   title / hint / enableLabel / disableLabel — panel texts
//   liveHtml — markup for its live visualization inside the panel
//   start(emit, live) → cleanup function. Throw a user-readable Error when
//     the capture can't start. `emit(data)` streams to the widget; `live()`
//     returns the panel's live container, or null when not displayed.

/** Requests every browser permission a widget's sources need (install-time gate). */
async function ensureBrowserPermissions(widget) {
  for (const name of (widget && widget.browser_sources) || []) {
    const source = browserSources[name];
    if (source && source.ensurePermission) await source.ensurePermission();
  }
}

const browserSources = {
  microphone: {
    title: 'Microphone',
    hint: 'Sound is captured by this browser tab and streamed to the bar — keep the tab open. Enabling the microphone also starts the widget if needed.',
    enableLabel: '🎤 Enable microphone',
    disableLabel: 'Stop microphone',
    liveHtml: '<div class="mic-meter"><i data-mic-fill></i></div><span class="source-value" data-mic-value></span>',

    /** True when the browser already granted mic access — capture can auto-start. */
    async permissionGranted() {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' });
        return status.state === 'granted';
      } catch {
        return false;
      }
    },

    /** Install-time check: the widget only installs once mic access is granted. */
    async ensurePermission() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone needs a secure context — open the portal via localhost or https');
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        throw new Error('Microphone access denied — allow it in the browser to install this widget');
      }
    },

    async start(emit, live) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone needs a secure context — open the portal via localhost or https');
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch {
        throw new Error('Microphone access denied — allow it in the browser and retry');
      }
      const audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);

      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const dbfs = rms > 0 ? Math.max(20 * Math.log10(rms), -100) : -100;
        emit({ level: dbfs });
        const el = live();
        if (el) {
          const pct = Math.min(Math.max((dbfs + 60) / 60, 0), 1) * 100;
          el.querySelector('[data-mic-fill]').style.width = `${pct}%`;
          el.querySelector('[data-mic-value]').textContent = `${dbfs.toFixed(1)} dBFS`;
        }
      }, 200);

      return () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        audioCtx.close().catch(() => {});
      };
    },
  },

  buzzer: {
    title: 'Buzzer button',
    hint: 'Smash the button (or hit Space) — the bar flashes and makes the noise. Open this page on your phone for a wireless game-show buzzer.',
    enableLabel: '🔴 Arm the buzzer',
    disableLabel: 'Disarm',
    liveHtml: '<button type="button" class="buzzer-btn" data-buzz>BUZZ</button>',

    async start(emit, live) {
      const pulse = () => {
        const btn = live() && live().querySelector('[data-buzz]');
        if (!btn) return;
        btn.classList.add('pressed');
        setTimeout(() => btn.classList.remove('pressed'), 150);
      };
      const press = () => {
        emit({ press: true });
        pulse();
        if (navigator.vibrate) navigator.vibrate(80);
      };
      // Delegated listeners: survive panel re-renders and page navigation
      const onClick = (e) => {
        if (e.target.closest && e.target.closest('[data-buzz]')) press();
      };
      const onKey = (e) => {
        if (e.code === 'Space' && live() && !e.repeat && e.target.tagName !== 'INPUT') {
          e.preventDefault();
          press();
        }
      };
      document.addEventListener('click', onClick);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey);
      };
    },
  },
};

// Running captures: source key → { widgetId, cleanup }
const activeCaptures = new Map();

async function startCapture(key, widgetId) {
  if (activeCaptures.has(key)) return;
  const emit = async (data) => {
    try {
      const res = await fetch(`/api/widgets/${widgetId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: key, ...data }),
      });
      if (res.status === 409) stopCapture(key); // widget no longer running
    } catch {
      // server briefly unreachable — keep trying
    }
  };
  const live = () => document.querySelector(`[data-source-panel="${key}"] .source-live`);
  const cleanup = await browserSources[key].start(emit, live);
  activeCaptures.set(key, { widgetId, cleanup });
  renderSourcePanelStates();
}

function stopCapture(key) {
  const capture = activeCaptures.get(key);
  if (!capture) return;
  activeCaptures.delete(key);
  capture.cleanup();
  renderSourcePanelStates();
}

/** Syncs every source panel currently in the DOM with its capture state. */
function renderSourcePanelStates() {
  document.querySelectorAll('[data-source-panel]').forEach((panel) => {
    const source = browserSources[panel.dataset.sourcePanel];
    const active = activeCaptures.has(panel.dataset.sourcePanel);
    const btn = panel.querySelector('[data-source-toggle]');
    btn.textContent = active ? source.disableLabel : source.enableLabel;
    btn.classList.toggle('primary', !active);
    panel.querySelector('.source-live').style.display = active ? 'flex' : 'none';
  });
}

function sourcePanelsHtml(widget) {
  return (widget.browser_sources || [])
    .filter((key) => browserSources[key])
    .map((key) => {
      const source = browserSources[key];
      return `
        <h2>${esc(source.title)}</h2>
        <div class="panel" data-source-panel="${esc(key)}">
          <p class="hint" style="margin-top: 0;">${esc(source.hint)}</p>
          <div class="source-row">
            <button type="button" data-source-toggle></button>
            <div class="source-live">${source.liveHtml}</div>
          </div>
        </div>
      `;
    }).join('');
}

function mountSourcePanels(widget) {
  document.querySelectorAll('[data-source-panel]').forEach((panel) => {
    const key = panel.dataset.sourcePanel;
    panel.querySelector('[data-source-toggle]').addEventListener('click', async (e) => {
      if (activeCaptures.has(key)) {
        stopCapture(key);
        return;
      }
      e.target.disabled = true;
      try {
        // The capture streams into the running widget — start it first if needed
        const fresh = await api('GET', `/api/widgets/${widget.id}`).catch(() => null);
        if (fresh && fresh.state !== 'running') {
          await api('POST', `/api/widgets/${widget.id}/start`, { launch: {} });
          toast(`${widget.id} started`);
        }
        await startCapture(key, widget.id);
      } catch (err) {
        toast(err.message, true);
      }
      e.target.disabled = false;
      renderSourcePanelStates();
    });
  });
  renderSourcePanelStates();

  // Permission already granted + widget running → capture starts by itself,
  // no pointless "enable" click
  (widget.browser_sources || []).forEach(async (key) => {
    const source = browserSources[key];
    if (!source || activeCaptures.has(key)) return;
    if (widget.state === 'running' && source.permissionGranted && (await source.permissionGranted())) {
      try {
        await startCapture(key, widget.id);
      } catch {
        // stays manual — the toggle button is right there
      }
    }
  });
}

// --- Pages ---

function widgetCardHtml(w, tab) {
  const preview = `
    <div class="bar-frame">
      <div class="bar-screen">
        ${w.has_preview
          ? `<img src="/api/widgets/${w.id}/preview" alt="" />`
          : '<div class="screen-empty">no preview</div>'}
      </div>
    </div>`;
  const tags = (w.tags || []).length
    ? `<div class="tags">${(w.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`
    : '';
  const searchable = [w.id, w.title, w.description, ...(w.tags || [])].join(' ').toLowerCase();
  const open = `<div class="card" data-search="${esc(searchable)}" data-tags="${esc((w.tags || []).join(','))}">`;

  if (tab === 'all') {
    return `${open}
      ${preview}
      <div class="head">
        <h3>${esc(w.title)}</h3>
        ${w.installed ? '<span class="badge installed">Installed</span>' : ''}
      </div>
      <p>${esc(w.description)}</p>
      ${tags}
      <div class="actions">
        ${w.installed
          ? `<button class="danger" data-uninstall="${w.id}">Uninstall</button>`
          : `<button class="primary" data-install="${w.id}">Install</button>`}
        <button data-open="${w.id}">Configure</button>
      </div>
    </div>`;
  }

  return `${open}
    ${preview}
    <div class="head">
      <h3>${esc(w.title)}</h3>
      <span class="badge ${w.state}">${STATE_LABELS[w.state] || w.state}</span>
    </div>
    <p>${esc(w.description)}</p>
    ${w.error ? `<p style="color: var(--red); font-size: 12px;">${esc(w.error)}</p>` : ''}
    ${tags}
    <div class="actions">
      ${w.state === 'running' || w.state === 'error'
        ? `<button data-stop="${w.id}">Stop</button>`
        : ''}
      ${w.state !== 'running'
        ? `<button class="primary" data-start="${w.id}">Start</button>`
        : ''}
      <button data-open="${w.id}">Configure</button>
    </div>
  </div>`;
}

async function renderWidgets(tab = 'installed') {
  const widgets = await api('GET', '/api/widgets');
  const installedCount = widgets.filter((w) => w.installed).length;
  const shown = tab === 'installed' ? widgets.filter((w) => w.installed) : widgets;
  const allTags = [...new Set(shown.flatMap((w) => w.tags || []))].sort();

  app.innerHTML = `
    <h1>Widgets</h1>
    <div class="tabs">
      <a class="tab ${tab === 'installed' ? 'active' : ''}" href="#/widgets">Installed widgets <span class="count">${installedCount}</span></a>
      <a class="tab ${tab === 'all' ? 'active' : ''}" href="#/widgets/all">All widgets <span class="count">${widgets.length}</span></a>
    </div>
    ${shown.length > 0 ? `
      <div class="filter-bar">
        <input id="widget-search" class="search-input" type="search" placeholder="Search widgets…" autocomplete="off" />
        ${allTags.map((t) => `<button class="chip" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>` : ''}
    <div class="grid">
      ${shown.map((w) => widgetCardHtml(w, tab)).join('')}
    </div>
    <p class="empty hidden" id="no-results">No widgets match.</p>
    ${shown.length === 0
      ? (tab === 'installed'
          ? '<p class="empty">No installed widgets yet — pick some in <a href="#/widgets/all">All widgets</a>.</p>'
          : '<p class="empty">No widgets found in widgets/.</p>')
      : ''}
  `;

  // Search + tag filtering (client-side)
  let activeTag = null;
  const searchInput = document.getElementById('widget-search');
  function applyFilters() {
    const query = (searchInput?.value || '').trim().toLowerCase();
    let visible = 0;
    app.querySelectorAll('.grid .card').forEach((card) => {
      const matchesQuery = !query || card.dataset.search.includes(query);
      const matchesTag = !activeTag || card.dataset.tags.split(',').includes(activeTag);
      const show = matchesQuery && matchesTag;
      card.classList.toggle('hidden', !show);
      if (show) visible++;
    });
    const noResults = document.getElementById('no-results');
    if (noResults) noResults.classList.toggle('hidden', visible > 0 || shown.length === 0);
  }
  if (searchInput) searchInput.addEventListener('input', applyFilters);
  app.querySelectorAll('.chip[data-tag]').forEach((chip) =>
    chip.addEventListener('click', () => {
      activeTag = activeTag === chip.dataset.tag ? null : chip.dataset.tag;
      app.querySelectorAll('.chip[data-tag]').forEach((c) =>
        c.classList.toggle('active', c.dataset.tag === activeTag)
      );
      applyFilters();
    })
  );

  // Install / uninstall
  app.querySelectorAll('[data-install]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const id = btn.dataset.install;
      const widget = widgets.find((w) => w.id === id);
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        // Browser permissions first (e.g. microphone), then the server-side
        // install check (required config + the widget's own validation)
        await ensureBrowserPermissions(widget);
        await api('POST', `/api/widgets/${id}/install`);
        toast(`${id} installed`);
        renderWidgets(tab);
      } catch (err) {
        toast(err.message, true);
        btn.textContent = 'Install';
        btn.disabled = false;
        // Missing required config → send the user to the config page to validate it
        if (/Configuration required/i.test(err.message)) location.hash = `#/widget/${id}`;
      }
    })
  );
  app.querySelectorAll('[data-uninstall]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('DELETE', `/api/widgets/${btn.dataset.uninstall}/install`);
        toast(`${btn.dataset.uninstall} uninstalled`);
      } catch (err) {
        toast(err.message, true);
      }
      renderWidgets(tab);
    })
  );

  async function launchWidget(btn, id, endpoint, label) {
    // Fresh fetch: dynamic launch schemas (e.g. saved creations) may have
    // changed since the page was rendered
    const widget = await api('GET', `/api/widgets/${id}`).catch(() => null);
    let launch = {};
    if (widget && Object.keys(widget.launchSchema || {}).length > 0) {
      launch = await promptLaunchValues(widget);
      if (launch === null) return; // cancelled
    }
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      await api('POST', `/api/widgets/${id}/${endpoint}`, { launch });
      toast(`${id} ${label}`);
      // Browser-source widgets: when permission is already granted the capture
      // starts right here, invisibly. Only an ungranted permission needs the
      // widget page (its enable button triggers the browser prompt).
      for (const key of widget?.browser_sources || []) {
        const source = browserSources[key];
        if (!source) continue;
        if (source.permissionGranted && (await source.permissionGranted())) {
          try {
            await startCapture(key, id);
          } catch (err) {
            toast(err.message, true);
          }
        } else {
          location.hash = `#/widget/${id}`;
          return;
        }
      }
    } catch (err) {
      btn.textContent = originalLabel;
      btn.disabled = false;
      // Bar unreachable → send the user to the connection settings
      if (/offline|unreachable/i.test(err.message)) {
        toast('The bar is not reachable — check the connection in Settings', true);
        location.hash = '#/settings';
        return;
      }
      // Config problem → send the user to the widget's configuration page
      if (/configuration|not installed/i.test(err.message)) {
        toast(err.message, true);
        location.hash = `#/widget/${id}`;
        return;
      }
      toast(err.message, true);
    }
    renderWidgets(tab);
  }

  app.querySelectorAll('[data-start]').forEach((btn) =>
    btn.addEventListener('click', () => launchWidget(btn, btn.dataset.start, 'start', 'started'))
  );
  app.querySelectorAll('[data-stop]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Stopping…';
      try {
        await api('POST', `/api/widgets/${btn.dataset.stop}/stop`);
        toast(`${btn.dataset.stop} stopped`);
      } catch (err) {
        toast(err.message, true);
      }
      renderWidgets(tab);
    })
  );
  app.querySelectorAll('[data-open]').forEach((btn) =>
    btn.addEventListener('click', () => {
      location.hash = `#/widget/${btn.dataset.open}`;
    })
  );
}

let logsTimer;

async function renderWidgetDetail(id) {
  const widget = await api('GET', `/api/widgets/${id}`);
  const schema = widget.configSchema || {};
  const hasConfig = Object.keys(schema).length > 0;

  app.innerHTML = `
    <a class="back" href="#/widgets">← Widgets</a>
    <div class="detail-head">
      <h1>${esc(widget.title)}
        ${widget.installed
          ? `<span class="badge ${widget.state}" style="vertical-align: middle;">${STATE_LABELS[widget.state] || widget.state}</span>`
          : '<span class="badge stopped" style="vertical-align: middle;">Not installed</span>'}
      </h1>
      <div class="detail-actions">
        ${widget.installed
          ? '<button id="uninstall-btn" class="danger">Uninstall</button>'
          : (Object.keys(widget.configSchema || {}).length === 0
              ? '<button id="install-btn" class="primary">Install</button>'
              : '')}
      </div>
    </div>
    <p class="detail-desc">${esc(widget.description)}</p>
    ${(widget.tags || []).length
      ? `<div class="tags" style="margin-top: 12px;">${widget.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`
      : ''}
    ${widget.has_preview
      ? `<div class="bar-frame detail-frame">
          <div class="bar-screen"><img src="/api/widgets/${id}/preview" alt="" /></div>
        </div>`
      : ''}

    ${sourcePanelsHtml(widget)}

    ${hasConfig ? `
      <h2>Configuration</h2>
      <form class="panel" id="config-form">
        ${Object.entries(schema).map(([key, field]) => {
          const value = widget.config[key] ?? '';
          const label = `${esc(field.label || key)}${field.required ? ' <span class="required">*</span>' : ''}`;
          if (field.type === 'boolean') {
            const checked = (widget.config[key] ?? field.default) === true ? 'checked' : '';
            return `<div class="field"><label>${label}</label>
              <input type="checkbox" name="${esc(key)}" ${checked} /></div>`;
          }
          if (field.type === 'color') {
            const current = String(value || field.default || '#FFFFFFFF');
            return `<div class="field"><label>${label}</label>
              <div class="input-row">
                <input type="color" name="${esc(key)}" value="${esc(current.slice(0, 7))}" />
                <code class="color-code">${esc(current)}</code>
              </div></div>`;
          }
          if (field.type === 'select') {
            return `<div class="field"><label>${label}</label>
              ${selectHtml(key, field, value !== '' ? value : field.default ?? '')}</div>`;
          }
          if (field.type === 'location') {
            return `<div class="field"><label>${label}</label>
              <div class="input-row">
                <input type="text" name="${esc(key)}" value="${esc(value)}"
                  placeholder="${field.default !== undefined ? `default: ${esc(field.default)}` : 'lat,lon'}" />
                <button type="button" class="geo-btn" data-geo="${esc(key)}">📍 Use my location</button>
              </div></div>`;
          }
          const inputType = field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text';
          const placeholder = field.default !== undefined ? `default: ${esc(field.default)}` : '';
          return `<div class="field"><label>${label}</label>
            <input type="${inputType}" name="${esc(key)}" value="${esc(value)}"
              placeholder="${placeholder}" ${field.type === 'number' ? 'step="any"' : ''} /></div>`;
        }).join('')}
        <button class="primary" type="submit">${widget.installed ? 'Save' : 'Validate configuration'}</button>
      </form>
    ` : ''}

    <div class="section-head">
      <h2>Logs</h2>
      <button id="copy-logs" title="Copy logs to clipboard">Copy</button>
    </div>
    <div class="logs" id="logs"></div>
  `;

  document.getElementById('copy-logs').addEventListener('click', async () => {
    try {
      const logs = await api('GET', `/api/widgets/${id}/logs?limit=500`);
      const text = logs
        .slice()
        .reverse() // stored newest-first → copy in chronological order
        .map((l) => `${new Date(l.created_at).toISOString()} ${l.level.toUpperCase().padEnd(5)} ${l.message}`)
        .join('\n');
      await navigator.clipboard.writeText(text || '(no logs)');
      toast('Logs copied to clipboard');
    } catch (err) {
      toast(err.message, true);
    }
  });

  mountSourcePanels(widget);

  // Config form
  const form = document.getElementById('config-form');
  if (form) {
    // Color pickers: live-update the hex code shown next to the swatch
    form.querySelectorAll('input[type="color"]').forEach((input) =>
      input.addEventListener('input', () => {
        input.parentElement.querySelector('.color-code').textContent = `${input.value.toUpperCase()}FF`;
      })
    );
    // Location fields: fill from browser geolocation
    form.querySelectorAll('[data-geo]').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (!navigator.geolocation) {
          toast('Geolocation not available — type lat,lon manually', true);
          return;
        }
        btn.disabled = true;
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            form.elements[btn.dataset.geo].value =
              `${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`;
            btn.disabled = false;
          },
          () => {
            toast('Location denied — type lat,lon manually', true);
            btn.disabled = false;
          }
        );
      })
    );

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = {};
      for (const [key, field] of Object.entries(schema)) {
        const input = form.elements[key];
        if (field.type === 'boolean') values[key] = input.checked;
        else if (field.type === 'color') {
          // keep the previously stored alpha, default to opaque
          const alpha = String(widget.config[key] || '').slice(7, 9) || 'FF';
          values[key] = input.value + alpha;
        } else values[key] = input.value;
      }
      const submitBtn = form.querySelector('button[type="submit"]');
      const originalLabel = submitBtn.textContent;
      submitBtn.disabled = true;
      if (!widget.installed) submitBtn.textContent = 'Validating…';
      try {
        await api('PUT', `/api/widgets/${id}/config`, values);
        if (!widget.installed) {
          // Valid config = the widget becomes installed (after its own checks:
          // browser permissions, LLM access, system consent…)
          await ensureBrowserPermissions(widget);
          await api('POST', `/api/widgets/${id}/install`);
          toast('Configuration valid — widget installed');
          renderWidgetDetail(id);
          return;
        }
        toast('Configuration saved');
      } catch (err) {
        toast(err.message, true);
      }
      submitBtn.textContent = originalLabel;
      submitBtn.disabled = false;
    });
  }

  // Install (no config needed) / uninstall
  document.getElementById('install-btn')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Checking…';
    try {
      await ensureBrowserPermissions(widget);
      await api('POST', `/api/widgets/${id}/install`);
      toast(`${id} installed`);
      renderWidgetDetail(id);
    } catch (err) {
      toast(err.message, true);
      e.target.textContent = 'Install';
      e.target.disabled = false;
    }
  });
  document.getElementById('uninstall-btn')?.addEventListener('click', async () => {
    try {
      await api('DELETE', `/api/widgets/${id}/install`);
      toast(`${id} uninstalled`);
      renderWidgetDetail(id);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Logs (auto-refresh)
  async function refreshLogs() {
    const logsEl = document.getElementById('logs');
    if (!logsEl) return;
    const logs = await api('GET', `/api/widgets/${id}/logs?limit=200`);
    logsEl.innerHTML = logs.length === 0
      ? '<p class="empty">No logs yet.</p>'
      : logs.map((l) => `
          <div class="log-line ${l.level}">
            <span class="ts">${new Date(l.created_at).toLocaleTimeString()}</span>
            <span>${esc(l.message)}</span>
          </div>
        `).join('');
  }

  refreshLogs();
  clearInterval(logsTimer);
  logsTimer = setInterval(refreshLogs, 5000);
}

// --- Device connection form (shared by Settings and Onboarding) ---

const MODES = [
  { id: 'local', label: 'USB', desc: 'Plugged into this computer' },
  { id: 'wifi', label: 'Wi-Fi', desc: 'Same network as this computer' },
  { id: 'cloud', label: 'Cloud', desc: 'Anywhere, through your BUSY account' },
];

const LED_STRIP = (state) => `<span class="led-strip ${state}">${[0, 1, 2, 3, 4].map((i) => `<i style="--i:${i}"></i>`).join('')}</span>`;

const trimmed = (obj) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

function friendlyTestError(message, mode) {
  if (mode === 'cloud' && /HTTP 40[13]/.test(message)) {
    return 'The BUSY cloud rejected the token. Most common cause: the token was created with the “Account” scope — create one at cloud.busy.app/api-tokens with the “BUSY Bar” scope. Also check the bar is linked to your account and online.';
  }
  if (mode === 'wifi' && /HTTP 40[13]/.test(message)) {
    return 'The bar refused the request — Wi-Fi access is off or the access key is wrong.';
  }
  if (/timed? ?out|abort/i.test(message)) {
    return mode === 'local'
      ? 'No answer over USB — check the bar is plugged into this computer.'
      : 'No answer at that address — check the bar is on and the address is right.';
  }
  return message;
}

function connectionFieldsHtml(mode, d) {
  if (mode === 'local') {
    return `
      <div class="field"><label>Device URL</label>
        <input type="text" class="mono" data-k="local_url" value="${esc(d.local_url)}" placeholder="http://10.0.4.20" />
        <p class="hint">The bar shows up as a network adapter when plugged in — it always answers at <code>http://10.0.4.20</code>.</p></div>`;
  }
  if (mode === 'wifi') {
    return `
      <div class="field"><label>Device address</label>
        <input type="text" class="mono" data-k="wifi_url" value="${esc(d.wifi_url)}" placeholder="http://192.168.1.x" />
        <p class="hint">The bar's IP on your network.</p></div>
      <div class="field"><label>Access key <span class="opt">— only if Wi-Fi access is key-protected</span></label>
        <input type="password" class="mono" data-k="api_token" value="${esc(d.api_token)}" placeholder="4–10 digits" /></div>
      <div class="subpanel" id="wifi-access-sub"><p class="hint" style="margin: 0;">Checking the bar's Wi-Fi access…</p></div>`;
  }
  return `
    <div class="field"><label>API token</label>
      <input type="password" class="mono" data-k="cloud_token" value="${esc(d.cloud_token)}" />
      <p class="hint">Create one at <a href="https://cloud.busy.app/api-tokens" target="_blank" rel="noreferrer">cloud.busy.app/api-tokens</a> with the <strong>BUSY Bar</strong> access scope (not “Account”) — the bar must be linked to your BUSY account.</p></div>
    <div class="field"><label>Cloud server <span class="opt">— leave as is unless you self-host</span></label>
      <input type="text" class="mono" data-k="cloud_url" value="${esc(d.cloud_url)}" placeholder="https://api.busy.app" /></div>`;
}

function mountConnectionForm(root, settings, { submitLabel, onSaved }) {
  const draft = {
    access_mode: settings.access_mode,
    local_url: settings.local_url,
    wifi_url: settings.wifi_url,
    cloud_url: settings.cloud_url,
    cloud_token: settings.cloud_token,
    api_token: settings.api_token,
  };

  function render() {
    root.innerHTML = `
      <div class="mode-cards" role="radiogroup" aria-label="Connection mode">
        ${MODES.map((m) => `
          <button type="button" role="radio" aria-checked="${draft.access_mode === m.id}"
            class="mode-card${draft.access_mode === m.id ? ' selected' : ''}" data-mode="${m.id}">
            <strong>${m.label}</strong>
            <span>${m.desc}</span>
          </button>`).join('')}
      </div>
      ${connectionFieldsHtml(draft.access_mode, draft)}
      <div class="test-row" id="test-result"></div>
      <div class="form-actions">
        <button class="primary" data-save>${esc(submitLabel)}</button>
        <button type="button" data-test>Test connection</button>
      </div>
    `;

    const accessSub = root.querySelector('#wifi-access-sub');
    if (accessSub) renderAccessPanel(accessSub);

    root.querySelectorAll('[data-mode]').forEach((btn) =>
      btn.addEventListener('click', () => {
        draft.access_mode = btn.dataset.mode;
        render();
      })
    );
    root.querySelectorAll('[data-k]').forEach((input) =>
      input.addEventListener('input', () => { draft[input.dataset.k] = input.value; })
    );

    const resultEl = root.querySelector('#test-result');
    root.querySelector('[data-test]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      resultEl.innerHTML = `${LED_STRIP('testing')}<span>Looking for the bar…</span>`;
      try {
        const r = await api('POST', '/api/device/test', trimmed(draft));
        const fw = (r.status && r.status.firmware) || {};
        resultEl.innerHTML = `${LED_STRIP('ok')}<span class="ok">Connected — firmware ${esc(fw.version || '?')} · API ${esc(r.api_semver)}</span>`;
      } catch (err) {
        resultEl.innerHTML = `${LED_STRIP('fail')}<span class="fail">${esc(friendlyTestError(err.message, draft.access_mode))}</span>`;
      }
      e.target.disabled = false;
    });

    root.querySelector('[data-save]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      // Save = test first; an unreachable configuration is never saved
      resultEl.innerHTML = `${LED_STRIP('testing')}<span>Checking the bar before saving…</span>`;
      try {
        await api('POST', '/api/device/test', trimmed(draft));
      } catch (err) {
        resultEl.innerHTML = `${LED_STRIP('fail')}<span class="fail">${esc(friendlyTestError(err.message, draft.access_mode))}</span>`;
        toast('Not saved — the bar is unreachable with this configuration', true);
        e.target.disabled = false;
        return;
      }
      try {
        await api('PUT', '/api/settings', trimmed(draft));
        resultEl.innerHTML = `${LED_STRIP('ok')}<span class="ok">Connected — settings saved</span>`;
        toast('Connected & saved');
        pollDevice();
        if (onSaved) onSaved();
      } catch (err) {
        toast(err.message, true);
      }
      e.target.disabled = false;
    });
  }

  render();
}

// --- Wi-Fi access sub-panel (the bar's /access setting, shown inside the Wi-Fi mode) ---

const ACCESS_LABELS = { disabled: 'off', enabled: 'open', key: 'key-protected' };

async function renderAccessPanel(el) {
  let access;
  try {
    access = await api('GET', '/api/device/access');
  } catch {
    el.innerHTML = `<p class="hint" style="margin: 0;">Can't reach the bar to read its Wi-Fi access setting.
      Plug it in over USB to change it from here, or use the bar itself: Settings → HTTP Access.</p>`;
    return;
  }

  const mode = access.mode || 'disabled';
  el.innerHTML = `
    <label class="sub-title">On the bar: Wi-Fi access is <strong>${ACCESS_LABELS[mode]}</strong></label>
    <div class="radio-row">
      <label><input type="radio" name="wifi-access" value="disabled" ${mode === 'disabled' ? 'checked' : ''} /> Off</label>
      <label><input type="radio" name="wifi-access" value="enabled" ${mode === 'enabled' ? 'checked' : ''} /> Open</label>
      <label><input type="radio" name="wifi-access" value="key" ${mode === 'key' ? 'checked' : ''} /> Key-protected</label>
    </div>
    <div class="field" data-key-field style="margin-top: 12px; display: ${mode === 'key' ? 'block' : 'none'};">
      <label>Access key <span class="opt">— 4–10 digits${access.key_valid ? ', a key is already set' : ''}</span></label>
      <input type="password" class="mono" data-key-input placeholder="12345678" />
    </div>
    <button type="button" data-access-apply style="margin-top: 6px;">Apply to the bar</button>
    <p class="hint" style="margin: 10px 0 0;">Changing this over Wi-Fi can cut the connection — prefer doing it over USB.</p>
  `;

  el.querySelectorAll('input[name="wifi-access"]').forEach((radio) =>
    radio.addEventListener('change', () => {
      el.querySelector('[data-key-field]').style.display = radio.value === 'key' ? 'block' : 'none';
    })
  );

  el.querySelector('[data-access-apply]').addEventListener('click', async (e) => {
    const newMode = el.querySelector('input[name="wifi-access"]:checked').value;
    const key = el.querySelector('[data-key-input]').value;
    if (newMode === 'key' && !/^\d{4,10}$/.test(key)) {
      toast('Access key must be 4–10 digits', true);
      return;
    }
    e.target.disabled = true;
    try {
      await api('POST', '/api/device/access', { mode: newMode, key: newMode === 'key' ? key : undefined });
      const tokenInput = document.querySelector('[data-k="api_token"]');
      if (newMode === 'key' && tokenInput) {
        tokenInput.value = key;
        tokenInput.dispatchEvent(new Event('input'));
      }
      toast(newMode === 'key' ? 'Applied — key also filled in above' : 'Applied to the bar');
      renderAccessPanel(el);
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
    }
  });
}

async function renderSettings() {
  const settings = await api('GET', '/api/settings');
  app.innerHTML = `
    <h1>Settings</h1>
    <h2 style="margin-top: 0;">Device connection</h2>
    <div class="panel" id="conn-form"></div>
  `;
  mountConnectionForm(document.getElementById('conn-form'), settings, { submitLabel: 'Save' });
}

// --- Notifications page ---

const NOTIFY_ICONS = ['info', 'success', 'warning', 'error', 'message', 'bell'];

async function renderNotifications() {
  const items = await api('GET', '/api/notify');

  const historyHtml = items.length === 0
    ? '<p class="empty">No notifications yet.</p>'
    : items.map((n) => `
        <div class="notif-row">
          <img src="/notify-icons/${esc(n.icon)}.png" alt="${esc(n.icon)}" />
          <div class="notif-body">
            ${n.title ? `<strong>${esc(n.title)}</strong>` : ''}
            <span>${esc(n.text)}</span>
          </div>
          <span class="notif-time">${new Date(n.created_at).toLocaleString()}</span>
        </div>
      `).join('');

  app.innerHTML = `
    <h1>Notifications</h1>
    <h2>Send a notification</h2>
    <form class="panel" id="notify-form">
      <div class="field">
        <label>Icon</label>
        <div class="icon-picker">
          ${NOTIFY_ICONS.map((icon, i) => `
            <label class="icon-opt">
              <input type="radio" name="icon" value="${icon}" ${i === 0 ? 'checked' : ''} />
              <img src="/notify-icons/${icon}.png" alt="" />
              <span>${icon}</span>
            </label>`).join('')}
        </div>
      </div>
      <div class="field"><label>Title</label>
        <input type="text" name="title" placeholder="optional" autocomplete="off" /></div>
      <div class="field"><label>Text <span class="required">*</span></label>
        <input type="text" name="text" autocomplete="off" /></div>
      <div class="field"><label>Duration (seconds)</label>
        <input type="number" name="duration" value="6" min="1" max="300" style="max-width: 120px;" /></div>
      <div class="field">
        <label class="check-label"><input type="checkbox" name="sound" checked /> Play sound</label>
      </div>
      <button class="primary" type="submit">Send to the bar</button>
    </form>

    <div class="section-head">
      <h2>History <span class="opt">— last 100</span></h2>
      ${items.length > 0 ? '<button id="clear-notifs" class="danger">Clear</button>' : ''}
    </div>
    <div class="panel">${historyHtml}</div>
  `;

  const form = document.getElementById('notify-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await api('POST', '/api/notify', {
        icon: form.elements.icon.value,
        title: form.elements.title.value.trim() || undefined,
        text: form.elements.text.value,
        duration: Number(form.elements.duration.value) || 6,
        sound: form.elements.sound.checked,
      });
      toast('Notification sent to the bar');
      renderNotifications();
      return;
    } catch (err) {
      toast(err.message, true);
    }
    submitBtn.disabled = false;
  });

  document.getElementById('clear-notifs')?.addEventListener('click', async () => {
    await api('DELETE', '/api/notify');
    toast('History cleared');
    renderNotifications();
  });
}

// --- Router ---

async function route() {
  clearInterval(logsTimer);
  const hash = location.hash || '#/widgets';
  const widgetMatch = hash.match(/^#\/widget\/([a-zA-Z0-9._-]+)$/);

  document.querySelectorAll('nav a').forEach((a) => {
    a.classList.toggle('active', hash.startsWith(a.getAttribute('href')) || (widgetMatch && a.dataset.nav === 'widgets'));
  });

  try {
    if (widgetMatch) await renderWidgetDetail(widgetMatch[1]);
    else if (hash === '#/notifications') await renderNotifications();
    else if (hash === '#/settings') await renderSettings();
    else if (hash === '#/widgets/all') await renderWidgets('all');
    else await renderWidgets('installed');
  } catch (err) {
    app.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}

window.addEventListener('hashchange', route);
route();
