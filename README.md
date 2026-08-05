# BUSY Web OS

A TypeScript "OS" for the [BUSY Bar](https://busy.bar) device: a widget runtime + web portal backed by SQLite.

![BUSY Web OS portal — widgets rendered inside the real device frame, with live screen preview](docs/portal.png)

- **Widgets** live in `widgets/<id>/` as simple classes (`class WeatherWidget extends Widget`), can bundle images, and draw on the device displays.
- **Portal** (default `http://localhost:3000`): start/stop widgets, edit per-widget config, view per-widget logs, live screen preview.
- **Global settings**: device access over USB ethernet (`http://10.0.4.20`), Wi-Fi LAN (optional access key sent as `X-API-Token`), or the BUSY cloud (`https://api.busy.app`, Bearer token from [cloud.busy.app/api-tokens](https://cloud.busy.app/api-tokens)). First run shows an onboarding page until a connection is saved; the bar's Wi-Fi HTTP access (`/access`) is manageable from the portal.

## Getting started

Run it directly:

```sh
npx busybar-webos
```

Or from a clone:

```sh
pnpm install
pnpm dev        # dev server with reload
pnpm start      # plain start
pnpm typecheck  # tsc --noEmit
```

Data (SQLite DB + your own widgets) lives in `~/.busybar-webos/` (override with `BUSYBAR_DATA_DIR`), created automatically. A git clone with an existing `data/busybar.db` keeps using `data/`. Custom widgets dropped in `~/.busybar-webos/widgets/<id>/` are loaded alongside the bundled ones and survive package updates.

## Writing a widget

Create `widgets/my_widget/index.ts`:

```ts
import { Widget } from '../../src/core/widget';

export default class MyWidget extends Widget {
  static title = 'My Widget';
  static description = 'What it does.';
  static configSchema = {
    githubApiToken: { type: 'secret' as const, label: 'GitHub token', required: true },
    refreshMinutes: { type: 'number' as const, default: 5 },
  };

  async start() {
    // optional: push an image from widgets/my_widget/assets/ to the device
    await this.uploadAsset('icon.png');

    // run immediately, then every N ms; errors are logged, loop keeps going
    this.every(Number(this.config.refreshMinutes) * 60_000, () => this.refresh());
  }

  private async refresh() {
    this.log.info('refreshing…');
    await this.draw([
      { id: 'icon', type: 'image', path: 'icon.png', x: 0, y: 0, timeout: 0 },
      { id: 'label', type: 'text', text: 'Hello', font: 'normal', x: 18, y: 8, align: 'mid_left', timeout: 0 },
    ]);
  }

  async stop() {
    // timers are cleaned up and the display cleared automatically
  }
}
```

Restart the server (or let `pnpm dev` reload) to pick up new widgets.

### Widget API

| Member | Purpose |
| --- | --- |
| `this.config` | Effective config values (schema defaults + portal overrides) |
| `this.launch` | Values from the Start modal (see launchSchema), fresh on every start |
| `this.log` | Per-widget logger (`info/warn/error/debug`), visible in the portal |
| `this.every(ms, fn)` | Run `fn` now and on an interval; auto-cleaned on stop |
| `this.draw(elements, opts?)` | Draw on the device (`application_name` injected) |
| `this.clear()` | Clear this widget's display elements |
| `this.uploadAsset(name)` | Upload `widgets/<id>/assets/<name>` to the device |
| `this.bar` | Full `BusyBarClient` (audio, brightness, input, …) |

Config field types:

| Type | Portal input | Stored value |
| --- | --- | --- |
| `string` | text (optional `pattern` regex) | string |
| `secret` | masked text | string (plain text in SQLite) |
| `number` | number | number |
| `boolean` | checkbox | boolean |
| `color` | color picker | `#RRGGBBAA` (device format) |
| `location` | "use my location" + text fallback | `"lat,lon"` |
| `select` | dropdown (requires `options: [{value, label?}]`) | string (one of the option values) |

Mark fields `required: true` to block install/start until the user explicitly sets them — a schema `default` does not satisfy a required field. Values are validated server-side on save — an invalid value (bad color, malformed coordinates, regex mismatch…) returns 400 and nothing is stored.

### Launch fields

A widget can also declare `static launchSchema` (same field format as `configSchema`). When it's non-empty, clicking **Start** in the portal opens a modal asking for those values; they are validated (`coerceLaunchValues`), passed to the widget as `this.launch`, and **not persisted** — every start asks again. Example: the `ai-pixels` widget asks for a prompt and a movie duration.

### Preview image

Widget cards in the portal show a preview of the widget's rendering if the widget ships one. Accepted locations (first match wins, extensions png/bmp/jpg/webp):

- `widgets/<id>/preview.<ext>`
- `widgets/<id>/assets/preview.<ext>`
- `widgets/<id>/assets/<id>.<ext>` (e.g. `weather/assets/weather.bmp`)

Ideal ratio is 72:16 like the front display. No file, no preview.

The front display is 72×16 px; keep drawings small. See the device OpenAPI spec for all element types (text, image, animation, countdown, rectangle).

## Installing widgets

The portal has two tabs: **Installed widgets** (startable) and **All widgets** (the catalog of everything in `widgets/`), with a search bar and tag filters. Widgets declare their categories with `static tags = ['music', 'fun']`.

- A widget with no required config installs with one click on **Install**.
- A widget with required config fields must have a valid configuration first: its page shows **Validate configuration** — if the values pass server-side validation, the widget becomes installed.
- Widgets can define their own install checks: `static validateInstall(config)` runs server-side (e.g. AI Pixels pings the configured LLM, music widgets probe the desktop player and trigger the macOS automation consent), and browser sources (e.g. the Decibel widget's microphone) request their permission in the portal before installing.
- **Uninstall** removes it from the installed list **and deletes its stored config**; only installed widgets can be started.

## Notifications

`POST /api/notify` shows a phone-style notification on the bar — icon on the left, title + scrolling text, LED blink in the icon's color, and a notification sound:

```sh
curl -X POST localhost:3000/api/notify -H 'Content-Type: application/json' \
  -d '{"title": "Deploy done", "text": "busybar-webos v1.2 is live", "icon": "success"}'
```

| Field | Default | Notes |
| --- | --- | --- |
| `text` | — | required, printable ASCII |
| `title` | none | bold first line; without it the text is centered |
| `icon` | `info` | `info` `success` `warning` `error` `message` `bell` |
| `duration` | `6` | seconds on screen (1-300) |
| `priority` | `95` | 1-100 — 95 shows over a running BUSY session |
| `sound` | on | `false` = silent, or a custom stock path (`shared/…`) |
| `led` | icon color | `#RRGGBBAA` LED blink override |

## HTTP API

The portal is a thin client over the server API:

- `GET /api/widgets`, `GET /api/widgets/:id`
- `POST /api/widgets/:id/start` (body: `{launch: {...}}` for widgets with a launchSchema), `POST /api/widgets/:id/stop`
- `POST|DELETE /api/widgets/:id/install` — install (400 if required config missing) / uninstall
- `PUT /api/widgets/:id/config`
- `GET /api/widgets/:id/logs?limit=100`
- `GET|PUT /api/settings`
- `GET /api/device/status`, `GET /api/device/screen?display=0|1`
- `POST /api/device/test` — probe a candidate connection (body: partial settings) without saving it
- `GET|POST /api/device/access` — the bar's Wi-Fi HTTP access setting (`{mode: disabled|enabled|key, key}`)
