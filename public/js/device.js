/* Sidebar device chrome: status polling, live screen preview, full-screen overlay.
   This module is the only writer of #device-status / #preview-wrap / #screen-preview*. */

import { api } from './helpers.js';

export async function refreshDeviceStatus() {
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

export function initDevice() {
  setInterval(refreshDeviceStatus, 5000);
  refreshDeviceStatus();
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
}
