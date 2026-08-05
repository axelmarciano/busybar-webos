/* Notifications page: send a notification to the bar + history */

import { api, esc, toast } from '../helpers.js';
import { refresh } from '../router.js';

const NOTIFY_ICONS = ['info', 'success', 'warning', 'error', 'message', 'bell'];

export async function render({ root, alive }) {
  const items = await api('GET', '/api/notify');
  if (!alive()) return;

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

  root.innerHTML = `
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
      refresh();
      return;
    } catch (err) {
      toast(err.message, true);
    }
    submitBtn.disabled = false;
  });

  document.getElementById('clear-notifs')?.addEventListener('click', async () => {
    await api('DELETE', '/api/notify');
    toast('History cleared');
    refresh();
  });
}
