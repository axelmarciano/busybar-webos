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

// --- Device status polling (sidebar) ---

async function pollDevice() {
  const statusEl = document.getElementById('device-status');
  const previewEl = document.getElementById('screen-preview');
  try {
    const status = await api('GET', '/api/device/status');
    const power = status.power || {};
    const battery = power.battery_charge != null ? ` · ${power.battery_charge}%` : '';
    statusEl.innerHTML = `<span class="dot online"></span> Device online${battery}`;
  } catch {
    statusEl.innerHTML = '<span class="dot offline"></span> Device offline';
    previewEl.style.display = 'none';
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
    const previewEl = document.getElementById('screen-preview');
    previewEl.src = `data:image/bmp;base64,${msg.bmp}`;
    previewEl.style.display = 'block';
  };
  ws.onclose = () => setTimeout(connectScreenStream, 3000);
}
connectScreenStream();

// --- Pages ---

async function renderWidgets() {
  const widgets = await api('GET', '/api/widgets');
  app.innerHTML = `
    <h1>Widgets</h1>
    <div class="grid">
      ${widgets.map((w) => `
        <div class="card">
          <div class="head">
            <h3>${esc(w.title)}</h3>
            <span class="badge ${w.state}">${STATE_LABELS[w.state] || w.state}</span>
          </div>
          <p>${esc(w.description)}</p>
          ${w.error ? `<p style="color: var(--red); font-size: 12px;">${esc(w.error)}</p>` : ''}
          <div class="actions">
            ${w.state === 'running' || w.state === 'error'
              ? `<button data-stop="${w.id}">Stop</button>`
              : ''}
            ${w.state !== 'running'
              ? `<button class="primary" data-start="${w.id}">Start</button>`
              : ''}
            <button data-open="${w.id}">Configure</button>
          </div>
        </div>
      `).join('')}
    </div>
    ${widgets.length === 0 ? '<p class="empty">No widgets found in widgets/.</p>' : ''}
  `;

  app.querySelectorAll('[data-start]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('POST', `/api/widgets/${btn.dataset.start}/start`);
        toast(`${btn.dataset.start} started`);
      } catch (err) {
        toast(err.message, true);
      }
      renderWidgets();
    })
  );
  app.querySelectorAll('[data-stop]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('POST', `/api/widgets/${btn.dataset.stop}/stop`);
        toast(`${btn.dataset.stop} stopped`);
      } catch (err) {
        toast(err.message, true);
      }
      renderWidgets();
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
    <h1 style="margin-top: 10px;">${esc(widget.title)}
      <span class="badge ${widget.state}" style="vertical-align: middle;">${STATE_LABELS[widget.state] || widget.state}</span>
    </h1>
    <p style="color: var(--muted);">${esc(widget.description)}</p>

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
          const inputType = field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text';
          const placeholder = field.default !== undefined ? `default: ${esc(field.default)}` : '';
          return `<div class="field"><label>${label}</label>
            <input type="${inputType}" name="${esc(key)}" value="${esc(value)}"
              placeholder="${placeholder}" ${field.type === 'number' ? 'step="any"' : ''} /></div>`;
        }).join('')}
        <button class="primary" type="submit">Save</button>
      </form>
    ` : ''}

    <h2>Logs</h2>
    <div class="logs" id="logs"></div>
  `;

  // Config form
  const form = document.getElementById('config-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = {};
      for (const [key, field] of Object.entries(schema)) {
        const input = form.elements[key];
        values[key] = field.type === 'boolean' ? input.checked : input.value;
      }
      try {
        await api('PUT', `/api/widgets/${id}/config`, values);
        toast('Configuration saved');
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

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

async function renderSettings() {
  const settings = await api('GET', '/api/settings');
  app.innerHTML = `
    <h1>Settings</h1>
    <form class="panel" id="settings-form">
      <div class="field">
        <label>Device access mode</label>
        <div class="radio-row">
          <label><input type="radio" name="access_mode" value="local"
            ${settings.access_mode === 'local' ? 'checked' : ''} /> Local (USB)</label>
          <label><input type="radio" name="access_mode" value="wifi"
            ${settings.access_mode === 'wifi' ? 'checked' : ''} /> Wi-Fi</label>
        </div>
      </div>
      <div class="field">
        <label>Local URL</label>
        <input type="text" name="local_url" value="${esc(settings.local_url)}" />
      </div>
      <div class="field">
        <label>Wi-Fi URL</label>
        <input type="text" name="wifi_url" value="${esc(settings.wifi_url)}" placeholder="http://192.168.1.x" />
      </div>
      <div class="field">
        <label>API token (X-API-Token header, leave empty if disabled)</label>
        <input type="password" name="api_token" value="${esc(settings.api_token)}" />
      </div>
      <div style="display: flex; gap: 10px;">
        <button class="primary" type="submit">Save</button>
        <button type="button" id="test-connection">Test connection</button>
      </div>
    </form>
  `;

  const form = document.getElementById('settings-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', {
        access_mode: form.elements.access_mode.value,
        local_url: form.elements.local_url.value,
        wifi_url: form.elements.wifi_url.value,
        api_token: form.elements.api_token.value,
      });
      toast('Settings saved');
      pollDevice();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById('test-connection').addEventListener('click', async () => {
    try {
      const status = await api('GET', '/api/device/status');
      const fw = status.firmware || {};
      toast(`Connected — firmware ${fw.version || '?'}`);
    } catch (err) {
      toast(`Connection failed: ${err.message}`, true);
    }
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
    else if (hash === '#/settings') await renderSettings();
    else await renderWidgets();
  } catch (err) {
    app.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}

window.addEventListener('hashchange', route);
route();
