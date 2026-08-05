import express, { type NextFunction, type Request, type Response } from 'express';
import { deviceFrameToBmp } from './frame';
import { publicDir } from './paths';
import { previewFile } from './core/preview';
import { bar, BusyBarClient, type HttpAccessMode } from './busybar/client';
import {
  clearWidgetConfig,
  getEffectiveConfig,
  getStoredConfig,
  missingRequiredKeys,
  setWidgetConfig,
} from './core/config';
import { installWidget, isInstalled, uninstallWidget } from './core/installed';
import {
  clearNotifications,
  listNotifications,
  NOTIFY_ICONS,
  sendNotification,
  type NotifyOptions,
} from './core/notify';
import { getLogs } from './core/logger';
import { registry, resolveLaunchSchema } from './core/registry';
import { runtime } from './core/runtime';
import { getSettings, updateSettings, type Settings } from './settings';

export function createServer(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.static(publicDir));

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
        tags: def.tags,
        installed: isInstalled(def.id),
        config_ok: missingRequiredKeys(def.id, def.configSchema).length === 0,
        launchSchema: resolveLaunchSchema(def),
        browser_sources: def.browserSources,
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
      tags: def.tags,
      installed: isInstalled(def.id),
      missing_required: missingRequiredKeys(def.id, def.configSchema),
      configSchema: def.configSchema,
      launchSchema: resolveLaunchSchema(def),
      browser_sources: def.browserSources,
      config: getStoredConfig(def.id),
      has_preview: previewFile(def.id) !== null,
      ...runtime.statusOf(def.id),
    });
  });

  // Install = the widget appears in "Installed widgets" and becomes startable.
  // Requires a valid config (all required fields set) AND the widget's own
  // validateInstall() check when it defines one (LLM access, platform, consent…).
  app.post('/api/widgets/:id/install', wrap(async (req, res) => {
    const def = registry.get(req.params.id);
    if (!def) {
      res.status(404).json({ error: 'Unknown widget' });
      return;
    }
    const missing = missingRequiredKeys(def.id, def.configSchema);
    if (missing.length > 0) {
      res.status(400).json({ error: `Configuration required before install: ${missing.join(', ')}` });
      return;
    }
    try {
      const effective = getEffectiveConfig(def.id, def.configSchema);
      def.ctor.validateConfig?.(effective);
      await def.ctor.validateInstall?.(effective);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    installWidget(def.id);
    res.json({ result: 'OK' });
  }));

  // Uninstall also drops the widget's stored configuration
  app.delete('/api/widgets/:id/install', wrap(async (req, res) => {
    if (!registry.get(req.params.id)) {
      res.status(404).json({ error: 'Unknown widget' });
      return;
    }
    if (runtime.isRunning(req.params.id)) {
      await runtime.stop(req.params.id).catch(() => {});
    }
    uninstallWidget(req.params.id);
    clearWidgetConfig(req.params.id);
    res.json({ result: 'OK' });
  }));

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

  app.post('/api/widgets/:id/message', (req, res) => {
    try {
      runtime.deliver(req.params.id, req.body ?? {});
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    res.json({ result: 'OK' });
  });

  app.put('/api/widgets/:id/config', (req, res) => {
    const def = registry.get(req.params.id);
    if (!def) {
      res.status(404).json({ error: 'Unknown widget' });
      return;
    }
    try {
      setWidgetConfig(def.id, def.configSchema, req.body ?? {}, (finalConfig) =>
        def.ctor.validateConfig?.(finalConfig)
      );
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

  // Connection changes are probed first — an unreachable configuration is never saved
  const CONNECTION_KEYS: (keyof Settings)[] = [
    'access_mode', 'local_url', 'wifi_url', 'cloud_url', 'cloud_token', 'api_token',
  ];
  app.put('/api/settings', wrap(async (req, res) => {
    const patch = (req.body ?? {}) as Partial<Settings>;
    if (CONNECTION_KEYS.some((key) => patch[key] !== undefined)) {
      const candidate: Settings = { ...getSettings(), ...patch };
      const probe = new BusyBarClient(() => candidate);
      try {
        await probe.version();
      } catch {
        res.status(400).json({
          error: 'The bar is unreachable with this configuration — settings not saved',
        });
        return;
      }
    }
    res.json(updateSettings(patch));
  }));

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

  // Phone-style notification on the bar: icon + title + text, LED blink, sound
  app.post('/api/notify', wrap(async (req, res) => {
    const body = (req.body ?? {}) as Partial<NotifyOptions> & { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json({ error: '"text" is required' });
      return;
    }
    if (body.icon !== undefined && !NOTIFY_ICONS.includes(body.icon as never)) {
      res.status(400).json({ error: `"icon" must be one of: ${NOTIFY_ICONS.join(', ')}` });
      return;
    }
    try {
      await sendNotification(body as NotifyOptions);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    res.json({ result: 'OK' });
  }));

  app.get('/api/notify', (req, res) => {
    res.json(listNotifications(Number(req.query.limit) || 100));
  });

  app.delete('/api/notify', (_req, res) => {
    clearNotifications();
    res.json({ result: 'OK' });
  });

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
