/* Schema-driven form fields — the single renderer for the launch modal and the
   widget config form (all 7 ConfigSchema field types). */

import { esc, toast } from './helpers.js';

function selectHtml(key, field, current) {
  return `<select name="${esc(key)}">${(field.options || []).map((o) =>
    `<option value="${esc(o.value)}" ${o.value === String(current) ? 'selected' : ''}>${esc(o.label || o.value)}</option>`
  ).join('')}</select>`;
}

/** One form field (label + input) for any ConfigSchema field type. */
export function fieldHtml(key, field, value = '') {
  const label = `${esc(field.label || key)}${field.required ? ' <span class="required">*</span>' : ''}`;
  if (field.type === 'boolean') {
    const checked = (value === '' || value == null ? field.default : value) === true ? 'checked' : '';
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
      ${selectHtml(key, field, value !== '' && value != null ? value : field.default ?? '')}</div>`;
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
      placeholder="${placeholder}" ${field.type === 'number' ? 'step="any"' : ''} autocomplete="off" /></div>`;
}

/** Wires the interactive extras of rendered fields: color hex preview, geolocation button. */
export function wireFieldExtras(container) {
  container.querySelectorAll('input[type="color"]').forEach((input) =>
    input.addEventListener('input', () => {
      input.parentElement.querySelector('.color-code').textContent = `${input.value.toUpperCase()}FF`;
    })
  );
  container.querySelectorAll('[data-geo]').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        toast('Geolocation not available — type lat,lon manually', true);
        return;
      }
      const form = btn.closest('form');
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
}

/**
 * Reads the values of a schema-rendered form back into an object.
 * `previous` supplies the stored values (used to keep a color's alpha channel).
 */
export function readFieldValues(form, schema, previous = {}) {
  const values = {};
  for (const [key, field] of Object.entries(schema)) {
    const input = form.elements[key];
    if (field.type === 'boolean') values[key] = input.checked;
    else if (field.type === 'color') {
      // keep the previously stored alpha, default to opaque
      const alpha = String(previous[key] || '').slice(7, 9) || 'FF';
      values[key] = input.value + alpha;
    } else values[key] = input.value;
  }
  return values;
}

/** Modal asking for launchSchema values on Start. Resolves null when cancelled. */
export function promptLaunchValues(widget) {
  return new Promise((resolve) => {
    const schema = widget.launchSchema || {};
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <form class="panel modal">
        <h2 style="margin-top: 0;">Start ${esc(widget.title)}</h2>
        ${Object.entries(schema).map(([key, field]) => fieldHtml(key, field)).join('')}
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
      const raw = readFieldValues(e.target, schema);
      // Empty inputs are omitted so the server applies schema defaults
      const values = {};
      for (const [key, value] of Object.entries(raw)) {
        if (value !== '') values[key] = value;
      }
      close(values);
    });

    wireFieldExtras(overlay);
    document.body.appendChild(overlay);
    const first = overlay.querySelector('input');
    if (first) first.focus();
  });
}
