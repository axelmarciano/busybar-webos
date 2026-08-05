import { NowPlayingWidget } from '../_shared/now-playing-widget';

export default class SpotifyWidget extends NowPlayingWidget {
  static title = 'Spotify';
  static description =
    'Track currently playing in the Spotify desktop app (macOS & Windows), with progress bar.';
  static tags = ['music'];
  static author = 'axelmarciano';
  // Music widgets grouped at the end of the portal list
  static order = 10;

  static playerApp = 'spotify' as const;

  protected readonly app = 'spotify' as const;
  protected readonly iconFile = 'spotify.png';
  protected readonly accent = '#1DB954FF';
}
