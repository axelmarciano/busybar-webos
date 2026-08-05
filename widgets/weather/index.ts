import { Widget } from '../../src/core/widget';
import type { DisplayElement } from '../../src/busybar/client';

interface OpenMeteoResponse {
  current_weather: {
    temperature: number;
    weathercode: number;
  };
  daily?: {
    time: string[];
    weathercode: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
  };
}

interface Condition {
  label: string;
  icon: string;
}

/** WMO weather codes → label + 16x16 icon from assets/ */
function condition(code: number): Condition {
  if (code === 0) return { label: 'Clear', icon: 'sun.png' };
  if (code <= 2) return { label: 'Partly', icon: 'partly.png' };
  if (code === 3) return { label: 'Cloudy', icon: 'cloud.png' };
  if (code <= 48) return { label: 'Fog', icon: 'fog.png' };
  if (code <= 57) return { label: 'Drizzle', icon: 'showers.png' };
  if (code <= 67) return { label: 'Rain', icon: 'rain.png' };
  if (code <= 77) return { label: 'Snow', icon: 'snow.png' };
  if (code <= 82) return { label: 'Showers', icon: 'showers.png' };
  if (code <= 86) return { label: 'Snow', icon: 'snow.png' };
  return { label: 'Storm', icon: 'storm.png' };
}

const ICON_FILES = [
  'sun.png', 'partly.png', 'cloud.png', 'fog.png',
  'rain.png', 'showers.png', 'snow.png', 'storm.png',
];

const PAGE_SECONDS = 6;
/** Vertical slide: y offsets of successive animation frames (16 = one full screen) */
const SLIDE_STEPS = [2, 4, 6, 8, 10, 12, 14, 16];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default class WeatherWidget extends Widget {
  static title = 'Weather';
  static description = 'Current conditions + forecast via Open-Meteo, full-screen rotating pages.';
  static tags = ['weather', 'info'];
  static author = 'axelmarciano';
  static configSchema = {
    location: {
      type: 'location' as const,
      label: 'Location',
      required: true,
    },
  };

  private pages: DisplayElement[][] = [];
  private pageIndex = 0;
  private lastPage: DisplayElement[] | null = null;
  /** Alternating id suffix so old and new page elements coexist during the slide */
  private generation = 0;
  private animating = false;

  async start(): Promise<void> {
    for (const file of ICON_FILES) {
      await this.uploadAsset(file);
    }
    this.every(10 * 60_000, () => this.refresh());
    this.every(PAGE_SECONDS * 1_000, () => this.showNextPage());
  }

  /** Fetches weather data and rebuilds the full-screen pages. */
  private async refresh(): Promise<void> {
    const [latitude, longitude] = String(this.config.location).split(',').map(Number);
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current_weather=true&forecast_days=2&timezone=auto` +
      `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Open-Meteo → HTTP ${res.status}`);
    const data = (await res.json()) as OpenMeteoResponse;

    const now = condition(data.current_weather.weathercode);
    const temp = Math.round(data.current_weather.temperature);
    const daily = data.daily;

    const pages: DisplayElement[][] = [];

    // Page 1 — now: icon + big temperature + condition
    pages.push([
      { id: 'icon', type: 'image', path: now.icon, x: 0, y: 0, timeout: 0 },
      {
        id: 'l1', type: 'text', text: `${temp}C`, font: 'large',
        color: '#FFFFFFFF', align: 'mid_left', x: 20, y: 8, timeout: 0,
      },
      {
        id: 'l2', type: 'text', text: now.label, font: 'small',
        color: '#8A93A6FF', align: 'mid_left', x: 46, y: 8, timeout: 0,
      },
    ]);

    if (daily) {
      const range = (day: number) =>
        `${Math.round(daily.temperature_2m_min[day])} to ${Math.round(daily.temperature_2m_max[day])}C`;

      // Page 2 — today's range
      pages.push([
        { id: 'icon', type: 'image', path: now.icon, x: 0, y: 0, timeout: 0 },
        {
          id: 'l1', type: 'text', text: 'Today', font: 'small',
          color: '#8A93A6FF', x: 19, y: 1, timeout: 0,
        },
        {
          id: 'l2', type: 'text', text: range(0), font: 'small',
          color: '#FFFFFFFF', x: 19, y: 9, timeout: 0,
        },
      ]);

      // Page 3 — rain risk today (only when the API provides it)
      const rain = daily.precipitation_probability_max?.[0];
      if (rain != null) {
        pages.push([
          { id: 'icon', type: 'image', path: 'rain.png', x: 0, y: 0, timeout: 0 },
          {
            id: 'l1', type: 'text', text: 'Rain today', font: 'small',
            color: '#8A93A6FF', x: 19, y: 1, timeout: 0,
          },
          {
            id: 'l2', type: 'text', text: `${rain}% chance`, font: 'small',
            color: '#FFFFFFFF', x: 19, y: 9, timeout: 0,
          },
        ]);
      }

      // Page 4 — tomorrow: its icon + range
      if (daily.weathercode.length > 1) {
        const tomorrow = condition(daily.weathercode[1]);
        pages.push([
          { id: 'icon', type: 'image', path: tomorrow.icon, x: 0, y: 0, timeout: 0 },
          {
            id: 'l1', type: 'text', text: 'Tomorrow', font: 'small',
            color: '#8A93A6FF', x: 19, y: 1, timeout: 0,
          },
          {
            id: 'l2', type: 'text', text: range(1), font: 'small',
            color: '#FFFFFFFF', x: 19, y: 9, timeout: 0,
          },
        ]);
      }
    }

    const firstLoad = this.pages.length === 0;
    this.pages = pages;
    this.pageIndex = 0;
    this.log.info(`${temp}C ${now.label} — ${pages.length} page(s) rebuilt`);
    if (firstLoad) await this.showNextPage();
  }

  /** Shifts a page's elements vertically and tags ids with a generation suffix. */
  private shifted(
    page: DisplayElement[],
    generation: number,
    dy: number,
    timeout: number
  ): DisplayElement[] {
    return page.map((el) => ({
      ...el,
      id: `${el.id}_${generation}`,
      y: (el.y ?? 0) + dy,
      timeout,
    })) as DisplayElement[];
  }

  /**
   * Slides to the next full-screen page: the current page moves up and off
   * screen while the next one rises from the bottom, one draw per frame.
   * The old elements end fully off-screen with a 1s timeout so the device
   * removes them without ever blanking the visible area.
   */
  private async showNextPage(): Promise<void> {
    if (this.pages.length === 0 || this.animating) return;
    const page = this.pages[this.pageIndex % this.pages.length];
    this.pageIndex = (this.pageIndex + 1) % this.pages.length;

    this.animating = true;
    try {
      if (!this.lastPage) {
        await this.draw(this.shifted(page, this.generation, 0, 0));
      } else {
        const oldGeneration = this.generation;
        this.generation = (this.generation + 1) % 2;
        for (const step of SLIDE_STEPS) {
          const isLast = step === 16;
          await this.draw([
            ...this.shifted(this.lastPage, oldGeneration, -step, isLast ? 1 : 0),
            ...this.shifted(page, this.generation, 16 - step, 0),
          ]);
          if (!isLast) await sleep(15);
        }
      }
      this.lastPage = page;
    } finally {
      this.animating = false;
    }
  }
}
