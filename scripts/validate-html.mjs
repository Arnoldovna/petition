// `node scripts/validate-html.mjs [dir] [--if-present]`: W3C Nu validator over the raw HTML bodies that
// e2e/html-validity.spec.ts writes (F-87, B-73, ADR 0015, ADR 0019 section 6). Default dir: test-results/html.
//
// The image reference (tag@sha256) is read from docker/nu-validator.Dockerfile, which Dependabot keeps current.
// The validator runs offline, read-only and unprivileged, reports errors only and exits 1 on any error.
// Without --if-present, a missing or empty folder is an error; run-e2e.mjs passes it because a filtered Playwright
// run may not include the HTML spec.
//
// The validator exits 0 for paths it cannot see (for example a folder Docker does not share), so the script also
// checks that the validator reported every file it was given.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DOCKERFILE = 'docker/nu-validator.Dockerfile';
const DEFAULT_DIR = 'test-results/html';
const CONTAINER_DIR = '/html';
const IMAGE_REFERENCE = /^\s*FROM\s+(ghcr\.io\/validator\/validator:[\w.-]+@sha256:[a-f0-9]{64})\s*$/im;

/**
 * Extracts the digest-pinned validator image from the Dockerfile text.
 *
 * @param {string} dockerfile
 * @returns {string}
 */
export function readValidatorImage(dockerfile) {
  const match = IMAGE_REFERENCE.exec(dockerfile);
  if (!match?.[1]) {
    throw new Error(`${DOCKERFILE} must contain FROM ghcr.io/validator/validator:<tag>@sha256:<digest>`);
  }
  return match[1];
}

/**
 * Lists the .html files below `dir` as paths relative to it, sorted, with forward slashes.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listHtmlFiles(dir) {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.html') && statSync(resolve(dir, name)).isFile())
    .map((name) => name.split(sep).join('/'))
    .sort();
}

/**
 * With --verbose the validator prints every path it checked on stdout. Returns the container paths it never reported.
 *
 * @param {string[]} containerPaths
 * @param {string} stdout
 * @returns {string[]}
 */
export function unreportedFiles(containerPaths, stdout) {
  const reported = new Set(stdout.split(/\r?\n/).map((line) => line.trim()));
  return containerPaths.filter((path) => !reported.has(path));
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const ifPresent = argv.includes('--if-present');
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  if (positional.length > 1) throw new Error('usage: validate-html.mjs [dir] [--if-present]');
  return { dir: positional[0] ?? DEFAULT_DIR, ifPresent };
}

function runValidator(image, hostDir, containerPaths) {
  const args = [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--user',
    '65534:65534',
    '--volume',
    `${hostDir}:${CONTAINER_DIR}:ro`,
    image,
    'java',
    '-jar',
    '/vnu.jar',
    '--errors-only',
    '--verbose',
    '--format',
    'gnu',
    ...containerPaths,
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout }));
  });
}

async function main(argv) {
  const { dir, ifPresent } = parseArgs(argv);
  const hostDir = resolve(ROOT, dir);
  const files = existsSync(hostDir) ? listHtmlFiles(hostDir) : [];
  if (files.length === 0) {
    const message = `no HTML files in ${relative(ROOT, hostDir) || '.'}`;
    if (ifPresent) {
      console.log(`validate-html: ${message}, nothing to validate.`);
      return 0;
    }
    throw new Error(`${message}. Run e2e/html-validity.spec.ts first.`);
  }

  const image = readValidatorImage(readFileSync(resolve(ROOT, DOCKERFILE), 'utf8'));
  const containerPaths = files.map((file) => `${CONTAINER_DIR}/${file}`);
  console.log(`validate-html: checking ${files.length} file(s) with the W3C Nu validator`);
  const { code, stdout } = await runValidator(image, hostDir, containerPaths);

  const unseen = unreportedFiles(containerPaths, stdout);
  if (unseen.length === files.length && code !== 0) {
    throw new Error(`the validator container failed to run (exit code ${code}).`);
  }
  if (unseen.length > 0) {
    throw new Error(
      `the validator could not read ${unseen.length} of ${files.length} file(s), e.g. ${unseen[0]}. ` +
        'Is the folder shared with Docker?',
    );
  }
  if (code !== 0) {
    console.error('validate-html: HTML errors found (see above).');
    return code;
  }
  console.log('validate-html: no errors.');
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`validate-html: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
