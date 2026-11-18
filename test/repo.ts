import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, for tests that read the shipped sources, docs and configs. */
export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** A repository file as UTF-8 text, by its path relative to the root. */
export function readRepoFile(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

/** Every file below `dir`, as sorted root-relative paths with forward slashes. */
export function listRepoFiles(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(REPO_ROOT, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
}
