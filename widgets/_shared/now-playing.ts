import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type PlayerApp = 'spotify' | 'apple-music';

export interface NowPlaying {
  state: 'playing' | 'paused' | 'idle';
  title?: string;
  artist?: string;
  /** Seconds into the track; absent when the player does not report it */
  position?: number;
  /** Track length in seconds; absent when unknown */
  duration?: number;
}

/** macOS scripting target per app. */
const MAC_APP: Record<PlayerApp, string> = {
  spotify: 'Spotify',
  'apple-music': 'Music',
};

/** Windows SMTC session match (SourceAppUserModelId, case-insensitive). */
const WIN_PATTERN: Record<PlayerApp, string> = {
  spotify: 'spotify',
  'apple-music': 'applemusic|itunes',
};

export function platformSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

/** macOS refused to let us control the player (TCC automation permission). */
export class AutomationDeniedError extends Error {}

/**
 * Opens System Settings on the Privacy > Automation pane so the user can
 * re-enable control after a previous "Don't Allow". macOS never re-prompts
 * a denied app, and there is no API to grant the permission programmatically.
 */
export async function openAutomationSettings(): Promise<void> {
  if (process.platform !== 'darwin') return;
  await run('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Automation']);
}

/** Asks the local desktop player what is currently playing. */
export async function queryNowPlaying(app: PlayerApp): Promise<NowPlaying> {
  return process.platform === 'darwin' ? queryMac(app) : queryWindows(app);
}

const num = (s: string): number | undefined => {
  // AppleScript uses the system locale for decimals (comma on French macOS)
  const v = parseFloat(s.replace(',', '.'));
  return Number.isFinite(v) ? v : undefined;
};

async function queryMac(app: PlayerApp): Promise<NowPlaying> {
  const name = MAC_APP[app];
  const script = `if application "${name}" is not running then return "idle"
tell application "${name}"
	set ps to (player state as text)
	if ps is not "playing" and ps is not "paused" then return "idle"
	return ps & linefeed & name of current track & linefeed & artist of current track & linefeed & (player position as text) & linefeed & (duration of current track as text)
end tell`;
  let stdout: string;
  try {
    ({ stdout } = await run('osascript', ['-e', script]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // TCC automation permission denied (or never granted)
    if (message.includes('-1743')) {
      throw new AutomationDeniedError(
        `macOS denied control of ${name} — enable it in the Automation settings that just opened`
      );
    }
    throw err;
  }
  const lines = stdout.trimEnd().split('\n');
  if (lines.length < 5) return { state: 'idle' };

  // Read fixed fields from both ends so a linefeed inside the track title
  // cannot shift the artist/position/duration fields.
  const state = lines[0] === 'paused' ? ('paused' as const) : ('playing' as const);
  const title = lines.slice(1, lines.length - 3).join(' ');
  const artist = lines[lines.length - 3];
  const position = num(lines[lines.length - 2]);
  let duration = num(lines[lines.length - 1]);
  if (app === 'spotify' && duration !== undefined) duration /= 1000; // Spotify reports ms

  return {
    state,
    title: title === 'missing value' ? '' : title,
    artist: artist === 'missing value' ? '' : artist,
    position,
    duration,
  };
}

/**
 * Windows: Global System Media Transport Controls (the "now playing" panel),
 * queried through WinRT from Windows PowerShell 5.1 (pwsh cannot project WinRT).
 */
const PS_SCRIPT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
foreach ($s in $mgr.GetSessions()) {
  if ($s.SourceAppUserModelId -notmatch '__PATTERN__') { continue }
  $m = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $tl = $s.GetTimelineProperties()
  @{
    state = $s.GetPlaybackInfo().PlaybackStatus.ToString()
    title = $m.Title
    artist = $m.Artist
    position = [math]::Round($tl.Position.TotalSeconds)
    duration = [math]::Round($tl.EndTime.TotalSeconds)
  } | ConvertTo-Json -Compress
  exit
}
Write-Output '{"state":"idle"}'
`;

async function queryWindows(app: PlayerApp): Promise<NowPlaying> {
  const script = PS_SCRIPT.replace('__PATTERN__', WIN_PATTERN[app]);
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const raw = JSON.parse(stdout.trim() || '{}') as {
    state?: string;
    title?: string;
    artist?: string;
    position?: number;
    duration?: number;
  };
  const state =
    raw.state === 'Playing' ? ('playing' as const)
    : raw.state === 'Paused' ? ('paused' as const)
    : ('idle' as const);
  if (state === 'idle' || !raw.title) return { state: 'idle' };
  return {
    state,
    title: raw.title,
    artist: raw.artist ?? '',
    position: raw.position || undefined,
    duration: raw.duration || undefined,
  };
}
