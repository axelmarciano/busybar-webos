import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { deviceFrameToBmp } from './frame';
import { previewFile } from './core/preview';
import { bar, BusyBarClient, type HttpAccessMode } from './busybar/client';
import { getStoredConfig, setWidgetConfig } from './core/config';
import { getLogs } from './core/logger';
import { registry } from './core/registry';
import { runtime } from './core/runtime';
import { getSettings, updateSettings, type Settings } from './settings';

export function createServer(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.resolve('public')));

  const wrap =
    (fn: (req: Request, res: Response) => Promise<void> | void) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res)).catch(next);
    };

  // --- Widgets ---
  app.get('/api/widgets', (_req, res) => {
    res.json(
      registry.list().map((def) => ({
        id: def.id,
        title: def.title,
        description: def.description,
        launchSchema: def.launchSchema,
        has_preview: previewFile(def.id) !== null,
        ...runtime.statusOf(def.id),
      }))
    );
  });

  app.get('/api/widgets/:id', (req, res) => {
    const def = registry.get(req.params.id);
    if (!def) {
      res.status(404).json({ error: 'Unknown widget' });
      return;
    }
    res.json({
      id: def.id,
      title: def.title,
      description: def.description,
      configSchema: def.configSchema,
      launchSchema: def.launchSchema,
      config: getStoredConfig(def.id),
      has_preview: previewFile(def.id) !== null,
      ...runtime.statusOf(def.id),
    });
  });

  app.get('/api/widgets/:id/preview', (req, res) => {
    const file = previewFile(req.params.id);
    if (!file) {
      res.status(404).json({ error: 'No preview available' });
      return;
    }
    res.sendFile(file);
  });

  app.post('/api/widgets/:id/start', wrap(async (req, res) => {
    const { launch } = (req.body ?? {}) as { launch?: Record<string, unknown> };
    await runtime.start(req.params.id, launch ?? {});
    res.json({ result: 'OK' });
  }));

  app.post('/api/widgets/:id/stop', wrap(async (req, res) => {
    await runtime.stop(req.params.id);
    res.json({ result: 'OK' });
  }));

  app.put('/api/widgets/:id/config', (req, res) => {
    const def = registry.get(req.params.id);
    if (!def) {
      res.status(404).json({ error: 'Unknown widget' });
      return;
    }
    try {
      setWidgetConfig(def.id, def.configSchema, req.body ?? {});
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    res.json({ result: 'OK' });
  });

  app.get('/api/widgets/:id/logs', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(getLogs(req.params.id, limit));
  });

  // --- Global settings ---
  app.get('/api/settings', (_req, res) => {
    res.json(getSettings());
  });

  app.put('/api/settings', (req, res) => {
    res.json(updateSettings((req.body ?? {}) as Partial<Settings>));
  });

  // --- Device proxy (for the portal) ---
  app.get('/api/device/status', wrap(async (_req, res) => {
    res.json(await bar.status());
  }));

  // Probe a candidate connection (form values merged over saved settings) without saving it
  app.post('/api/device/test', wrap(async (req, res) => {
    const candidate: Settings = { ...getSettings(), ...((req.body ?? {}) as Partial<Settings>) };
    const probe = new BusyBarClient(() => candidate);
    const version = await probe.version();
    const status = await probe.status().catch(() => ({} as Record<string, unknown>));
    res.json({ ok: true, api_semver: version.api_semver, status });
  }));

  app.get('/api/device/access', wrap(async (_req, res) => {
    res.json(await bar.access());
  }));

  app.post('/api/device/access', wrap(async (req, res) => {
    const { mode, key } = (req.body ?? {}) as { mode?: HttpAccessMode; key?: string };
    if (!mode || !['disabled', 'enabled', 'key'].includes(mode)) {
      res.status(400).json({ error: 'mode must be disabled, enabled or key' });
      return;
    }
    await bar.setAccess(mode, key);
    // Mirror the key into the portal's Wi-Fi settings so its own requests keep working
    if (mode === 'key' && key) updateSettings({ api_token: key });
    res.json({ result: 'OK' });
  }));

  app.get('/api/device/screen', wrap(async (req, res) => {
    const display = req.query.display === '1' ? 1 : 0;
    const frame = await bar.screen(display);
    res.type('image/bmp').send(deviceFrameToBmp(frame.data));
  }));

  // --- Error handling ---
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}
