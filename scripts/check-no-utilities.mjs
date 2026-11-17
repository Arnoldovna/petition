#!/usr/bin/env node
/**
 * check-no-utilities.mjs — enforce "BEM classes only, no Tailwind utilities in markup".
 *
 * Part of the maw `modular-css-tailwind4` conventions. Zero dependencies, Node >= 20.
 *
 * 1. MARKUP: scans .vue (<template>), .tsx, .jsx, .hbs, .handlebars, .html and extracts
 *    every class token from
 *      class="…"  className="…"  className={…}  :class="…"  v-bind:class="…"
 *      Handlebars hash params named *Class / modifier / modifiers  ({{> button modifier="button--primary"}})
 *    Each token must be (a) BEM, (b) not shaped like a Tailwind utility and
 *    (c) defined as a class selector in the project's CSS (.css files + Vue <style> blocks).
 * 2. CSS: audits every `@apply` — no arbitrary values ([…]), no `!`, no physical-direction
 *    utilities, spacing only on the 4px scale, motion only under motion-safe.
 *    Plain `animation`/`transition` declarations must sit inside a motion-safe context.
 * 3. HANDLEBARS: every file in src/styles/components/ must be @imported by src/styles/main.css
 *    (only when main.css imports components at all).
 *
 * Usage:   node scripts/check-no-utilities.mjs [rootDir]
 * Config:  optional <rootDir>/no-utilities.config.json
 *          { "allow": ["router-link-active"], "ignoreDirs": ["legacy"], "spacingSteps": [0,1,2,3,4,5,6,8,10,12,16,20,24,32] }
 * Exit:    0 = clean, 1 = violations, 2 = crash.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? process.cwd());
const CONFIG_FILE = join(ROOT, 'no-utilities.config.json');
const config = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};

const ALLOW = new Set(config.allow ?? []);
const SPACING_STEPS = new Set((config.spacingSteps ?? [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32]).map(String));
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'public',
  '.git',
  '.turbo',
  '.vite',
  '.cache',
  'playwright-report',
  'test-results',
  '__snapshots__',
  '__tests__',
  'e2e',
  ...(config.ignoreDirs ?? []),
]);
const TEMPLATE_EXT = new Set(['.vue', '.tsx', '.jsx', '.hbs', '.handlebars', '.html']);
const TEST_FILE = /\.(test|spec|stories)\.[jt]sx?$/;

const BEM = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__[a-z0-9]+(?:-[a-z0-9]+)*)?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const DYNAMIC = '\u0000';

/* ------------------------------------------------------------------ utils */

const violations = [];
function report(file, src, index, token, reason) {
  const before = src.slice(0, index);
  const line = before.split('\n').length;
  const col = index - before.lastIndexOf('\n');
  violations.push({ file: relative(ROOT, file), line, col, token: token.replaceAll(DYNAMIC, '${…}'), reason });
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(join(dir, entry.name), out);
    } else out.push(join(dir, entry.name));
  }
  return out;
}

/** Replace a range with spaces (keeps newlines so offsets and line numbers stay valid). */
const blank = (s) => s.replace(/[^\n]/g, ' ');

/** Mask CSS comments and strings. */
function maskCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => m[0] + blank(m.slice(1, -1)) + m.at(-1));
}

/** Mask HTML / Handlebars / JS block comments in templates. */
function maskTemplateComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\{\{!--[\s\S]*?--\}\}/g, blank)
    .replace(/\{\{![\s\S]*?\}\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank);
}

/** Keep only <template>…</template> of a Vue SFC (offsets preserved). */
function vueTemplate(src) {
  const start = src.indexOf('<template');
  const end = src.lastIndexOf('</template>');
  if (start === -1 || end === -1) return blank(src);
  return blank(src.slice(0, start)) + src.slice(start, end) + blank(src.slice(end));
}

/** Read a quoted attribute value starting at src[i] (a quote). Handlebars-aware: quotes inside {{ }} do not close. */
function readQuoted(src, i) {
  const quote = src[i];
  let j = i + 1;
  let depth = 0;
  while (j < src.length) {
    if (src.startsWith('{{', j)) {
      depth++;
      j += 2;
      continue;
    }
    if (depth > 0 && src.startsWith('}}', j)) {
      depth--;
      j += 2;
      continue;
    }
    if (depth === 0 && src[j] === quote) break;
    j++;
  }
  return { value: src.slice(i + 1, j), start: i + 1, end: j };
}

/** Read a balanced {…} JSX expression starting at src[i] === "{". String/template aware. */
function readBraced(src, i) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      j = skipString(src, j);
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) break;
    }
    j++;
  }
  return { value: src.slice(i + 1, j), start: i + 1, end: j };
}

function skipString(src, j) {
  const q = src[j];
  j++;
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') j++;
    else if (q === '`' && src.startsWith('${', j)) j = readBraced(src, j + 1).end;
    j++;
  }
  return j + 1;
}

/* ------------------------------------------------- class token extraction */

/** Tokens from a static attribute value; Handlebars mustaches contribute their string literals. */
function tokensFromStatic(value, offset) {
  const out = [];
  const withoutMustaches = value.replace(/\{\{[\s\S]*?\}\}/g, (m, at) => {
    for (const lit of m.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      pushWords(out, lit[1] ?? lit[2], offset + at + lit.index + 1);
    }
    return blank(m);
  });
  pushWords(out, withoutMustaches, offset);
  return out;
}

/** Tokens from a JS expression (JSX className={…}, Vue :class="…"). */
function tokensFromExpression(expr, offset) {
  const out = [];
  let i = 0;
  let masked = '';
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(expr, i);
      const raw = expr.slice(i + 1, end - 1);
      const before = expr.slice(0, i);
      const after = expr.slice(end);
      const isComparison = /(===|!==|==|!=)\s*$/.test(before) || /^\s*(===|!==|==|!=)/.test(after);
      const isArgOfNonClassCall = /\.(includes|startsWith|endsWith|indexOf|get|has|test)\(\s*$/.test(before);
      if (!isComparison && !isArgOfNonClassCall) {
        const literal = c === '`' ? replaceInterpolations(raw) : raw;
        pushWords(out, literal, offset + i + 1);
      }
      masked += blank(expr.slice(i, end));
      i = end;
      continue;
    }
    masked += c;
    i++;
  }
  // unquoted object keys: { 'list-row--active': a, active: b }  →  "active"
  for (const m of masked.matchAll(/[{,]\s*([A-Za-z_$][\w$-]*)\s*:/g)) {
    out.push({ token: m[1], index: offset + m.index + m[0].indexOf(m[1]) });
  }
  return out;
}

function replaceInterpolations(raw) {
  let res = '';
  let i = 0;
  while (i < raw.length) {
    if (raw.startsWith('${', i)) {
      const { end } = readBraced(raw, i + 1);
      res += DYNAMIC;
      i = end + 1;
    } else res += raw[i++];
  }
  return res;
}

function pushWords(out, text, offset) {
  for (const m of text.matchAll(/\S+/g)) out.push({ token: m[0], index: offset + m.index });
}

function extractClassTokens(file, rawSrc) {
  const ext = extname(file);
  let src = maskTemplateComments(rawSrc);
  if (ext === '.vue') src = vueTemplate(src);
  const tokens = [];

  // static: class="…" / className="…"  and JSX className={…}
  for (const m of src.matchAll(/(?<![\w:@.$-])(class|className)\s*=\s*(?=["'{])/g)) {
    const at = m.index + m[0].length;
    if (src[at] === '{') {
      const { value, start } = readBraced(src, at);
      tokens.push(...tokensFromExpression(value, start));
    } else {
      const { value, start } = readQuoted(src, at);
      tokens.push(...tokensFromStatic(value, start));
    }
  }
  // Vue bindings: :class="…" / v-bind:class="…"
  if (ext === '.vue') {
    for (const m of src.matchAll(/(?:\s)(?::|v-bind:)class\s*=\s*(?=["'])/g)) {
      const at = m.index + m[0].length;
      const { value, start } = readQuoted(src, at);
      tokens.push(...tokensFromExpression(value, start));
    }
  }
  // Handlebars hash params inside mustaches: modifier="…", modifiers="…", extraClass="…"
  if (ext === '.hbs' || ext === '.handlebars') {
    for (const mustache of src.matchAll(/\{\{[\s\S]*?\}\}/g)) {
      for (const m of mustache[0].matchAll(/\b([a-zA-Z]+Class|modifiers?)=("([^"]*)"|'([^']*)')/g)) {
        const val = m[3] ?? m[4];
        pushWords(tokens, val, mustache.index + m.index + m[0].indexOf(val));
      }
    }
  }
  return { src: rawSrc, tokens };
}

/* --------------------------------------------------- CSS: defined classes */

/** Walk CSS blocks; calls onPrelude(prelude, index, stack) and onStatement(stmt, index, stack). */
function walkCss(css, { onPrelude, onStatement }) {
  const masked = maskCss(css);
  const stack = [];
  let segStart = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{' || c === ';' || c === '}') {
      const seg = masked.slice(segStart, i);
      const lead = seg.length - seg.trimStart().length;
      const text = seg.trim();
      const at = segStart + lead;
      if (c === '{') {
        onPrelude?.(text, at, stack);
        stack.push(text);
      } else if (text) {
        onStatement?.(text, at, stack);
      }
      if (c === '}') stack.pop();
      segStart = i + 1;
    }
  }
}

function collectDefinedClasses(css, into) {
  walkCss(css, {
    onPrelude(prelude) {
      if (prelude.startsWith('@')) return;
      for (const m of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) into.add(m[1]);
    },
  });
}

/** Vue <style> blocks (inline only; src="" files are scanned as .css anyway). */
function vueStyleBlocks(src) {
  return [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => ({
    css: blank(src.slice(0, m.index + m[0].indexOf('>') + 1)) + m[1],
  }));
}

/* ------------------------------------------- Tailwind utility recognition */

const STANDALONE = new Set(
  `flex inline-flex grid inline-grid block inline-block inline hidden contents flow-root
table table-row table-cell list-item container relative absolute fixed sticky static truncate underline overline
line-through no-underline italic not-italic uppercase lowercase capitalize normal-case sr-only not-sr-only visible
invisible collapse isolate group peer prose antialiased subpixel-antialiased border rounded shadow outline ring
transition transform grow shrink filter blur invert grayscale sepia resize ordinal tabular-nums proportional-nums
break-words break-all break-normal grow-0 shrink-0 flex-1 flex-auto flex-none flex-row flex-col flex-wrap
flex-nowrap flex-row-reverse flex-col-reverse`.split(/\s+/),
);

const NUMERIC_ROOTS = String.raw`-?(?:m[xytrblse]?|mb[se]|p[xytrblse]?|pb[se]|w|h|min-w|min-h|max-w|max-h|size|inline|block|min-inline|max-inline|min-block|max-block|gap(?:-[xy])?|space-[xy]|inset(?:-[xy]|-[se]|-b[se])?|top|right|bottom|left|start|end|z|order|col-span|col-start|col-end|row-span|row-start|row-end|grid-cols|grid-rows|basis|columns|leading|tracking|opacity|scale(?:-[xy])?|rotate|translate-[xy]|skew-[xy]|duration|delay|line-clamp|indent|border(?:-[xytrblse]|-b[se])?|rounded(?:-[a-z]{1,2})?|outline(?:-offset)?|ring(?:-offset)?|underline-offset|decoration|stroke|aspect|divide-[xy]|brightness|contrast|saturate|hue-rotate)`;
const NUMERIC_VALUES = String.raw`(?:\d+(?:\.\d+)?|\d+\/\d+|px|full|screen|auto|min|max|fit|none|svh|dvh|lvh|xs|sm|md|lg|xl|\dxl|prose|video|square)`;
const NUMERIC_UTILITY = new RegExp(`^${NUMERIC_ROOTS}-${NUMERIC_VALUES}$`);

const KEYWORD_UTILITY = new RegExp(
  '^(?:' +
    [
      'text-(?:xs|sm|base|lg|xl|[2-9]xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)',
      'font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|sans|serif|mono)',
      'items-(?:start|end|center|baseline|stretch)',
      'justify-(?:start|end|center|between|around|evenly|stretch|normal)',
      'content-(?:center|start|end|between|around|evenly|none|normal|stretch|baseline)',
      'self-(?:auto|start|end|center|stretch|baseline)',
      'place-(?:items|content|self)-[a-z]+',
      'object-(?:contain|cover|fill|none|scale-down|center|top|bottom|left|right)',
      'overflow(?:-[xy])?-(?:auto|hidden|clip|visible|scroll)',
      'whitespace-(?:normal|nowrap|pre|pre-line|pre-wrap|break-spaces)',
      'cursor-(?:pointer|default|wait|text|move|help|not-allowed|none|grab|grabbing|auto)',
      'select-(?:none|text|all|auto)',
      'pointer-events-(?:none|auto)',
      'flex-(?:wrap-reverse|initial)',
      'bg-(?:cover|contain|center|fixed|local|scroll|no-repeat|repeat|none)',
      'border-(?:solid|dashed|dotted|double|hidden|none|collapse|separate)',
      '(?:shadow|rounded|blur|drop-shadow|inset-shadow)-(?:xs|sm|md|lg|xl|2xl|3xl|none|inner|full)',
      'ease-(?:linear|in|out|in-out)',
      'animate-(?:spin|ping|pulse|bounce|none)',
      'leading-(?:none|tight|snug|normal|relaxed|loose)',
      'tracking-(?:tighter|tight|normal|wide|wider|widest)',
      'list-(?:none|disc|decimal|inside|outside)',
      'decoration-(?:solid|double|dotted|dashed|wavy)',
      'transition-(?:all|colors|opacity|shadow|transform|none)',
      '(?:bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|accent|caret|divide|shadow|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white|transparent|current|inherit)(?:-(?:50|[1-9]00|950))?',
    ].join('|') +
    ')$',
);

/** Utilities generated from the project's own @theme tokens (e.g. bg-ink, text-meta, font-medium). */
function themeUtilities(cssSources) {
  const names = new Set();
  const colorRoots = [
    'bg',
    'text',
    'border',
    'border-x',
    'border-y',
    'border-s',
    'border-e',
    'border-bs',
    'border-be',
    'ring',
    'outline',
    'fill',
    'stroke',
    'decoration',
    'accent',
    'caret',
    'from',
    'via',
    'to',
    'divide',
    'placeholder',
  ];
  const ns = {
    color: colorRoots,
    text: ['text'],
    font: ['font'],
    'font-weight': ['font'],
    tracking: ['tracking'],
    leading: ['leading'],
    radius: ['rounded'],
    shadow: ['shadow'],
    container: ['max-w', 'w', 'max-inline', 'inline'],
    aspect: ['aspect'],
    ease: ['ease'],
    animate: ['animate'],
  };
  for (const css of cssSources) {
    for (const block of css.matchAll(/@theme\b[^{]*\{([\s\S]*?)\n\}/g)) {
      for (const m of block[1].matchAll(/^\s*--([a-z-]+?)-([a-z0-9-]+)\s*:/gm)) {
        let [, space, name] = m;
        if (space === 'font' && name.startsWith('weight-')) {
          space = 'font-weight';
          name = name.slice(7);
        }
        if (name.includes('--')) continue; // --text-meta--line-height
        for (const root of ns[space] ?? []) names.add(`${root}-${name}`);
      }
    }
  }
  return names;
}

function classify(token, defined, themeNames) {
  if (ALLOW.has(token)) return null;
  if (token.includes(DYNAMIC))
    return "dynamic class composition — write the full BEM class (e.g. cond ? 'block--a' : 'block--b')";
  if (/[:[\]/!@*()#%{}$]/.test(token) || /^-/.test(token) || /^\d/.test(token))
    return 'Tailwind utility syntax (variant / arbitrary value / important / negative) in markup';
  if (STANDALONE.has(token) || NUMERIC_UTILITY.test(token) || KEYWORD_UTILITY.test(token) || themeNames.has(token))
    return 'Tailwind utility class in markup — move it into the component CSS via @apply';
  if (!BEM.test(token)) return 'not a BEM class (block__element--modifier, kebab-case)';
  if (!defined.has(token)) return 'class is not defined in any project CSS file';
  return null;
}

/* ------------------------------------------------------------ @apply audit */

const PHYSICAL =
  /^-?(?:m[trbl]|p[trbl]|top|right|bottom|left|border-[trbl]|rounded-[trbl]{1,2}|scroll-[mp][trbl]|w|h|min-w|min-h|max-w|max-h)-|^(?:text-left|text-right|float-left|float-right|border-[trbl])$/;
const SPACING =
  /^-?(?:m[xyse]?|mb[se]|p[xyse]?|pb[se]|gap(?:-[xy])?|space-[xy]|inset(?:-[xy]|-[se]|-b[se])?|start|end)-(\d+(?:\.\d+)?)$/;
const MOTION = /^(?:animate-(?!none$)|transition(?:-(?!none$)[a-z]+)?$)/;
const BORDER_WIDTH = /^(?:border|outline|ring|divide-[xy])(?:-(?:[xytrblse]|b[se]))?-(?!0$)\d+$/;
const MOTION_SAFE_CONTEXT = /^@variant\s+motion-safe\b|prefers-reduced-motion:\s*no-preference/;

function auditCss(file, css) {
  walkCss(css, {
    onStatement(stmt, index, stack) {
      const safe = stack.some((p) => MOTION_SAFE_CONTEXT.test(p));
      if (stmt.startsWith('@apply')) {
        const list = stmt.slice(6);
        for (const m of list.matchAll(/\S+/g)) {
          const tok = m[0];
          const at = index + 6 + m.index;
          const variants = tok.split(':');
          const base = variants.pop();
          if (/[[\]]/.test(tok)) report(file, css, at, tok, '@apply with arbitrary value — add a token to tokens.css');
          else if (/^!|!$/.test(base)) report(file, css, at, tok, '@apply with !important modifier');
          else if (PHYSICAL.test(base))
            report(
              file,
              css,
              at,
              tok,
              'physical-direction utility — use logical (mbs/mbe/ps/pe/inset-s/border-be/inline-*/block-*/text-start)',
            );
          else if (BORDER_WIDTH.test(base))
            report(
              file,
              css,
              at,
              tok,
              'numeric line width — use var(--rule-width) / var(--rule-width-strong) / var(--focus-width)',
            );
          else if (SPACING.test(base) && !SPACING_STEPS.has(base.match(SPACING)[1]))
            report(file, css, at, tok, `spacing step not on the 4px scale (${[...SPACING_STEPS].join(' ')})`);
          else if (MOTION.test(base) && !variants.includes('motion-safe') && !safe)
            report(file, css, at, tok, 'motion outside motion-safe — use motion-safe:… or @variant motion-safe { … }');
        }
      } else if (/^(animation|transition)(-name|-property)?\s*:/.test(stmt) && !/:\s*none\s*$/.test(stmt) && !safe) {
        report(
          file,
          css,
          index,
          stmt.split(':')[0],
          'animation/transition outside @media (prefers-reduced-motion: no-preference) or @variant motion-safe',
        );
      }
    },
  });
}

/* ------------------------------------------- Handlebars import completeness */

function checkComponentImports() {
  const main = join(ROOT, 'src/styles/main.css');
  const dir = join(ROOT, 'src/styles/components');
  if (!existsSync(main) || !existsSync(dir)) return;
  const mainCss = readFileSync(main, 'utf8');
  if (!/@import\s+["']\.\/components\//.test(mainCss.replace(/\/\*[\s\S]*?\*\//g, ''))) return;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    if (!mainCss.includes(`"./components/${f}"`) && !mainCss.includes(`'./components/${f}'`)) {
      violations.push({
        file: relative(ROOT, main),
        line: 1,
        col: 1,
        token: f,
        reason: 'component stylesheet is not @imported by main.css',
      });
    }
  }
}

/* ------------------------------------------------------------------- main */

try {
  const files = walk(ROOT);
  const cssFiles = files.filter((f) => extname(f) === '.css');
  const templates = files.filter((f) => TEMPLATE_EXT.has(extname(f)) && !TEST_FILE.test(basename(f)));

  const cssSources = cssFiles.map((f) => ({ file: f, css: readFileSync(f, 'utf8') }));
  for (const f of templates.filter((t) => extname(t) === '.vue')) {
    for (const block of vueStyleBlocks(readFileSync(f, 'utf8'))) cssSources.push({ file: f, css: block.css });
  }

  const defined = new Set();
  for (const { css } of cssSources) collectDefinedClasses(css, defined);
  const themeNames = themeUtilities(cssSources.map((s) => s.css));

  for (const { file, css } of cssSources) auditCss(file, css);
  checkComponentImports();

  for (const file of templates) {
    const { src, tokens } = extractClassTokens(file, readFileSync(file, 'utf8'));
    for (const { token, index } of tokens) {
      if (token === DYNAMIC) continue; // whole class from a variable, e.g. `${styles.root}`
      const reason = classify(token, defined, themeNames);
      if (reason) report(file, src, index, token, reason);
    }
  }

  const unique = [...new Map(violations.map((v) => [`${v.file}:${v.line}:${v.col}:${v.token}`, v])).values()];
  if (unique.length === 0) {
    console.log(
      `check-no-utilities: OK (${templates.length} templates, ${cssSources.length} stylesheets, ${defined.size} BEM classes)`,
    );
    process.exit(0);
  }
  for (const v of unique) console.error(`${v.file}:${v.line}:${v.col}  ${v.token}  ${v.reason}`);
  console.error(`\ncheck-no-utilities: ${unique.length} violation(s)`);
  process.exit(1);
} catch (error) {
  console.error('check-no-utilities crashed:', error);
  process.exit(2);
}
