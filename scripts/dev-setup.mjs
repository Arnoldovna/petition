// `pnpm dev:setup` and `pnpm demo` (conventions §5, ADR 0015, ADR 0019 section 8).
//
//   pnpm dev:setup  tool check (Node, pnpm, git, Docker, Compose) -> setup:env -> DATABASE_URL vs POSTGRES_* check ->
//                   pnpm infra:up -> pnpm db:migrate -> pnpm db:seed. Idempotent: a second run changes nothing.
//   pnpm demo       tool check (Node, pnpm, Docker, Compose) -> setup:env -> pnpm stack:demo (production image with
//                   migrate and seed) -> prints the URL and the demo login (the one secret conventions §5 allows).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseEnv, setupEnv } from './setup-env.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DEMO_EMAIL = 'demo@petition.test';
/** `!reset` and `!override` in docker-compose.e2e.yml need Compose 2.24.4 (ADR 0019 section 6). */
const MIN_COMPOSE = '2.24.4';
/** lefthook 2 needs `git rev-parse --path-format` (conventions §1). */
const MIN_GIT = '2.31.0';

/**
 * Parses the first `x.y[.z]` in a tool's version output.
 *
 * @param {string} text
 * @returns {[number, number, number] | null}
 */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** True when `actual` (version text) is at least `minimum` (`x.y.z`). */
export function isAtLeast(actual, minimum) {
  const have = parseVersion(actual);
  const need = parseVersion(minimum);
  if (!have || !need) return false;
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return (have[index] ?? 0) > (need[index] ?? 0);
  }
  return true;
}

/**
 * Checks the installed tools against the project's requirements. Pure: the probes are injected.
 *
 * @param {object} input
 * @param {'dev' | 'demo'} input.mode
 * @param {string} input.nodeVersion       e.g. process.version
 * @param {string} input.requiredNode      major from .nvmrc, e.g. '26'
 * @param {string} input.requiredPnpm      from package.json#packageManager, e.g. '10.34.9'
 * @param {(tool: 'pnpm' | 'git' | 'docker' | 'compose') => string | null} input.probe  version output or null
 * @returns {string[]} one human-readable problem per missing or outdated tool
 */
export function checkTools({ mode, nodeVersion, requiredNode, requiredPnpm, probe }) {
  const problems = [];
  const nodeMajor = parseVersion(nodeVersion)?.[0];
  if (String(nodeMajor) !== requiredNode) {
    problems.push(`Node ${requiredNode} is required (.nvmrc), found ${nodeVersion}.`);
  }

  const pnpm = probe('pnpm');
  if (pnpm === null) problems.push(`pnpm ${requiredPnpm} is required (package.json#packageManager), none found.`);
  else if (parseVersion(pnpm)?.join('.') !== requiredPnpm) {
    problems.push(`pnpm ${requiredPnpm} is required (package.json#packageManager), found ${pnpm.trim()}.`);
  }

  if (mode === 'dev') {
    const git = probe('git');
    if (git === null || !isAtLeast(git, MIN_GIT)) {
      problems.push(`git ${MIN_GIT} or later is required (lefthook), found ${git?.trim() ?? 'none'}.`);
    }
  }

  const docker = probe('docker');
  if (docker === null) {
    problems.push('Docker is required and its daemon must be running (`docker info` failed).');
  } else {
    const compose = probe('compose');
    if (compose === null || !isAtLeast(compose, MIN_COMPOSE)) {
      problems.push(`Docker Compose ${MIN_COMPOSE} or later is required, found ${compose?.trim() ?? 'none'}.`);
    }
  }
  return problems;
}

/**
 * The dev DATABASE_URL must point at the compose Postgres: same user, password, database and host port as the
 * POSTGRES_* keys (ADR 0019 section 7). Messages name keys only, never values.
 *
 * @param {Map<string, string>} env
 * @returns {string[]}
 */
export function checkDatabaseUrl(env) {
  const raw = env.get('DATABASE_URL') ?? '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return ['DATABASE_URL in .env is missing or not a URL.'];
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return ['DATABASE_URL in .env must start with postgres:// or postgresql://.'];
  }
  const mismatches = [];
  if (decodeURIComponent(url.username) !== (env.get('POSTGRES_USER') ?? '')) mismatches.push('POSTGRES_USER');
  if (decodeURIComponent(url.password) !== (env.get('POSTGRES_PASSWORD') ?? '')) mismatches.push('POSTGRES_PASSWORD');
  if (decodeURIComponent(url.pathname.slice(1)) !== (env.get('POSTGRES_DB') ?? '')) mismatches.push('POSTGRES_DB');
  if ((url.port || '5432') !== (env.get('POSTGRES_PORT') || '5432')) mismatches.push('POSTGRES_PORT');
  return mismatches.length === 0
    ? []
    : [`DATABASE_URL in .env does not match ${mismatches.join(', ')}. Make them name the same values.`];
}

/**
 * The value docker compose interpolates for `name`: a non-empty shell variable wins over .env, then the fallback.
 *
 * @param {string} name
 * @param {NodeJS.ProcessEnv} processEnv
 * @param {Map<string, string>} dotenv
 * @param {string} [fallback]
 */
export function composeValue(name, processEnv, dotenv, fallback = '') {
  return processEnv[name] || dotenv.get(name) || fallback;
}

function probeTool(tool) {
  const commands = {
    pnpm: ['pnpm', ['--version']],
    git: ['git', ['--version']],
    docker: ['docker', ['info', '--format', '{{.ServerVersion}}']],
    compose: ['docker', ['compose', 'version', '--short']],
  };
  const [command, args] = commands[tool];
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout : null;
}

function run(script) {
  console.log(`\n> pnpm ${script}`);
  const result = spawnSync('pnpm', [script], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`pnpm ${script} failed${result.status === null ? '' : ` with exit code ${result.status}`}.`);
  }
}

function readProjectRequirements() {
  const requiredNode = readFileSync(resolve(ROOT, '.nvmrc'), 'utf8').trim();
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const requiredPnpm = /^pnpm@(.+)$/.exec(packageJson.packageManager ?? '')?.[1];
  if (!requiredPnpm) throw new Error('package.json#packageManager must be pnpm@<version>.');
  return { requiredNode, requiredPnpm };
}

/**
 * @param {'dev' | 'demo'} mode
 * @param {string} label the script name in messages
 */
function main(mode, label) {
  const problems = checkTools({
    mode,
    nodeVersion: process.version,
    ...readProjectRequirements(),
    probe: probeTool,
  });
  if (problems.length > 0) {
    throw new Error(`missing prerequisites:\n  - ${problems.join('\n  - ')}`);
  }

  setupEnv({ cwd: ROOT });
  const dotenv = parseEnv(readFileSync(resolve(ROOT, '.env'), 'utf8'));

  if (mode === 'demo') {
    run('stack:demo');
    const port = composeValue('APP_PORT', process.env, dotenv, '3000');
    const password = composeValue('SEED_DEMO_PASSWORD', process.env, dotenv);
    console.log(`\n${label}: the app runs at http://127.0.0.1:${port}`);
    console.log(`${label}: demo login ${DEMO_EMAIL} / ${password}`);
    console.log(`${label}: stop it with \`pnpm stack:down\` (keeps the data).`);
    return;
  }

  const databaseProblems = checkDatabaseUrl(dotenv);
  if (databaseProblems.length > 0) throw new Error(databaseProblems.join('\n'));
  run('infra:up');
  run('db:migrate');
  run('db:seed');
  console.log(`\n${label}: done. Start the app with \`pnpm dev\`.`);
}

if (import.meta.main) {
  const mode = process.argv.slice(2).includes('--demo') ? 'demo' : 'dev';
  const label = mode === 'demo' ? 'demo' : 'dev:setup';
  try {
    main(mode, label);
  } catch (error) {
    console.error(`\n${label}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
