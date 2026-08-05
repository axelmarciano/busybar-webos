/* Widgets list page: installed/all tabs, search + tag filter, install/start/stop */

import { api, esc, toast, STATE_LABELS } from '../helpers.js';
import { promptLaunchValues } from '../forms.js';
import { browserSources, ensureBrowserPermissions, startCapture } from '../captures.js';
import { refresh } from '../router.js';

// Filter state lives here (not in the DOM), so it survives the full re-render
// that follows every install/start/stop action.
const filters = { query: '', tag: null };

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
  const author = w.author
    ? `<a class="author" href="https://github.com/${esc(w.author)}" target="_blank" rel="noreferrer">by @${esc(w.author)}</a>`
    : '';
  const searchable = [w.id, w.title, w.description, w.author, ...(w.tags || [])].join(' ').toLowerCase();
  const open = `<div class="card" data-search="${esc(searchable)}" data-tags="${esc((w.tags || []).join(','))}">`;

  if (tab === 'all') {
    return `${open}
      ${preview}
      <div class="head">
        <h3>${esc(w.title)}</h3>
        ${w.installed ? '<span class="badge installed">Installed</span>' : ''}
      </div>
      <p>${esc(w.description)}</p>
      ${author}
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
    ${author}
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

export async function render({ root, params, alive }) {
  const tab = params.tab;
  const widgets = await api('GET', '/api/widgets');
  if (!alive()) return;

  const installedCount = widgets.filter((w) => w.installed).length;
  const shown = tab === 'installed' ? widgets.filter((w) => w.installed) : widgets;
  const allTags = [...new Set(shown.flatMap((w) => w.tags || []))].sort();
  if (filters.tag && !allTags.includes(filters.tag)) filters.tag = null;

  root.innerHTML = `
    <h1>Widgets</h1>
    <div class="tabs">
      <a class="tab ${tab === 'installed' ? 'active' : ''}" href="#/widgets">Installed widgets <span class="count">${installedCount}</span></a>
      <a class="tab ${tab === 'all' ? 'active' : ''}" href="#/widgets/all">All widgets <span class="count">${widgets.length}</span></a>
    </div>
    ${shown.length > 0 ? `
      <div class="filter-bar">
        <input id="widget-search" class="search-input" type="search" placeholder="Search widgets…"
          value="${esc(filters.query)}" autocomplete="off" />
        ${allTags.map((t) => `<button class="chip ${filters.tag === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
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
  const searchInput = document.getElementById('widget-search');
  function applyFilters() {
    const query = filters.query.trim().toLowerCase();
    let visible = 0;
    root.querySelectorAll('.grid .card').forEach((card) => {
      const matchesQuery = !query || card.dataset.search.includes(query);
      const matchesTag = !filters.tag || card.dataset.tags.split(',').includes(filters.tag);
      const show = matchesQuery && matchesTag;
      card.classList.toggle('hidden', !show);
      if (show) visible++;
    });
    const noResults = document.getElementById('no-results');
    if (noResults) noResults.classList.toggle('hidden', visible > 0 || shown.length === 0);
  }
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      filters.query = searchInput.value;
      applyFilters();
    });
  }
  root.querySelectorAll('.chip[data-tag]').forEach((chip) =>
    chip.addEventListener('click', () => {
      filters.tag = filters.tag === chip.dataset.tag ? null : chip.dataset.tag;
      root.querySelectorAll('.chip[data-tag]').forEach((c) =>
        c.classList.toggle('active', c.dataset.tag === filters.tag)
      );
      applyFilters();
    })
  );
  applyFilters();

  // Install / uninstall
  root.querySelectorAll('[data-install]').forEach((btn) =>
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
        refresh();
      } catch (err) {
        toast(err.message, true);
        btn.textContent = 'Install';
        btn.disabled = false;
        // Missing required config → send the user to the config page to validate it
        if (/Configuration required/i.test(err.message)) location.hash = `#/widget/${id}`;
      }
    })
  );
  root.querySelectorAll('[data-uninstall]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('DELETE', `/api/widgets/${btn.dataset.uninstall}/install`);
        toast(`${btn.dataset.uninstall} uninstalled`);
      } catch (err) {
        toast(err.message, true);
      }
      refresh();
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
            await startCapture(id, key);
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
    refresh();
  }

  root.querySelectorAll('[data-start]').forEach((btn) =>
    btn.addEventListener('click', () => launchWidget(btn, btn.dataset.start, 'start', 'started'))
  );
  root.querySelectorAll('[data-stop]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Stopping…';
      try {
        await api('POST', `/api/widgets/${btn.dataset.stop}/stop`);
        toast(`${btn.dataset.stop} stopped`);
      } catch (err) {
        toast(err.message, true);
      }
      refresh();
    })
  );
  root.querySelectorAll('[data-open]').forEach((btn) =>
    btn.addEventListener('click', () => {
      location.hash = `#/widget/${btn.dataset.open}`;
    })
  );
}
