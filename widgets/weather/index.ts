import { Widget } from '../../src/core/widget';

interface OpenMeteoResponse {
  current_weather: {
    temperature: number;
    weathercode: number;
  };
}

/** Rough mapping of Open-Meteo weather codes to a short label. */
function weatherLabel(code: number): string {
  if (code === 0) return 'Sunny';
  if (code <= 3) return 'Cloudy';
  if (code <= 48) return 'Fog';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Showers';
  return 'Storm';
}

export default class WeatherWidget extends Widget {
  static title = 'Weather';
  static description = 'Temperature and conditions via Open-Meteo (no API key needed).';
  static configSchema = {
    latitude: { type: 'number' as const, label: 'Latitude', required: true, default: 48.8566 },
    longitude: { type: 'number' as const, label: 'Longitude', required: true, default: 2.3522 },
  };

  async start(): Promise<void> {
    // The icon bundled in widgets/weather/assets/ is pushed to the device
    await this.uploadAsset('sun.png').catch((err) =>
      this.log.warn(`Could not upload icon: ${err.message}`)
    );
    this.every(10 * 60_000, () => this.refresh());
  }

  private async refresh(): Promise<void> {
    const { latitude, longitude } = this.config;
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}` +
      `&longitude=${longitude}&current_weather=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Open-Meteo → HTTP ${res.status}`);
    const data = (await res.json()) as OpenMeteoResponse;

    const temp = Math.round(data.current_weather.temperature);
    const label = weatherLabel(data.current_weather.weathercode);
    this.log.info(`Weather: ${temp}°C, ${label}`);

    await this.draw([
      { id: 'icon', type: 'image', path: 'sun.png', x: 0, y: 0, timeout: 0 },
      {
        id: 'temp',
        type: 'text',
        text: `${temp}C ${label}`,
        font: 'normal',
        align: 'mid_left',
        x: 18,
        y: 8,
        timeout: 0,
      },
    ]);
  }
}
