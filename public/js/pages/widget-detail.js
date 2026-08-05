/* Widget detail page: install state, capture panels, config form, logs */

import { api, esc, toast, STATE_LABELS } from '../helpers.js';
import { fieldHtml, wireFieldExtras, readFieldValues } from '../forms.js';
import { ensureBrowserPermissions, sourcePanelsHtml, mountSourcePanels } from '../captures.js';
import { refresh } from '../router.js';

export async function render({ root, params, alive }) {
  const id = params.id;
  const widget = await api('GET', `/api/widgets/${id}`);
  if (!alive()) return;

  const schema = widget.configSchema || {};
  const hasConfig = Object.keys(schema).length > 0;

  root.innerHTML = `
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
          : (hasConfig ? '' : '<button id="install-btn" class="primary">Install</button>')}
      </div>
    </div>
    <p class="detail-desc">${esc(widget.description)}</p>
    ${widget.author
      ? `<a class="author" href="https://github.com/${esc(widget.author)}" target="_blank" rel="noreferrer">by @${esc(widget.author)}</a>`
      : ''}
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
        ${Object.entries(schema).map(([key, field]) => fieldHtml(key, field, widget.config[key] ?? '')).join('')}
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
    wireFieldExtras(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = readFieldValues(form, schema, widget.config);
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
          refresh();
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
      refresh();
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
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Logs (auto-refresh) — the interval belongs to this page and is cleared by
  // the cleanup function returned to the router.
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
  const logsTimer = setInterval(refreshLogs, 5000);
  return () => clearInterval(logsTimer);
}
