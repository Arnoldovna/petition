// `pnpm media:record` (Etappe 3b): the demo video and the README GIF, against the running `pnpm demo` stack.
//
//   1. Playwright, project `recording` of playwright.media.config.ts (e2e/demo-recording.spec.ts): one raw WebM per
//      viewport in test-results/media/. E2E_BASE_URL defaults to http://127.0.0.1:<APP_PORT>, the URL `pnpm demo`
//      prints (APP_PORT from the environment or .env, else 3000).
//   2. ffmpeg, when installed: docs/media/demo-{desktop,mobile}.webm (VP9) and .mp4 (H.264, plays everywhere) and
//      docs/media/demo-flow.gif (the desktop video, faster, smaller, for the README). Without ffmpeg the raw WebM
//      files are copied to docs/media unchanged, the now stale MP4 files are removed and the GIF is kept, with a note.
//   3. Prints every file with its size. A GIF larger than GIF_LIMIT_BYTES fails the run and is not copied.
//
// Extra arguments go to Playwright, e.g. `pnpm media:record --grep desktop`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const RAW_DIR = join(ROOT, 'test-results', 'media');
const MEDIA_DIR = join(ROOT, 'docs', 'media');
/** What e2e/demo-recording.spec.ts writes per recording; `<name>` is desktop or mobile. */
const RAW_NAME = /^demo-([a-z]+)\.raw\.webm$/;
/** The README GIF and the recording it is made from. */
const GIF_NAME = 'demo-flow.gif';
const GIF_SOURCE = 'desktop';
/** The README GIF: GitHub renders large GIFs slowly, so it stays well below GitHub's 10 MB image limit. */
const GIF_LIMIT_BYTES = 5 * 1024 * 1024;
/** Desktop video at 1.6x speed, 10 fps and 960px wide, with one palette for the whole clip. */
const GIF_FILTER =
  'setpts=PTS/1.6,fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];' +
  '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';

/**
 * Runs a command with inherited output and fails loudly on a non-zero exit.
 *
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${String(result.status)}`);
}

function hasFfmpeg() {
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
  return probe.status === 0;
}

/** `ffmpeg -y -loglevel error -i <input> ...args <output>` */
function ffmpeg(input, args, output) {
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, ...args, output]);
}

function sizeOf(path) {
  return statSync(path).size;
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Without ffmpeg: the raw WebM files only. An MP4 of an earlier take would no longer match: it is removed, so
 * `pnpm site:build` fails loudly. The README GIF stays as it was.
 *
 * @param {Map<string, string>} raws
 */
function copyRaw(raws) {
  console.warn('record-demo: ffmpeg not found: copying the raw WebM only, no MP4 and no README GIF.');
  return [...raws].map(([name, raw]) => {
    const webm = join(MEDIA_DIR, `demo-${name}.webm`);
    copyFileSync(raw, webm);
    rmSync(join(MEDIA_DIR, `demo-${name}.mp4`), { force: true });
    return webm;
  });
}

/**
 * VP9 WebM and H.264 MP4 per recording, and the README GIF from the desktop one.
 *
 * @param {Map<string, string>} raws
 */
function encode(raws) {
  const written = [];
  for (const [name, raw] of raws) {
    const webm = join(MEDIA_DIR, `demo-${name}.webm`);
    const mp4 = join(MEDIA_DIR, `demo-${name}.mp4`);
    ffmpeg(raw, ['-an', '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1'], webm);
    ffmpeg(
      raw,
      ['-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
      mp4,
    );
    written.push(webm, mp4);
  }
  const gifSource = raws.get(GIF_SOURCE);
  if (gifSource !== undefined) {
    // Encoded next to the raw files first, so an oversized GIF never replaces the one the README shows.
    const draft = join(RAW_DIR, GIF_NAME);
    ffmpeg(gifSource, ['-vf', GIF_FILTER, '-loop', '0'], draft);
    const size = sizeOf(draft);
    if (size > GIF_LIMIT_BYTES) {
      throw new Error(`${GIF_NAME} is ${formatSize(size)}, above ${formatSize(GIF_LIMIT_BYTES)}: adjust GIF_FILTER`);
    }
    const gif = join(MEDIA_DIR, GIF_NAME);
    copyFileSync(draft, gif);
    written.push(gif);
  }
  return written;
}

function main() {
  // `||`, like `pnpm demo` when it prints the URL: an empty APP_PORT in .env means the default.
  process.env['E2E_BASE_URL'] ||= `http://127.0.0.1:${process.env['APP_PORT'] || '3000'}`;
  console.log(`record-demo: recording against ${process.env['E2E_BASE_URL']}`);
  run(process.execPath, [
    'node_modules/@playwright/test/cli.js',
    'test',
    '-c',
    'playwright.media.config.ts',
    '--project',
    'recording',
    ...process.argv.slice(2),
  ]);

  mkdirSync(MEDIA_DIR, { recursive: true });
  /** @type {Map<string, string>} recording name (desktop, mobile) -> raw file */
  const raws = new Map(
    readdirSync(RAW_DIR).flatMap((file) => {
      const name = RAW_NAME.exec(file)?.[1];
      return name === undefined ? [] : [[name, join(RAW_DIR, file)]];
    }),
  );
  if (raws.size === 0) throw new Error('no recording was produced (check the Playwright output above)');

  const written = hasFfmpeg() ? encode(raws) : copyRaw(raws);
  for (const file of written) console.log(`record-demo: ${relative(ROOT, file)}  ${formatSize(sizeOf(file))}`);
}

try {
  main();
} catch (error) {
  console.error(`record-demo: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
