/* Stateless helpers + the toast (which owns its timer) */

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

let toastTimer;
export function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

export const STATE_LABELS = {
  starting: 'Starting…',
  running: 'Running',
  stopping: 'Stopping…',
  stopped: 'Stopped',
  error: 'Error',
};
