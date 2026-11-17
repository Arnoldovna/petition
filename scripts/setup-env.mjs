// `pnpm setup:env`: create or complete .env from .env.example (conventions §5, ADR 0015, ADR 0019 section 7).
//
// - .env missing: copy .env.example and fill every empty secret.
// - .env present: append keys that exist only in .env.example (with their comment block) and fill empty secrets.
// - A secret is a key whose name contains SECRET or PASSWORD as a word (SESSION_SECRET, CSRF_SECRET,
//   SEED_DEMO_PASSWORD); it gets crypto.randomBytes(32).toString('base64url'). A value is never overwritten.
// - Prints key names only, never values. Writes .env with mode 600 and only when something changed, so a second run
//   leaves the file byte-identical (CI dev-setup-smoke). Node built-ins only.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const SECRET_KEY = /(?:^|_)(?:SECRET|PASSWORD)(?:_|$)/;

/** True for keys `setup:env` generates when empty: SECRET or PASSWORD as an underscore-separated word. */
export function isSecretKey(key) {
  return SECRET_KEY.test(key);
}

/** A random secret: 32 bytes, base64url (43 characters, safe in .env, URLs and compose interpolation). */
export function generateSecret() {
  return randomBytes(32).toString('base64url');
}

/**
 * Parses dotenv text into an ordered list of entries. Only `KEY=value` lines are entries; comments and blank lines are
 * kept by the callers as raw text. Values are unquoted ('...' or "..."), a trailing ` # comment` on an unquoted value
 * is dropped. Multi-line values are not supported (the project has none).
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnv(text) {
  const values = new Map();
  for (const line of splitLines(text)) {
    const entry = parseLine(line);
    if (entry) values.set(entry.key, entry.value);
  }
  return values;
}

/**
 * Pure core of `setup:env`.
 *
 * @param {object} input
 * @param {string | null} input.current  the existing .env text, or null when there is none
 * @param {string} input.example         the .env.example text
 * @param {() => string} [input.generate] secret generator (injected by tests)
 * @returns {{ text: string, created: boolean, added: string[], generated: string[] }}
 */
export function mergeEnv({ current, example, generate = generateSecret }) {
  const created = current === null;
  const lines = splitLines(created ? example : current);
  const present = new Set(lines.map(parseLine).flatMap((entry) => (entry ? [entry.key] : [])));

  const added = [];
  if (!created) {
    const exampleLines = splitLines(example);
    exampleLines.forEach((line, index) => {
      const entry = parseLine(line);
      if (!entry || present.has(entry.key)) return;
      const comment = commentBlockAbove(exampleLines, index);
      // A documented key starts a new paragraph; keys that share a comment in the example stay together.
      if (comment.length > 0 && lines.length > 0 && lines.at(-1) !== '') lines.push('');
      lines.push(...comment, line);
      present.add(entry.key);
      added.push(entry.key);
    });
  }

  const generated = [];
  const filled = lines.map((line) => {
    const entry = parseLine(line);
    if (!entry || entry.value !== '' || !isSecretKey(entry.key)) return line;
    generated.push(entry.key);
    return `${entry.key}=${generate()}`;
  });

  return { text: joinLines(filled), created, added, generated };
}

/**
 * Creates or completes `<cwd>/.env`. Returns what changed (key names only).
 *
 * @param {{ cwd?: string, log?: (message: string) => void }} [options]
 */
export function setupEnv({ cwd = process.cwd(), log = (message) => console.log(message) } = {}) {
  const examplePath = resolve(cwd, '.env.example');
  const envPath = resolve(cwd, '.env');
  if (!existsSync(examplePath)) {
    throw new Error(`.env.example not found in ${cwd}`);
  }
  const example = readFileSync(examplePath, 'utf8');
  const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : null;
  const result = mergeEnv({ current, example });

  if (result.created || result.text !== current) {
    writeAtomically(envPath, result.text);
  } else {
    chmodSync(envPath, 0o600); // keep secrets private even when nothing changed
  }

  if (result.created) log('setup:env: created .env from .env.example');
  if (result.added.length > 0) log(`setup:env: added ${result.added.join(', ')}`);
  if (result.generated.length > 0) log(`setup:env: generated ${result.generated.join(', ')}`);
  if (!result.created && result.added.length === 0 && result.generated.length === 0) {
    log('setup:env: .env is complete, nothing changed');
  }
  return result;
}

function parseLine(line) {
  if (/^\s*#/.test(line)) return null;
  const match = ENV_LINE.exec(line);
  if (!match) return null;
  const [, key = '', raw = ''] = match;
  return { key, value: unquote(raw.trim()) };
}

function unquote(raw) {
  const quote = raw[0];
  if ((quote === '"' || quote === "'") && raw.length >= 2 && raw.endsWith(quote)) return raw.slice(1, -1);
  return raw.replace(/\s+#.*$/, '').trim();
}

/** The contiguous comment lines directly above `index` (the key's documentation in .env.example). */
function commentBlockAbove(lines, index) {
  let start = index;
  while (start > 0 && /^\s*#/.test(lines[start - 1] ?? '')) start -= 1;
  return lines.slice(start, index);
}

function splitLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function joinLines(lines) {
  return `${lines.join('\n')}\n`;
}

function writeAtomically(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600); // the umask may have narrowed or the file may have existed
  renameSync(temporary, path);
}

if (import.meta.main) {
  try {
    setupEnv();
  } catch (error) {
    console.error(`setup:env: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
