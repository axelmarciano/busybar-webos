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

// --- Pages ---

async function renderWidgets() {
  const widgets = await api('GET', '/api/widgets');
  app.innerHTML = `
    <h1>Widgets</h1>
    <div class="grid">
      ${widgets.map((w) => `
        <div class="card">
          ${w.has_preview
            ? `<img class="preview" src="/api/widgets/${w.id}/preview" alt="" />`
            : '<div class="preview preview-empty">no preview</div>'}
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
    ${widget.has_preview
      ? `<img class="preview preview-detail" src="/api/widgets/${id}/preview" alt="" />`
      : ''}

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
        <button class="primary" type="submit">Save</button>
      </form>
    ` : ''}

    <h2>Logs</h2>
    <div class="logs" id="logs"></div>
  `;

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
    return 'The BUSY cloud rejected the token. Check it at cloud.busy.app/api-tokens, and make sure the bar is linked to your BUSY account and online — it needs Wi-Fi to reach the cloud.';
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
      <p class="hint">Create one at <a href="https://cloud.busy.app/api-tokens" target="_blank" rel="noreferrer">cloud.busy.app/api-tokens</a> — the bar must be linked to your BUSY account.</p></div>
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
      try {
        await api('PUT', '/api/settings', { ...trimmed(draft), setup_done: true });
        toast('Settings saved');
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

async function renderOnboarding() {
  const settings = await api('GET', '/api/settings');
  app.innerHTML = `
    <div class="onboard">
      <div class="onboard-bar" aria-hidden="true">${Array.from({ length: 12 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
      <h1>Connect your BUSY Bar</h1>
      <p class="onboard-sub">Pick how this portal reaches the bar — you can change it later in Settings.</p>
      <div class="panel" id="conn-form"></div>
    </div>
  `;
  mountConnectionForm(document.getElementById('conn-form'), settings, {
    submitLabel: 'Save & start',
    onSaved: () => { location.hash = '#/widgets'; },
  });
}

// --- Router ---

let setupChecked = false;

async function route() {
  clearInterval(logsTimer);
  const hash = location.hash || '#/widgets';
  const widgetMatch = hash.match(/^#\/widget\/([a-zA-Z0-9._-]+)$/);

  // First load: send fresh installs to onboarding until a connection is saved
  if (!setupChecked) {
    setupChecked = true;
    try {
      const settings = await api('GET', '/api/settings');
      if (!settings.setup_done && hash !== '#/onboarding') {
        location.hash = '#/onboarding';
        return;
      }
    } catch {
      // server unreachable — fall through, the page will show the error
    }
  }

  document.querySelectorAll('nav a').forEach((a) => {
    a.classList.toggle('active', hash.startsWith(a.getAttribute('href')) || (widgetMatch && a.dataset.nav === 'widgets'));
  });

  try {
    if (hash === '#/onboarding') await renderOnboarding();
    else if (widgetMatch) await renderWidgetDetail(widgetMatch[1]);
    else if (hash === '#/settings') await renderSettings();
    else await renderWidgets();
  } catch (err) {
    app.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}

window.addEventListener('hashchange', route);
route();
