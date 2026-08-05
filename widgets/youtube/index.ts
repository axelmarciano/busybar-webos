import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Widget } from '../../src/core/widget';
import type { DisplayElement } from '../../src/busybar/client';
import { encodePng } from './png';

const run = promisify(execFile);

const W = 72;
const H = 16;
const FRAME_BYTES = W * H * 3;

const YOUTUBE_URL = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i;

/**
 * The audio lives under its own application name: video frames are uploaded
 * to the widget's assets every ~100ms, and writing into the directory of a
 * file being played can interrupt the playback.
 */
const AUDIO_APP = 'youtube.audio';

type ScreenState = 'loading' | 'playing' | 'done' | 'error';

export default class YoutubeWidget extends Widget {
  static title = 'YouTube';
  static description =
    'Streams a YouTube (or direct mp4/m3u8) video URL as 72x16 pixels. Needs ffmpeg; yt-dlp for YouTube links.';
  static tags = ['fun', 'video'];
  static author = 'axelmarciano';
  static configSchema = {
    priority: {
      type: 'number' as const,
      label: 'Draw priority (1-100; 90+ shows over a running BUSY session)',
      default: 95,
      min: 1,
      max: 100,
    },
  };
  static launchSchema = {
    url: {
      type: 'string' as const,
      label: 'Video URL (YouTube or direct mp4/m3u8)',
      required: true,
    },
    fps: {
      type: 'number' as const,
      label: 'Target FPS',
      default: 8,
      min: 2,
      max: 12,
    },
    loop: {
      type: 'select' as const,
      label: 'When the video ends',
      default: 'loop',
      options: [
        { value: 'loop', label: 'Loop forever' },
        { value: 'stop', label: 'Stop' },
      ],
    },
    sound: {
      type: 'select' as const,
      label: 'Sound (extracted and played on the bar)',
      default: 'on',
      options: [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
    },
  };

  /** ffmpeg is mandatory; yt-dlp is only checked at launch for YouTube links. */
  static async validateInstall(): Promise<void> {
    try {
      await run('ffmpeg', ['-version'], { timeout: 10_000 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(
          'ffmpeg not found — install it: "brew install ffmpeg" (macOS) or "winget install ffmpeg" (Windows)'
        );
      }
      throw err;
    }
  }

  private abort = new AbortController();
  private latestFrame: Buffer | null = null;
  private frameFlip = 0;
  private lastFile: string | null = null;
  private renderInFlight = false;
  private stopped = false;
  /**
   * Audio joins the already-running video: extracted in the background while
   * frames stream, then scheduled at a sync point (loop boundary in loop mode,
   * the -ss offset position in stop mode). Video never waits for it.
   */
  private audioReady = false;
  private audioScheduled = false;
  private audioStarted = false;
  private audioSeconds = 0;
  private audioOffset = 0;
  private firstFrameAt = 0;
  private audioJoinTimer?: NodeJS.Timeout;
  private audioLoopTimer?: NodeJS.Timeout;
  private loopAudio = false;
  private firstFrameResolve?: () => void;
  private firstFramePromise = new Promise<void>((resolve) => {
    this.firstFrameResolve = resolve;
  });

  async start(): Promise<void> {
    const url = String(this.launch.url ?? '').trim();
    const fps = Math.min(Math.max(Number(this.launch.fps ?? 8), 2), 12);
    const loop = String(this.launch.loop ?? 'loop') === 'loop';

    await this.showStatus('loading');
    // Reclaim device storage from previous runs (old frames + audio track)
    await this.bar.deleteAssets(this.id).catch(() => {});
    await this.bar.deleteAssets(AUDIO_APP).catch(() => {});
    // Resolution + streaming continue in the background so start() returns fast
    void this.pipeline(url, fps, loop).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(message);
      void this.showStatus('error', message.slice(0, 40));
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.audioJoinTimer) clearTimeout(this.audioJoinTimer);
    if (this.audioLoopTimer) clearInterval(this.audioLoopTimer);
    if (this.audioStarted) await this.bar.stopAudio().catch(() => {});
  }

  // --- Pipeline ---

  private async pipeline(url: string, fps: number, loop: boolean): Promise<void> {
    const streamUrl = await this.resolveStreamUrl(url);
    if (this.stopped) return;
    this.loopAudio = loop;

    // Audio is prepared in the BACKGROUND — the video starts streaming
    // immediately and the sound joins it at a sync point once ready.
    if (String(this.launch.sound ?? 'on') === 'on') {
      // Sound joins the running video 10s in (extraction happens during those
      // 10 seconds); in loop mode it replays at boundary+10s on every pass.
      this.audioOffset = 10;
      void this.prepareAudio(url, streamUrl);
    }
    this.log.info(`Streaming at ${fps} fps${loop ? ' (loop)' : ''}`);

    await new Promise<void>((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error',
        ...(loop ? ['-stream_loop', '-1'] : []),
        '-re',
        '-i', streamUrl,
        '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
        '-r', String(fps),
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        '-an',
        'pipe:1',
      ];
      const child = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: this.abort.signal,
      });

      let buffer = Buffer.alloc(0);
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        // keep only the most recent complete frame — natural frame dropping
        while (buffer.length >= FRAME_BYTES) {
          this.latestFrame = buffer.subarray(0, FRAME_BYTES);
          buffer = buffer.subarray(FRAME_BYTES);
        }
        this.requestRender();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.name === 'AbortError') resolve();
        else if (err.code === 'ENOENT') reject(new Error('ffmpeg not found — brew install ffmpeg'));
        else reject(err);
      });
      child.on('close', (code) => {
        if (this.abort.signal.aborted) return resolve();
        if (code === 0) {
          this.log.info('Video finished');
          void this.showStatus('done');
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200) || 'unknown error'}`));
        }
      });
    });
  }

  /**
   * Extracts the audio track as mono 22kHz WAV (capped at 10 min).
   * The RIFF sizes are patched afterwards — ffmpeg writes placeholder sizes
   * when piping, which the device's player would reject.
   */
  private extractAudio(streamUrl: string, offsetSeconds = 0): Promise<{ wav: Buffer; seconds: number }> {
    // WAV is bulky (~2.6MB/min): cap at 2 min so the upload stays fast
    const MAX_SECONDS = 120;
    const TIMEOUT_MS = 60_000; // live streams / slow sources: give up, video-only
    return new Promise((resolve, reject) => {
      const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
      const signal = AbortSignal.any([timeoutSignal, this.abort.signal]);
      const child = spawn(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error',
          ...(offsetSeconds > 0 ? ['-ss', String(offsetSeconds)] : []),
          '-t', String(MAX_SECONDS),
          '-i', streamUrl,
          '-vn', '-ac', '1', '-ar', '22050',
          '-f', 'wav', 'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], signal }
      );
      const chunks: Buffer[] = [];
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => chunks.push(data));
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      const abortReason = () =>
        this.abort.signal.aborted ? new Error('widget stopped') : new Error('audio extraction timed out');
      child.on('error', (err: Error) => {
        reject(err.name === 'AbortError' ? abortReason() : err);
      });
      child.on('close', (code) => {
        if (signal.aborted) return reject(abortReason());
        if (code !== 0) return reject(new Error(`ffmpeg audio exit ${code}: ${stderr.slice(-120)}`));
        const wav = Buffer.concat(chunks);
        if (wav.length <= 44) return reject(new Error('no audio track'));
        const dataLength = wav.length - 44;
        wav.writeUInt32LE(36 + dataLength, 4); // RIFF size
        wav.writeUInt32LE(dataLength, 40); // data size
        resolve({ wav, seconds: dataLength / (22_050 * 2) });
      });
    });
  }

  /**
   * Background: extract + upload, then schedule the join with the video.
   * YouTube: the resolved googlevideo stream is throttled to realtime by
   * Google — extracting from it would take the video's full duration. yt-dlp
   * downloads the (small) audio-only track at full speed instead, and ffmpeg
   * converts the local file instantly.
   */
  private async prepareAudio(originalUrl: string, streamUrl: string): Promise<void> {
    let tempFile: string | null = null;
    try {
      let source = streamUrl;
      if (YOUTUBE_URL.test(originalUrl)) {
        tempFile = await this.downloadYoutubeAudio(originalUrl);
        source = tempFile;
      }
      if (this.stopped) return;
      await this.firstFramePromise;

      // The device can't seek inside a WAV, so the file must START at a video
      // position we can still reach once extraction+upload are done. The cost
      // isn't known upfront (upload speed varies) — measure it and re-aim:
      // attempt 2 uses attempt 1's real cost, so this converges immediately.
      let margin = 8;
      for (let attempt = 1; attempt <= 3 && !this.stopped; attempt++) {
        const elapsed = () => (Date.now() - this.firstFrameAt) / 1000;
        const target = Math.max(this.audioOffset, Math.ceil(elapsed()) + margin);
        const begun = Date.now();
        const audio = await this.extractAudio(source, target);
        if (this.stopped) return;
        await this.bar.uploadAsset(AUDIO_APP, 'audio.wav', audio.wav);
        const cost = (Date.now() - begun) / 1000;
        if (elapsed() < target - 0.3) {
          this.audioOffset = target;
          this.audioSeconds = audio.seconds;
          this.audioReady = true;
          this.log.info(`Audio ready (${Math.round(audio.seconds)}s from position ${target}s)`);
          this.scheduleAudio();
          return;
        }
        margin = Math.ceil(cost * 1.4) + 3;
        this.log.info(`Audio missed its slot (took ${Math.round(cost)}s) — re-aiming ${margin}s ahead`);
      }
      this.log.warn('Audio could not catch up with the video — playing video only');
    } catch (err) {
      if (this.stopped) return;
      this.log.warn(
        `No audio: ${err instanceof Error ? err.message : String(err)} — playing video only`
      );
    } finally {
      if (tempFile) fs.rm(tempFile, () => {});
    }
  }

  /** Downloads the audio-only track to a temp file (fast — yt-dlp dodges the throttling). */
  private async downloadYoutubeAudio(url: string): Promise<string> {
    const base = path.join(os.tmpdir(), `busybar-yt-${process.pid}-${Date.now()}`);
    await run(
      'yt-dlp',
      ['-f', 'worstaudio/worst', '--no-playlist', '-o', `${base}.%(ext)s`, url],
      { timeout: 90_000, signal: this.abort.signal }
    );
    const dir = os.tmpdir();
    const name = fs.readdirSync(dir).find((f) => f.startsWith(path.basename(base)));
    if (!name) throw new Error('yt-dlp produced no audio file');
    return path.join(dir, name);
  }

  /**
   * Syncs the audio with the running video. Called when audio becomes ready
   * and when the first frame is drawn — fires once both have happened.
   * Loop mode: start exactly on the next loop boundary, then every loop.
   * Stop mode: start when the video reaches the extraction offset.
   */
  private scheduleAudio(): void {
    if (!this.audioReady || !this.firstFrameAt || this.audioScheduled || this.stopped) return;
    this.audioScheduled = true;
    const play = () => {
      this.audioStarted = true;
      this.log.info('Playing audio track');
      void this.bar.playAudio(AUDIO_APP, { path: 'audio.wav' }).catch((err) => {
        this.log.error(`Audio play failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    const elapsed = (Date.now() - this.firstFrameAt) / 1000;
    // full video duration = skipped head + extracted tail
    const duration = this.audioOffset + this.audioSeconds;

    // First join: at video position `audioOffset` of the current pass.
    // If extraction outlived that point (or the whole pass), aim for the
    // same position in the next pass (loop mode only).
    let startIn = this.audioOffset - elapsed;
    if (startIn < 0.15 && this.loopAudio && duration > 1) {
      const pass = Math.ceil((elapsed - this.audioOffset) / duration);
      startIn = pass * duration + this.audioOffset - elapsed;
    }
    if (startIn < 0.15) {
      this.log.warn('Audio was ready too late to sync — playing video only');
      return;
    }
    this.log.info(`Sound joins in ${Math.round(startIn)}s`);
    this.audioJoinTimer = setTimeout(() => {
      play();
      if (this.loopAudio && duration > 1) {
        this.audioLoopTimer = setInterval(play, duration * 1000);
      }
    }, startIn * 1000);
  }

  /** YouTube links go through yt-dlp; anything else is handed to ffmpeg as-is. */
  private async resolveStreamUrl(url: string): Promise<string> {
    if (!YOUTUBE_URL.test(url)) return url;
    this.log.info('Resolving YouTube stream via yt-dlp…');
    try {
      const { stdout } = await run(
        'yt-dlp',
        // combined video+audio stream: DASH video-only formats would leave the bar silent
        ['-g', '-f', 'best[height<=240][acodec!=none]/best[acodec!=none]/worst', '--no-playlist', url],
        { timeout: 30_000, signal: this.abort.signal }
      );
      const resolved = stdout.trim().split('\n')[0];
      if (!resolved) throw new Error('yt-dlp returned no stream URL');
      return resolved;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(
          'yt-dlp not found — "brew install yt-dlp" (macOS) or "winget install yt-dlp" (Windows). Direct video URLs work without it.'
        );
      }
      throw err;
    }
  }

  // --- Rendering (single-flight, latest frame wins) ---

  private requestRender(): void {
    if (this.renderInFlight || this.stopped) return;
    void this.renderLoop();
  }

  private async renderLoop(): Promise<void> {
    this.renderInFlight = true;
    try {
      while (!this.stopped && this.latestFrame) {
        const frame = this.latestFrame;
        this.latestFrame = null;
        const png = encodePng(new Uint8Array(frame), W, H);
        // Alternate the asset name: redrawing the same path can serve the
        // device's cached copy — a fresh path forces a reload every frame.
        const file = `f${this.frameFlip}.png`;
        this.frameFlip = (this.frameFlip + 1) % 2;
        await this.bar.uploadAsset(this.id, file, png);
        this.lastFile = file;
        if (this.stopped) return;
        await this.draw(
          [
            { id: 'v', type: 'image', path: file, x: 0, y: 0, timeout: 0 },
            ...this.hiddenStatus(),
          ],
          { priority: this.priority() }
        );
        if (!this.firstFrameAt) {
          this.firstFrameAt = Date.now(); // video clock zero — audio syncs to this
          this.firstFrameResolve?.();
          this.scheduleAudio();
        }
      }
    } catch (err) {
      this.log.warn(`frame failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.renderInFlight = false;
      // a frame may have landed while we were finishing — pick it up
      if (!this.stopped && this.latestFrame) this.requestRender();
    }
  }

  // --- Status screens (atomic, same ids everywhere, no clear) ---

  private priority(): number {
    return Math.min(Math.max(Number(this.config.priority ?? 95), 1), 100);
  }

  private hiddenStatus(): DisplayElement[] {
    return [
      { id: 'st1', type: 'text', text: ' ', font: 'tiny', x: 0, y: -30, timeout: 0 },
      { id: 'st2', type: 'text', text: ' ', font: 'tiny', x: 0, y: -30, timeout: 0 },
    ];
  }

  private async showStatus(state: ScreenState, detail?: string): Promise<void> {
    const lines: Record<ScreenState, [string, string]> = {
      loading: ['YOUTUBE', detail ?? 'loading...'],
      playing: ['', ''],
      done: ['DONE', 'video finished'],
      error: ['ERROR', detail ?? 'see widget logs'],
    };
    const [l1, l2] = lines[state];
    await this.draw(
      [
        // park the last video frame off-screen (only once one exists)
        ...(this.lastFile
          ? [{ id: 'v', type: 'image', path: this.lastFile, x: 0, y: -30, timeout: 0 } as DisplayElement]
          : []),
        {
          id: 'st1', type: 'text', text: l1 || ' ', font: 'small',
          color: state === 'error' ? '#F85149FF' : '#FFFFFFFF',
          align: 'top_mid', x: 36, y: 0, timeout: 0,
        },
        {
          id: 'st2', type: 'text', text: l2 || ' ', font: 'tiny',
          color: '#8A93A6FF', align: 'top_mid', x: 36, y: 9, timeout: 0,
          width: 70, scroll_rate: 1200, scroll_start_delay: 1000, scroll_repeat_delay: 2000,
        },
      ],
      { priority: this.priority() }
    ).catch(() => {});
  }
}
