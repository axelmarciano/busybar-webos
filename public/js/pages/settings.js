/* Settings page: device connection form + the bar's Wi-Fi access sub-panel */

import { api, esc, toast } from '../helpers.js';
import { refreshDeviceStatus } from '../device.js';

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
        refreshDeviceStatus();
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

export async function render({ root, alive }) {
  const settings = await api('GET', '/api/settings');
  if (!alive()) return;
  root.innerHTML = `
    <h1>Settings</h1>
    <h2 style="margin-top: 0;">Device connection</h2>
    <div class="panel" id="conn-form"></div>
  `;
  mountConnectionForm(document.getElementById('conn-form'), settings, { submitLabel: 'Save' });
}
