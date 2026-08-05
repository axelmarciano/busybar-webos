/* Browser sources: data only the browser can capture (mic level, buzzer press),
   streamed to the running widget as POST /api/widgets/<id>/message {source, ...data}.

   A widget declares what it consumes with `static browserSources = ['microphone']`;
   the widget page renders a capture panel per source. Adding a source = adding an
   entry to the registry below; nothing else changes.

   A source implements:
     title / hint / enableLabel / disableLabel — panel texts
     liveHtml — markup for its live visualization inside the panel
     permissionGranted()? — true when capture can start without prompting
     ensurePermission()? — install-time gate, throws a user-readable Error
     start(emit, live) → cleanup function. Throws a user-readable Error when the
       capture can't start. `emit(data)` streams to the widget; `live()` returns
       the panel's live container, or null when not displayed.

   This module is the sole owner of running captures. Captures survive page
   changes inside the portal; they stop when the tab closes, the widget stops
   (409 on emit), or the user clicks the toggle. */

import { api, esc, toast } from './helpers.js';

export const browserSources = {
  microphone: {
    title: 'Microphone',
    hint: 'Sound is captured by this browser tab and streamed to the bar — keep the tab open. Enabling the microphone also starts the widget if needed.',
    enableLabel: '🎤 Enable microphone',
    disableLabel: 'Stop microphone',
    liveHtml: '<div class="mic-meter"><i data-mic-fill></i></div><span class="source-value" data-mic-value></span>',

    /** True when the browser already granted mic access — capture can auto-start. */
    async permissionGranted() {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' });
        return status.state === 'granted';
      } catch {
        return false;
      }
    },

    /** Install-time check: the widget only installs once mic access is granted. */
    async ensurePermission() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone needs a secure context — open the portal via localhost or https');
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        throw new Error('Microphone access denied — allow it in the browser to install this widget');
      }
    },

    async start(emit, live) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone needs a secure context — open the portal via localhost or https');
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch {
        throw new Error('Microphone access denied — allow it in the browser and retry');
      }
      const audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);

      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const dbfs = rms > 0 ? Math.max(20 * Math.log10(rms), -100) : -100;
        emit({ level: dbfs });
        const el = live();
        if (el) {
          const pct = Math.min(Math.max((dbfs + 60) / 60, 0), 1) * 100;
          el.querySelector('[data-mic-fill]').style.width = `${pct}%`;
          el.querySelector('[data-mic-value]').textContent = `${dbfs.toFixed(1)} dBFS`;
        }
      }, 200);

      return () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        audioCtx.close().catch(() => {});
      };
    },
  },

  buzzer: {
    title: 'Buzzer button',
    hint: 'Smash the button (or hit Space) — the bar flashes and makes the noise. Open this page on your phone for a wireless game-show buzzer.',
    enableLabel: '🔴 Arm the buzzer',
    disableLabel: 'Disarm',
    liveHtml: '<button type="button" class="buzzer-btn" data-buzz>BUZZ</button>',

    async start(emit, live) {
      const pulse = () => {
        const btn = live() && live().querySelector('[data-buzz]');
        if (!btn) return;
        btn.classList.add('pressed');
        setTimeout(() => btn.classList.remove('pressed'), 150);
      };
      const press = () => {
        emit({ press: true });
        pulse();
        if (navigator.vibrate) navigator.vibrate(80);
      };
      // Delegated listeners: survive panel re-renders and page navigation
      const onClick = (e) => {
        if (e.target.closest && e.target.closest('[data-buzz]')) press();
      };
      const onKey = (e) => {
        if (e.code === 'Space' && live() && !e.repeat && e.target.tagName !== 'INPUT') {
          e.preventDefault();
          press();
        }
      };
      document.addEventListener('click', onClick);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey);
      };
    },
  },
};

/** Requests every browser permission a widget's sources need (install-time gate). */
export async function ensureBrowserPermissions(widget) {
  for (const name of (widget && widget.browser_sources) || []) {
    const source = browserSources[name];
    if (source && source.ensurePermission) await source.ensurePermission();
  }
}

// --- Capture manager ---
// "widgetId:source" → { cleanup, stopped }. The key is reserved synchronously
// BEFORE source.start() is awaited, so a concurrent start (auto-start racing a
// click) sees it and backs off instead of leaking a second live capture.
const active = new Map();
const keyOf = (widgetId, source) => `${widgetId}:${source}`;

export function isCaptureActive(widgetId, source) {
  return active.has(keyOf(widgetId, source));
}

export async function startCapture(widgetId, source) {
  const key = keyOf(widgetId, source);
  if (active.has(key)) return;
  const entry = { cleanup: null, stopped: false };
  active.set(key, entry);

  const emit = async (data) => {
    try {
      const res = await fetch(`/api/widgets/${widgetId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, ...data }),
      });
      if (res.status === 409) stopCapture(widgetId, source); // widget no longer running
    } catch {
      // server briefly unreachable — keep trying
    }
  };
  const live = () => document.querySelector(`[data-source-panel="${source}"] .source-live`);

  try {
    entry.cleanup = await browserSources[source].start(emit, live);
  } catch (err) {
    active.delete(key);
    syncSourcePanels();
    throw err;
  }
  if (entry.stopped) {
    // stopCapture() ran while start was in flight
    active.delete(key);
    entry.cleanup();
  }
  syncSourcePanels();
}

export function stopCapture(widgetId, source) {
  const key = keyOf(widgetId, source);
  const entry = active.get(key);
  if (!entry) return;
  if (entry.cleanup) {
    active.delete(key);
    entry.cleanup();
  } else {
    entry.stopped = true; // start still in flight — it cleans up on arrival
  }
  syncSourcePanels();
}

// --- Capture panels (widget page UI) ---

export function sourcePanelsHtml(widget) {
  return (widget.browser_sources || [])
    .filter((key) => browserSources[key])
    .map((key) => {
      const source = browserSources[key];
      return `
        <h2>${esc(source.title)}</h2>
        <div class="panel" data-source-panel="${esc(key)}" data-widget="${esc(widget.id)}">
          <p class="hint" style="margin-top: 0;">${esc(source.hint)}</p>
          <div class="source-row">
            <button type="button" data-source-toggle></button>
            <div class="source-live">${source.liveHtml}</div>
          </div>
        </div>
      `;
    }).join('');
}

/** Syncs every source panel currently in the DOM with its capture state. */
export function syncSourcePanels() {
  document.querySelectorAll('[data-source-panel]').forEach((panel) => {
    const source = browserSources[panel.dataset.sourcePanel];
    const activeNow = isCaptureActive(panel.dataset.widget, panel.dataset.sourcePanel);
    const btn = panel.querySelector('[data-source-toggle]');
    btn.textContent = activeNow ? source.disableLabel : source.enableLabel;
    btn.classList.toggle('primary', !activeNow);
    panel.querySelector('.source-live').style.display = activeNow ? 'flex' : 'none';
  });
}

export function mountSourcePanels(widget) {
  document.querySelectorAll('[data-source-panel]').forEach((panel) => {
    const key = panel.dataset.sourcePanel;
    panel.querySelector('[data-source-toggle]').addEventListener('click', async (e) => {
      if (isCaptureActive(widget.id, key)) {
        stopCapture(widget.id, key);
        return;
      }
      e.target.disabled = true;
      try {
        // The capture streams into the running widget — start it first if needed
        const fresh = await api('GET', `/api/widgets/${widget.id}`).catch(() => null);
        if (fresh && fresh.state !== 'running') {
          await api('POST', `/api/widgets/${widget.id}/start`, { launch: {} });
          toast(`${widget.id} started`);
        }
        await startCapture(widget.id, key);
      } catch (err) {
        toast(err.message, true);
      }
      e.target.disabled = false;
      syncSourcePanels();
    });
  });
  syncSourcePanels();

  // Permission already granted + widget running → capture starts by itself,
  // no pointless "enable" click
  (widget.browser_sources || []).forEach(async (key) => {
    const source = browserSources[key];
    if (!source || isCaptureActive(widget.id, key)) return;
    if (widget.state === 'running' && source.permissionGranted && (await source.permissionGranted())) {
      try {
        await startCapture(widget.id, key);
      } catch {
        // stays manual — the toggle button is right there
      }
    }
  });
}
