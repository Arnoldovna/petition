// `pnpm test:e2e`, `pnpm e2e:up`, `pnpm e2e:down` (conventions §6, ADR 0005, 0015, 0017, ADR 0019 section 6).
//
//   pnpm test:e2e [playwright args] [--keep]
//     1. resolve E2E_PORT once (environment, else .env, else 8182) and validate it
//     2. `down -v --remove-orphans` (leftovers of a killed run), then `up -d --build --wait` (project petition-e2e)
//     3. canvas smoke check inside the image the stack just built (petition-e2e-app, ADR 0005)
//     4. Playwright with E2E_BASE_URL=http://127.0.0.1:<port>; only after a green run the Nu validator
//     5. on any failure: test-results/compose.log; always `down -v --remove-orphans` unless --keep
//   pnpm e2e:up      steps 1 to 3, then print E2E_BASE_URL (phase-5 orchestrator)
//   pnpm e2e:down    `down -v --remove-orphans`
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseEnv } from './setup-env.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export const E2E_PROJECT = 'petition-e2e';
export const DEFAULT_E2E_PORT = 8182;
/** Compose's default image name for the `app` service of the e2e project (`<project>-<service>`). */
const APP_IMAGE = `${E2E_PROJECT}-app`;
const COMPOSE_LOG = 'test-results/compose.log';

/**
 * Splits the script's own flags from the arguments passed through to Playwright.
 *
 * @param {string[]} argv
 * @returns {{ mode: 'test' | 'up' | 'down', keep: boolean, playwrightArgs: string[] }}
 */
export function parseArgs(argv) {
  const own = new Set(['--up', '--down', '--keep']);
  const up = argv.includes('--up');
  const down = argv.includes('--down');
  if (up && down) throw new Error('use either --up or --down, not both');
  return {
    mode: up ? 'up' : down ? 'down' : 'test',
    keep: argv.includes('--keep'),
    playwrightArgs: argv.filter((arg) => !own.has(arg)),
  };
}

/**
 * Resolves the e2e host port once: process environment, else .env, else 8182 (OVERVIEW.md section 16).
 *
 * @param {NodeJS.ProcessEnv} processEnv
 * @param {Map<string, string>} dotenv
 * @returns {number}
 */
export function resolveE2ePort(processEnv, dotenv) {
  const fromEnv = processEnv['E2E_PORT']?.trim();
  const fromDotenv = dotenv.get('E2E_PORT')?.trim();
  const raw = fromEnv || fromDotenv || String(DEFAULT_E2E_PORT);
  const source = fromEnv ? 'the environment' : fromDotenv ? '.env' : 'the default';
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65_535) {
    throw new Error(`E2E_PORT from ${source} must be an integer between 1 and 65535, got "${raw}"`);
  }
  return Number(raw);
}

/** The docker compose arguments every step shares (project, both files, profile). */
export function composeArgs(...rest) {
  return [
    'compose',
    '-p',
    E2E_PROJECT,
    '-f',
    'docker-compose.yml',
    '-f',
    'docker-compose.e2e.yml',
    '--profile',
    'e2e',
    ...rest,
  ];
}

let interrupted = false;

/** Runs a command with inherited stdio; resolves with its exit code (signals count as failure). */
function run(command, args, env, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: options.stdio ?? 'inherit' });
    if (options.stdout) child.stdout?.pipe(options.stdout);
    child.on('error', reject);
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

async function mustRun(step, command, args, env) {
  console.log(`\n> ${step}`);
  const code = await run(command, args, env);
  if (code !== 0) throw new Error(`${step} failed with exit code ${code}`);
}

async function writeComposeLog(env) {
  mkdirSync(resolve(ROOT, 'test-results'), { recursive: true });
  const file = createWriteStream(resolve(ROOT, COMPOSE_LOG));
  await run('docker', composeArgs('logs', '--no-color', '--timestamps'), env, {
    stdio: ['ignore', 'pipe', 'inherit'],
    stdout: file,
  });
  await new Promise((resolvePromise) => file.end(resolvePromise));
  console.error(`run-e2e: compose logs written to ${COMPOSE_LOG}`);
}

/** One `docker compose` step of the e2e project; the step label is the command as a developer would type it. */
function mustCompose(env, ...rest) {
  return mustRun(`docker compose -p ${E2E_PROJECT} ${rest.join(' ')}`, 'docker', composeArgs(...rest), env);
}

function tearDown(env) {
  return mustCompose(env, 'down', '-v', '--remove-orphans');
}

async function startStack(env) {
  await tearDown(env);
  await mustCompose(env, 'up', '-d', '--build', '--wait');
  // Phase-1 smoke check: @napi-rs/canvas, the shipped fonts and PNG round trip inside the distroless image.
  await mustRun(
    `canvas smoke check in ${APP_IMAGE}`,
    'docker',
    ['run', '--rm', '--network', 'none', APP_IMAGE, 'dist/tools/smoke-canvas.js'],
    env,
  );
}

async function main(argv) {
  const { mode, keep, playwrightArgs } = parseArgs(argv);
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) {
    throw new Error('.env is missing: run `pnpm setup:env` first (the stack needs its secrets).');
  }
  const port = resolveE2ePort(process.env, parseEnv(readFileSync(envPath, 'utf8')));
  const baseUrl = `http://127.0.0.1:${port}`;
  // The same port reaches compose (docker-compose.e2e.yml) and Playwright.
  const env = { ...process.env, E2E_PORT: String(port) };

  if (mode === 'down') {
    await tearDown(env);
    return 0;
  }

  let failed = true;
  try {
    await startStack(env);
    if (mode === 'up') {
      failed = false;
      console.log(`\nE2E_BASE_URL=${baseUrl}`);
      return 0;
    }

    console.log(`\n> playwright test (E2E_BASE_URL=${baseUrl})`);
    const playwright = await run('pnpm', ['exec', 'playwright', 'test', ...playwrightArgs], {
      ...env,
      E2E_BASE_URL: baseUrl,
    });
    if (playwright !== 0) return playwright;
    if (interrupted) return 130;

    // F-87: only a green run has a complete, current set of HTML snapshots. A filtered run may have none.
    await mustRun('validate-html', process.execPath, ['scripts/validate-html.mjs', '--if-present'], env);
    failed = false;
    return 0;
  } finally {
    if (failed || interrupted) await writeComposeLog(env).catch(() => undefined);
    if (keep && mode !== 'up') {
      console.log(`\nrun-e2e: --keep, the stack stays up at ${baseUrl}. Stop it with \`pnpm e2e:down\`.`);
    } else if (mode !== 'up' || failed) {
      await tearDown(env);
    }
  }
}

if (import.meta.main) {
  // Ctrl+C reaches the children through the process group; finish the teardown instead of dying mid-way.
  // A second Ctrl+C aborts immediately (the stack may then need `pnpm e2e:down`).
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
  });
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`\nrun-e2e: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
