// @ts-check
import { builtinModules } from 'node:module';

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import boundaries from 'eslint-plugin-boundaries';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TSCONFIGS = ['tsconfig.json', 'src/client/tsconfig.json', 'e2e/tsconfig.json'];

/** The one file allowed to call `res.render` (OVERVIEW.md section 7, ADR 0014). */
const RENDER_MODULE = 'src/shared/view/render.ts';

const BAN_SQL_RAW = {
  selector: "MemberExpression[object.name='sql'][property.name='raw']",
  message: 'sql.raw bypasses parameter binding. Use the sql`` template or the query builder (OVERVIEW.md section 7).',
};
/**
 * `res.render(...)`, `app.render(...)` and the chained forms `res.status(404).render(...)` and
 * `res.status(404).type('html').render(...)`: a chained call's object is a CallExpression, so the receiver is matched
 * along the chain.
 */
const BAN_RES_RENDER = {
  selector: [
    "CallExpression > MemberExpression.callee[property.name='render']:matches(",
    '[object.name=/^(res|response|app)$/],',
    '[object.callee.object.name=/^(res|response)$/],',
    '[object.callee.object.callee.object.name=/^(res|response)$/]',
    ')',
  ].join(''),
  message: `Render pages through renderPage (${RENDER_MODULE}), never res.render directly (ADR 0014).`,
};

/** Non-test sources never import the test harness in test/ (ADR 0017, ADR 0019 section 5). */
const BAN_TEST_HARNESS = {
  regex: '^(\\.\\.?/)+test(/|$)',
  message: 'Only test files (src/**/__tests__/**, *.test.ts) may import the test harness in test/.',
};
/**
 * Nothing imports tools (OVERVIEW.md section 7). Boundaries enforces it for every element; the composition root is no
 * element (boundaries elements are folders), so its three files get this pattern.
 */
const BAN_TOOLS_FROM_ROOT = {
  regex: '^\\./tools(/|$)',
  message: 'Tools are entry points; the composition root never imports them (OVERVIEW.md section 7).',
};
/** Browser code never reaches Node built-ins (OVERVIEW.md section 7). */
const BAN_NODE_BUILTINS = {
  regex: `^(node:.*|(${builtinModules.map((name) => RegExp.escape(name)).join('|')})(/.*)?)$`,
  message: 'src/client runs in the browser: no Node built-ins.',
};
const TEST_FILES = ['src/**/__tests__/**', 'src/**/*.test.ts'];
const COMPOSITION_ROOT = ['src/app.ts', 'src/container.ts', 'src/server.ts'];

export default defineConfig([
  globalIgnores([
    'dist/',
    '.dev/',
    'coverage/',
    'playwright-report/',
    'test-results/',
    'drizzle/',
    'public/assets/',
    'public/fonts/',
  ]),
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': ['error', BAN_SQL_RAW, BAN_RES_RENDER],
    },
  },
  { files: ['**/*.{js,mjs,cjs}'], extends: [tseslint.configs.disableTypeChecked] },
  // Node everywhere except the browser bundle; src/client gets browser globals only.
  { files: ['**/*.{js,mjs,cjs,ts,mts,cts}'], ignores: ['src/client/**'], languageOptions: { globals: globals.node } },
  { files: ['src/client/**/*.ts'], languageOptions: { globals: globals.browser } },
  {
    files: [RENDER_MODULE],
    rules: { 'no-restricted-syntax': ['error', BAN_SQL_RAW] },
  },
  {
    files: ['src/**/*.ts'],
    ignores: TEST_FILES,
    rules: { 'no-restricted-imports': ['error', { patterns: [BAN_TEST_HARNESS] }] },
  },
  {
    files: COMPOSITION_ROOT,
    rules: { 'no-restricted-imports': ['error', { patterns: [BAN_TEST_HARNESS, BAN_TOOLS_FROM_ROOT] }] },
  },
  {
    files: ['src/client/**/*.ts'],
    ignores: TEST_FILES,
    rules: { 'no-restricted-imports': ['error', { patterns: [BAN_TEST_HARNESS, BAN_NODE_BUILTINS] }] },
  },
  {
    // Module boundaries (OVERVIEW.md section 7): features reach each other only through features/<name>/index.ts;
    // shared never imports db or features; db only db and config; config only config; tools use features' index.ts,
    // shared, db and config; client imports only client; nothing imports tools. Files outside these folders (the
    // composition root, src/__tests__) are no element and may import any of them.
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: TSCONFIGS, noWarnOnMultipleProjects: true },
      },
      'boundaries/elements': [
        { type: 'feature', pattern: 'src/features/*', capture: ['feature'] },
        { type: 'shared', pattern: 'src/shared' },
        { type: 'config', pattern: 'src/config' },
        { type: 'db', pattern: 'src/db' },
        { type: 'tools', pattern: 'src/tools' },
        { type: 'client', pattern: 'src/client' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // npm packages; client is further restricted by no-restricted-imports above
            { allow: { to: { module: { origin: 'external' } } } },
            { allow: { dependency: { relationship: { to: 'internal' } } } },
            {
              from: { element: { type: 'feature' } },
              allow: { to: { element: { type: 'feature', fileInternalPath: 'index.ts' } } },
            },
            {
              from: { element: { type: 'feature' } },
              allow: { to: { element: { types: ['shared', 'config', 'db'] } } },
            },
            { from: { element: { type: 'shared' } }, allow: { to: { element: { types: ['shared', 'config'] } } } },
            { from: { element: { type: 'db' } }, allow: { to: { element: { types: ['db', 'config'] } } } },
            {
              from: { element: { type: 'tools' } },
              allow: { to: { element: { type: 'feature', fileInternalPath: 'index.ts' } } },
            },
            {
              from: { element: { type: 'tools' } },
              allow: { to: { element: { types: ['tools', 'shared', 'db', 'config'] } } },
            },
          ],
        },
      ],
    },
  },
  {
    // No import cycles (conventions §9): feature modules stay acyclic, also through their index.ts. Type-only
    // imports count too: a type cycle is still a design cycle.
    files: ['src/**/*.ts', 'test/**/*.ts', 'e2e/**/*.ts', '*.config.ts'],
    plugins: { 'import-x': importX },
    settings: {
      // Without these, import-x treats .ts files as unparseable and silently follows no import at all.
      'import-x/extensions': ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'],
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.mts', '.cts'] },
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ alwaysTryTypes: true, project: TSCONFIGS, noWarnOnMultipleProjects: true }),
        createNodeResolver(),
      ],
    },
    rules: { 'import-x/no-cycle': ['error', { ignoreExternal: true }] },
  },
  {
    // CLI scripts report to the terminal; no-console guards application code, not tooling.
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  prettier,
]);
