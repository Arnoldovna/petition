import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ESLint, type Linter } from 'eslint';
import stylelint from 'stylelint';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { readRepoFile, REPO_ROOT as ROOT } from '../../test/repo.js';

/**
 * Regression tests for the static gates that replace the legacy code-quality and CSS bugs (OVERVIEW.md section 21).
 * `pnpm lint`, `pnpm lint:css` and `pnpm check:utilities` prove the current tree is clean; these tests prove the gates
 * still reject the legacy patterns, so a loosened rule fails here instead of letting a bug back in silently.
 */

const readJson = (relativePath: string): unknown => JSON.parse(readRepoFile(relativePath));

const { scripts } = readJson('package.json') as { scripts: Record<string, string> };

/** ESLint normalises a rule entry to `[severity, ...options]`; 2 is "error". */
function ruleEntry(config: Linter.Config, rule: string): { severity: number; options: unknown[] } {
  const entry = config.rules?.[rule];
  if (!Array.isArray(entry)) throw new Error(`${rule} is not configured`);
  const [severity, ...options] = entry as unknown[];
  return { severity: typeof severity === 'number' ? severity : Number.NaN, options };
}

describe('lint gate (ESLint)', () => {
  /** Representative files: a feature service, shared code, the composition root and browser code. */
  const FILES = [
    'src/features/auth/auth.service.ts',
    'src/shared/security/session.ts',
    'src/app.ts',
    'src/client/form-guard.ts',
  ] as const;
  const configs = new Map<string, Linter.Config>();

  beforeAll(async () => {
    const eslint = new ESLint({ cwd: ROOT });
    for (const file of FILES) configs.set(file, (await eslint.calculateConfigForFile(file)) as Linter.Config);
  });

  const configFor = (file: string): Linter.Config => {
    const config = configs.get(file);
    if (!config) throw new Error(`no ESLint config for ${file}`);
    return config;
  };

  it('B-21: floating and misused promises are lint errors in server and browser code', () => {
    for (const file of FILES) {
      expect(ruleEntry(configFor(file), '@typescript-eslint/no-floating-promises').severity, file).toBe(2);
      expect(ruleEntry(configFor(file), '@typescript-eslint/no-misused-promises').severity, file).toBe(2);
      expect(ruleEntry(configFor(file), '@typescript-eslint/await-thenable').severity, file).toBe(2);
    }
  });

  it('B-41: unused variables are lint errors and `pnpm lint` runs knip for unused files, exports and dependencies', () => {
    for (const file of FILES) {
      expect(ruleEntry(configFor(file), '@typescript-eslint/no-unused-vars').severity, file).toBe(2);
    }
    expect(scripts['lint']).toMatch(/\bknip\b/);
    expect(scripts['verify']).toMatch(/\bpnpm lint\b/);
  });

  it('B-50: feature boundaries disallow every import no policy allows, and import cycles are errors', () => {
    for (const file of ['src/features/auth/auth.service.ts', 'src/shared/security/session.ts']) {
      const boundaries = ruleEntry(configFor(file), 'boundaries/dependencies');
      expect(boundaries.severity, file).toBe(2);
      expect(boundaries.options[0], file).toMatchObject({ default: 'disallow' });
      expect(ruleEntry(configFor(file), 'import-x/no-cycle').severity, file).toBe(2);
    }
  });

  it('B-51: TypeScript strict ESM with the strict type-checked rule set and Prettier in the gate', () => {
    const base = readJson('tsconfig.base.json') as { compilerOptions: Record<string, unknown> };
    expect(base.compilerOptions).toMatchObject({ strict: true, module: 'nodenext', verbatimModuleSyntax: true });
    expect(readJson('package.json')).toMatchObject({ type: 'module' });
    expect(scripts['verify']).toMatch(/^pnpm format:check\b/);
    // Two rules only the strict type-checked preset turns on; they stand for the whole preset.
    expect(
      ruleEntry(configFor('src/features/auth/auth.service.ts'), '@typescript-eslint/no-explicit-any').severity,
    ).toBe(2);
    expect(
      ruleEntry(configFor('src/features/auth/auth.service.ts'), '@typescript-eslint/no-unnecessary-condition').severity,
    ).toBe(2);
  });

  it('B-58: console calls are lint errors in application code', () => {
    for (const file of FILES) expect(ruleEntry(configFor(file), 'no-console').severity, file).toBe(2);
  });
});

describe('stylesheet gate (stylelint)', () => {
  /** The rules that reject a snippet as if it were a component stylesheet of this project. */
  async function rulesBroken(code: string): Promise<string[]> {
    const { results } = await stylelint.lint({
      code,
      codeFilename: join(ROOT, 'src/styles/components/gate-sample.css'),
      cwd: ROOT,
    });
    return [...new Set(results.flatMap((result) => result.warnings.map((warning) => warning.rule)))].sort();
  }

  it('B-76: hard-coded colours and font stacks are rejected; tokens pass', async () => {
    expect(await rulesBroken('.panel { color: #76950c; }\n')).toContain('color-no-hex');
    expect(await rulesBroken('.panel { color: rgba(255, 197, 110, 0.93); }\n')).toContain('function-disallowed-list');
    expect(await rulesBroken('.panel { color: black; }\n')).toContain('color-named');
    expect(await rulesBroken('.panel { font-family: Lato, sans-serif; }\n')).toContain(
      'declaration-property-value-allowed-list',
    );
    expect(await rulesBroken('.panel { color: var(--color-ink); font-family: var(--font-sans); }\n')).toEqual([]);
  });

  it('B-78: magic lengths for offsets, spacers and positions are rejected, and so are physical properties', async () => {
    expect(await rulesBroken('.page { margin-block-start: 126px; }\n')).toContain(
      'declaration-property-value-disallowed-list',
    );
    expect(await rulesBroken('.spacer { block-size: 94px; }\n')).toContain(
      'declaration-property-value-disallowed-list',
    );
    expect(await rulesBroken('.hint { inset-inline-start: 700px; }\n')).toContain(
      'declaration-property-value-disallowed-list',
    );
    expect(await rulesBroken('.page { margin-top: var(--spacing-header); }\n')).toContain('property-disallowed-list');
    expect(await rulesBroken('.page { margin-block-start: var(--spacing-header); }\n')).toEqual([]);
  });

  it('B-79: ID selectors, camelCase and non-ASCII class names are rejected; BEM passes', async () => {
    expect(await rulesBroken('#sig { display: block; }\n')).toContain('selector-max-id');
    expect(await rulesBroken('.squareSignup { display: block; }\n')).toContain('selector-class-pattern');
    expect(await rulesBroken('.groß { display: block; }\n')).toContain('selector-class-pattern');
    expect(await rulesBroken('.supporter-list__item--current { display: block; }\n')).toEqual([]);
  });

  it('B-80: duplicate declarations, shorthand overrides and duplicate selectors are rejected', async () => {
    expect(await rulesBroken('.about { margin-block: 0; margin-block: 0; }\n')).toContain(
      'declaration-block-no-duplicate-properties',
    );
    expect(await rulesBroken('.about { padding-inline-start: var(--x); padding: var(--y); }\n')).toContain(
      'declaration-block-no-shorthand-property-overrides',
    );
    expect(await rulesBroken('.about { display: block; }\n\n.about { display: grid; }\n')).toContain(
      'no-duplicate-selectors',
    );
  });
});

describe('markup gate (check-no-utilities)', () => {
  /** Every throwaway project of the current test; a test may run the check more than once. */
  const fixtures: string[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  });

  /** Runs the real `pnpm check:utilities` script against a throwaway project with one view and one stylesheet. */
  function checkUtilities(view: string, css: string): { status: number | null; output: string } {
    const fixture = mkdtempSync(join(tmpdir(), 'check-utilities-'));
    fixtures.push(fixture);
    mkdirSync(join(fixture, 'src/views'), { recursive: true });
    mkdirSync(join(fixture, 'src/styles'), { recursive: true });
    writeFileSync(join(fixture, 'src/views/page.hbs'), view);
    writeFileSync(join(fixture, 'src/styles/main.css'), css);
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts/check-no-utilities.mjs'), fixture], {
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('B-77: utility classes and classes no stylesheet defines fail the check; defined BEM components pass', () => {
    const failing = checkUtilities(
      '<div class="flex p-4"><section class="panel"><h2 class="panel__title">x</h2></section></div>\n',
      '.panel { display: block; }\n',
    );
    expect(failing.status).toBe(1);
    expect(failing.output).toMatch(/\bflex\b.*Tailwind utility/);
    expect(failing.output).toMatch(/\bp-4\b.*Tailwind utility/);
    expect(failing.output).toMatch(/panel__title.*not defined/);

    const passing = checkUtilities(
      '<section class="panel"><h2 class="panel__title">x</h2></section>\n',
      '.panel { display: block; }\n\n.panel__title { margin: 0; }\n',
    );
    expect(passing.output).toContain('OK');
    expect(passing.status).toBe(0);
  });

  it('B-78: an @apply with an arbitrary value (a magic number behind a utility) fails the check', () => {
    const result = checkUtilities('<div class="spacer"></div>\n', '.spacer { @apply mt-[94px]; }\n');
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/mt-\[94px\].*arbitrary value/);
  });
});

describe('secret hygiene', () => {
  const git = (...args: string[]): { status: number | null; stdout: string } => {
    const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout };
  };

  it('B-02: local env files are ignored by git and none is tracked; only .env.example is committed', () => {
    // --no-index: the answer comes from the ignore rules alone, whatever is tracked or present.
    const ignored = (path: string): boolean => git('check-ignore', '--no-index', '--quiet', path).status === 0;
    for (const path of ['.env', '.env.local', '.env.production', 'docker/.env']) expect(ignored(path), path).toBe(true);
    expect(ignored('.env.example')).toBe(false);

    const tracked = git('ls-files', '-z').stdout.split('\0');
    expect(tracked).toContain('.env.example');
    expect(tracked.filter((file) => /(?:^|\/)\.env(?:\.(?!example$)[^/]+)?$/.test(file))).toEqual([]);
  });

  it('B-02: gitleaks scans every commit (lefthook pre-commit), the history and working tree in verify, and CI', () => {
    expect(readRepoFile('lefthook.yml')).toMatch(/run: gitleaks git --staged\b/);
    expect(scripts['secrets:scan']).toMatch(/gitleaks git\b.*&& gitleaks dir\b/);
    expect(scripts['verify']).toMatch(/pnpm secrets:scan$/);
    expect(readRepoFile('.github/workflows/ci.yml')).toMatch(/^\s+gitleaks:\s*$/m);
  });
});
