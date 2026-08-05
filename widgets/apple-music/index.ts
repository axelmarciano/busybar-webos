import { NowPlayingWidget } from '../_shared/now-playing-widget';

export default class AppleMusicWidget extends NowPlayingWidget {
  static title = 'Apple Music';
  static description =
    'Track currently playing in Apple Music (macOS & Windows, iTunes included), with progress bar.';
  // Music widgets grouped at the end of the portal list
  static order = 10;

  protected readonly app = 'apple-music' as const;
  protected readonly iconFile = 'applemusic.png';
  protected readonly accent = '#FA2D48FF';
}
