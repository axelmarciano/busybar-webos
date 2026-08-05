import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { deviceFrameToBmp } from './frame';
import { previewFile } from './core/preview';
import { bar } from './busybar/client';
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
    await runtime.start(req.params.id);
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
    setWidgetConfig(def.id, def.configSchema, req.body ?? {});
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
