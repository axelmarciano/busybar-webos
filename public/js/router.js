/* Hash router. Owns the page lifecycle:
   - navigation epoch: a render that resolves after another navigation is
     discarded instead of overwriting the current page (pages check `alive()`
     after their fetches; handlers re-render via refresh(), never directly)
   - cleanup: a page may return a function (e.g. clearing its polling timer),
     called on the next navigation. */

import { esc } from './helpers.js';
import * as widgets from './pages/widgets.js';
import * as widgetDetail from './pages/widget-detail.js';
import * as settings from './pages/settings.js';
import * as notifications from './pages/notifications.js';
import * as apiDocs from './pages/api-docs.js';

const app = document.getElementById('app');
let epoch = 0;
let cleanup = null;

/** Re-renders the current page (used by handlers after a mutation). */
export function refresh() {
  route();
}

export function startRouter() {
  window.addEventListener('hashchange', route);
  route();
}

async function route() {
  const my = ++epoch;
  const alive = () => my === epoch;
  if (cleanup) {
    cleanup();
    cleanup = null;
  }

  const hash = location.hash || '#/widgets';
  const widgetMatch = hash.match(/^#\/widget\/([a-zA-Z0-9._-]+)$/);

  document.querySelectorAll('nav a').forEach((a) => {
    a.classList.toggle('active', hash.startsWith(a.getAttribute('href')) || (widgetMatch && a.dataset.nav === 'widgets'));
  });

  const ctx = { root: app, alive };
  try {
    let next;
    if (widgetMatch) next = await widgetDetail.render({ ...ctx, params: { id: widgetMatch[1] } });
    else if (hash === '#/api') next = apiDocs.render(ctx);
    else if (hash === '#/notifications') next = await notifications.render(ctx);
    else if (hash === '#/settings') next = await settings.render(ctx);
    else if (hash === '#/widgets/all') next = await widgets.render({ ...ctx, params: { tab: 'all' } });
    else next = await widgets.render({ ...ctx, params: { tab: 'installed' } });

    if (typeof next === 'function') {
      if (alive()) cleanup = next;
      else next(); // page superseded while mounting — release its resources
    }
  } catch (err) {
    if (alive()) app.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}
