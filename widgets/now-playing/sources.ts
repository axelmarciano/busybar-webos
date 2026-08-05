import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Universal "now playing" access — reads and controls whatever the OS says is
 * playing, from any app.
 *
 * macOS: `media-control` (https://github.com/ungive/media-control), a CLI over
 * the private MediaRemote framework that still works on macOS 15.4+ — covers
 * every source (Spotify, Music, browsers, VLC, TIDAL…). When it is not
 * installed, falls back to AppleScript against Spotify and Apple Music only.
 *
 * Windows: Global System Media Transport Controls (the system "now playing"
 * panel) — universal by design, queried through WinRT from Windows
 * PowerShell 5.1 (pwsh cannot project WinRT).
 */

export interface NowPlayingState {
  state: 'playing' | 'paused' | 'idle';
  title?: string;
  artist?: string;
  /** Seconds into the track; absent when the source does not report it */
  position?: number;
  /** Track length in seconds; absent when unknown */
  duration?: number;
  /** Lowercased app identifier — macOS bundle id or Windows AUMID */
  sourceId?: string;
}

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

/** Reads whatever the system reports as now playing. */
export async function readNowPlaying(): Promise<NowPlayingState> {
  return process.platform === 'darwin' ? readMac() : readWindows();
}

/** Toggles play/pause on the current system media session. */
export async function togglePlayPause(sourceId?: string): Promise<void> {
  if (process.platform === 'darwin') {
    const mc = await mediaControl();
    if (mc) {
      await run(mc, ['toggle-play-pause']);
      return;
    }
    // Fallback: only scriptable players are reachable
    const name = scriptableName(sourceId);
    const names = name ? [name] : SCRIPTABLE_IDS.map((id) => MAC_APP_NAME[id]);
    for (const app of names) await macPlayerCommand(app, 'playpause');
    return;
  }
  await runPs(PS_SMTC_PREAMBLE + PS_TOGGLE);
}

/**
 * Changes the volume by `delta` (positive = louder). Scriptable players
 * (Spotify, Apple Music) get their own player volume on macOS; every other
 * source gets the system output volume. Windows has no per-app volume in the
 * SMTC, so it presses the system volume keys (one press = 2 volume units).
 */
export async function adjustVolume(delta: number, sourceId?: string): Promise<void> {
  if (delta === 0) return;
  const step = Math.round(delta);
  if (process.platform === 'darwin') {
    const appName = scriptableName(sourceId);
    if (appName) {
      return macPlayerCommand(
        appName,
        `set v to (sound volume) + ${step}
		if v > 100 then set v to 100
		if v < 0 then set v to 0
		set sound volume to v`
      );
    }
    await runOsascript(`set cur to output volume of (get volume settings)
set v to cur + ${step}
if v > 100 then set v to 100
if v < 0 then set v to 0
set volume output volume v`);
    return;
  }
  const presses = Math.max(1, Math.round(Math.abs(step) / 2));
  const vk = step > 0 ? '0xAF' : '0xAE'; // VK_VOLUME_UP / VK_VOLUME_DOWN
  await runPs(PS_VOLUME.replace('__COUNT__', String(presses)).replace(/__VK__/g, vk));
}

/** True when the universal reader (media-control) is available on this Mac. */
export async function hasMediaControl(): Promise<boolean> {
  return (await mediaControl()) !== null;
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

/** Bundle ids of the AppleScript-controllable players used by the fallback. */
const SCRIPTABLE_IDS = ['com.spotify.client', 'com.apple.music'];

const MAC_APP_NAME: Record<string, string> = {
  'com.spotify.client': 'Spotify',
  'com.apple.music': 'Music',
};

/** AppleScript app name for a source id, or null when it is not scriptable. */
function scriptableName(sourceId?: string): string | null {
  if (!sourceId) return null;
  // Exact app bundles only — "spotify:com.google.chrome" (web player) or
  // "youtube-music" must NOT route commands to the desktop apps.
  if (sourceId.includes('com.spotify.client')) return 'Spotify';
  if (sourceId.includes('com.apple.music') || sourceId.includes('itunes')) return 'Music';
  return null;
}

/** Browsers whose tabs we can enumerate to find which site is playing. */
const BROWSER_APPS: Record<string, { name: string; titleProp: string }> = {
  'com.google.chrome': { name: 'Google Chrome', titleProp: 'title' },
  'com.brave.browser': { name: 'Brave Browser', titleProp: 'title' },
  'com.microsoft.edgemac': { name: 'Microsoft Edge', titleProp: 'title' },
  'company.thebrowser.browser': { name: 'Arc', titleProp: 'title' },
  'com.vivaldi.vivaldi': { name: 'Vivaldi', titleProp: 'title' },
  'com.apple.safari': { name: 'Safari', titleProp: 'name' },
};

/** URL → site token, matched against the tab that carries the playing title. */
const SITE_PATTERNS: [RegExp, string][] = [
  [/youtube\.com|youtu\.be/, 'youtube'],
  [/soundcloud\.com/, 'soundcloud'],
  [/open\.spotify\.com/, 'spotify'],
  [/deezer\.com/, 'deezer'],
  [/tidal\.com/, 'tidal'],
  [/twitch\.tv/, 'twitch'],
];

/** Browsers that denied tab access this run — do not keep re-prompting. */
const deniedBrowsers = new Set<string>();
/** One-entry cache: tab lookups only re-run when the playing title changes. */
let tabCacheKey = '';
let tabCacheSite: string | null = null;

/**
 * The system session only names the browser, not the site. Enumerate the
 * browser's tabs over AppleScript and match the tab title against the
 * playing title to recognize YouTube & friends. Best-effort: any failure
 * (automation denied, browser quit…) just keeps the generic browser look.
 */
async function siteFromBrowserTab(bundleId: string, title: string): Promise<string | null> {
  const browser = BROWSER_APPS[bundleId];
  if (!browser || deniedBrowsers.has(bundleId)) return null;
  const key = `${bundleId}|${title}`;
  if (key === tabCacheKey) return tabCacheSite;
  // `sep` must be bound outside the tell block: inside it, `tab` resolves to
  // the browser's own `tab` class and concatenates as the literal text "tab".
  const script = `set out to ""
set sep to tab
tell application "${browser.name}"
	repeat with w in windows
		repeat with t in tabs of w
			set out to out & (URL of t) & sep & (${browser.titleProp} of t) & linefeed
		end repeat
	end repeat
end tell
return out`;
  let stdout: string;
  try {
    stdout = await runOsascript(script, browser.name);
  } catch (err) {
    if (err instanceof AutomationDeniedError) deniedBrowsers.add(bundleId);
    return null;
  }
  let site: string | null = null;
  for (const line of stdout.split('\n')) {
    const sep = line.indexOf('\t');
    if (sep === -1) continue;
    const url = line.slice(0, sep);
    const tabTitle = line.slice(sep + 1);
    if (!tabTitle.includes(title)) continue;
    site = SITE_PATTERNS.find(([re]) => re.test(url))?.[1] ?? null;
    if (site) break;
  }
  tabCacheKey = key;
  tabCacheSite = site;
  return site;
}

/** Resolves the media-control binary once (PATH may lack Homebrew's bin). */
let mediaControlPath: string | null | undefined;
async function mediaControl(): Promise<string | null> {
  if (mediaControlPath !== undefined) return mediaControlPath;
  for (const bin of ['media-control', '/opt/homebrew/bin/media-control', '/usr/local/bin/media-control']) {
    try {
      await run(bin, ['get']);
      mediaControlPath = bin;
      return bin;
    } catch (err) {
      // ENOENT = not here; any exit means the binary exists and runs
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        mediaControlPath = bin;
        return bin;
      }
    }
  }
  mediaControlPath = null;
  return null;
}

async function readMac(): Promise<NowPlayingState> {
  const mc = await mediaControl();
  if (!mc) return readMacFallback();
  const { stdout } = await run(mc, ['get'], { maxBuffer: 8 * 1024 * 1024 });
  const raw = JSON.parse(stdout.trim() || 'null') as {
    title?: string;
    artist?: string;
    elapsedTime?: number;
    timestamp?: string;
    duration?: number;
    playing?: boolean;
    bundleIdentifier?: string;
  } | null;
  if (!raw?.title) return { state: 'idle' };
  const playing = raw.playing === true;
  let position = raw.elapsedTime;
  // elapsedTime is a snapshot taken at `timestamp` — extrapolate while playing
  if (playing && position !== undefined && raw.timestamp) {
    const drift = (Date.now() - Date.parse(raw.timestamp)) / 1000;
    if (Number.isFinite(drift) && drift > 0) position += drift;
  }
  let sourceId = (raw.bundleIdentifier ?? '').toLowerCase();
  if (BROWSER_APPS[sourceId]) {
    const site = await siteFromBrowserTab(sourceId, raw.title);
    if (site) sourceId = `${site}:${sourceId}`;
  }
  return {
    state: playing ? 'playing' : 'paused',
    title: raw.title,
    artist: raw.artist ?? '',
    position,
    duration: raw.duration,
    sourceId,
  };
}

/** No media-control: read the scriptable players, most alive one wins. */
async function readMacFallback(): Promise<NowPlayingState> {
  const results = await Promise.allSettled(SCRIPTABLE_IDS.map((id) => queryMacPlayer(id)));
  const readable = results
    .filter((r): r is PromiseFulfilledResult<NowPlayingState> => r.status === 'fulfilled')
    .map((r) => r.value);
  if (readable.length === 0) {
    const reasons = results.map((r) => (r.status === 'rejected' ? r.reason : null)).filter(Boolean);
    throw reasons.find((e) => e instanceof AutomationDeniedError) ?? reasons[0];
  }
  return (
    readable.find((s) => s.state === 'playing') ??
    readable.find((s) => s.state === 'paused') ?? { state: 'idle' }
  );
}

const num = (s: string): number | undefined => {
  // AppleScript uses the system locale for decimals (comma on French macOS)
  const v = parseFloat(s.replace(',', '.'));
  return Number.isFinite(v) ? v : undefined;
};

async function queryMacPlayer(bundleId: string): Promise<NowPlayingState> {
  const name = MAC_APP_NAME[bundleId];
  const script = `if application "${name}" is not running then return "idle"
tell application "${name}"
	set ps to (player state as text)
	if ps is not "playing" and ps is not "paused" then return "idle"
	return ps & linefeed & name of current track & linefeed & artist of current track & linefeed & (player position as text) & linefeed & (duration of current track as text)
end tell`;
  const stdout = await runOsascript(script, name);
  const lines = stdout.trimEnd().split('\n');
  if (lines.length < 5) return { state: 'idle' };

  // Read fixed fields from both ends so a linefeed inside the track title
  // cannot shift the artist/position/duration fields.
  const state = lines[0] === 'paused' ? ('paused' as const) : ('playing' as const);
  const title = lines.slice(1, lines.length - 3).join(' ');
  const artist = lines[lines.length - 3];
  const position = num(lines[lines.length - 2]);
  let duration = num(lines[lines.length - 1]);
  if (bundleId === 'com.spotify.client' && duration !== undefined) duration /= 1000; // Spotify reports ms

  return {
    state,
    title: title === 'missing value' ? '' : title,
    artist: artist === 'missing value' ? '' : artist,
    position,
    duration,
    sourceId: bundleId,
  };
}

/** Runs an AppleScript command against a player app, guarded on it running. */
async function macPlayerCommand(appName: string, body: string): Promise<void> {
  await runOsascript(
    `if application "${appName}" is running then
	tell application "${appName}"
		${body}
	end tell
end if`,
    appName
  );
}

async function runOsascript(script: string, appName?: string): Promise<string> {
  try {
    const { stdout } = await run('osascript', ['-e', script]);
    return stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // TCC automation permission denied (or never granted)
    if (message.includes('-1743')) {
      throw new AutomationDeniedError(
        `macOS denied control of ${appName ?? 'the player'} — enable it in the Automation settings`
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const PS_SMTC_PREAMBLE = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
`;

const PS_QUERY = `
$s = $mgr.GetCurrentSession()
if ($s -eq $null) { Write-Output '{"state":"idle"}'; exit }
$m = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$tl = $s.GetTimelineProperties()
@{
  state = $s.GetPlaybackInfo().PlaybackStatus.ToString()
  title = $m.Title
  artist = $m.Artist
  position = [math]::Round($tl.Position.TotalSeconds)
  duration = [math]::Round($tl.EndTime.TotalSeconds)
  source = $s.SourceAppUserModelId
} | ConvertTo-Json -Compress
`;

const PS_TOGGLE = `
$s = $mgr.GetCurrentSession()
if ($s -ne $null) { Await ($s.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
`;

const PS_VOLUME = `
$sig = '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);'
$kb = Add-Type -MemberDefinition $sig -Name 'KeyBd' -Namespace 'W32' -PassThru
for ($i = 0; $i -lt __COUNT__; $i++) {
  $kb::keybd_event(__VK__, 0, 0, 0)
  $kb::keybd_event(__VK__, 0, 2, 0)
}
`;

async function runPs(script: string): Promise<string> {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return stdout;
}

async function readWindows(): Promise<NowPlayingState> {
  const stdout = await runPs(PS_SMTC_PREAMBLE + PS_QUERY);
  const raw = JSON.parse(stdout.trim() || '{}') as {
    state?: string;
    title?: string;
    artist?: string;
    position?: number;
    duration?: number;
    source?: string;
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
    sourceId: (raw.source ?? '').toLowerCase(),
  };
}
