// `node scripts/check-views.mjs [dir]` (part of `pnpm lint`): bans unsafe or CSP-breaking markup in Handlebars views
// (ADR 0014, ADR 0011). Default dir: src/views.
//
// - unescaped output, in both Handlebars spellings `{{{ }}}` and `{{& }}` (raw HTML: stored XSS, B-01). The single
//   exception is the express-handlebars body slot `{{{body}}}` in `layouts/*.hbs` (OVERVIEW.md section 15.1): it
//   prints the already rendered page.
// - `target="_blank"` (internal links never open new tabs; external user links open in the same tab, B-17)
// - `style="..."` attributes and `<style>` elements (CSP `style-src 'self'`; styles live in src/styles)
// - inline `<script>` without `src`, and `on...=` event-handler attributes (CSP `script-src 'self'`)
//
// Handlebars comments ({{! }} and {{!-- --}}) are ignored, so a comment may mention a banned construct.
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_DIR = 'src/views';
/** The express-handlebars body slot, allowed only in layouts (exact spelling, no whitespace control). */
const BODY_SLOT = '{{{body}}}';

/** Each rule: a global regex over comment-free template text and the message for a match. */
const RULES = [
  {
    // `{{{`, `{{&` and their whitespace-control forms `{{~{`, `{{~&`
    pattern: /\{\{~?[{&]/g,
    message: 'unescaped output ({{{ }}} or {{& }}) prints raw HTML; pass plain strings and use {{ }}',
  },
  {
    pattern: /\btarget\s*=\s*["']?_blank\b/gi,
    message: 'target="_blank" is not allowed; links open in the same tab (ADR 0014)',
  },
  {
    pattern: /<[a-z][\w-]*(?:\s[^<>]*?)?\sstyle\s*=/gi,
    message: "inline style attributes break the CSP (style-src 'self'); add a BEM class in src/styles",
  },
  {
    pattern: /<style\b/gi,
    message: "<style> elements break the CSP (style-src 'self'); add the rules to src/styles",
  },
  {
    pattern: /<script\b(?![^>]*\ssrc\s*=)[^>]*>/gi,
    message: "inline <script> breaks the CSP (script-src 'self'); use a module in src/client loaded with src=",
  },
  {
    pattern: /<[a-z][\w-]*(?:\s[^<>]*?)?\son[a-z]+\s*=/gi,
    message: "inline event handlers break the CSP (script-src 'self'); attach listeners in src/client",
  },
];

/**
 * Replaces Handlebars comments with spaces of the same shape, so line and column numbers stay correct.
 *
 * @param {string} source
 */
export function stripComments(source) {
  return source.replace(/\{\{!--[\s\S]*?--\}\}|\{\{![\s\S]*?\}\}/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/**
 * Checks one template.
 *
 * @param {string} source
 * @param {{ layout?: boolean }} [options] `layout: true` allows the body slot `{{{body}}}` (layouts only)
 * @returns {{ line: number, column: number, message: string }[]} findings sorted by position
 */
export function checkTemplate(source, { layout = false } = {}) {
  const withoutComments = stripComments(source);
  const text = layout ? withoutComments.replaceAll(BODY_SLOT, ' '.repeat(BODY_SLOT.length)) : withoutComments;
  const findings = [];
  for (const { pattern, message } of RULES) {
    for (const match of text.matchAll(pattern)) {
      findings.push({ ...position(text, match.index), message });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

function position(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  return { line, column: index - before.lastIndexOf('\n') };
}

/**
 * @param {string} dir the views folder that was scanned
 * @param {string} file absolute path of a template below dir
 * @returns {boolean} whether the file is a layout (directly in `<dir>/layouts/`)
 */
export function isLayout(dir, file) {
  const parts = relative(dir, file).split(sep);
  return parts.length === 2 && parts[0] === 'layouts';
}

/**
 * @param {string} dir
 * @returns {string[]} absolute paths of every .hbs file below dir, sorted
 */
export function listTemplates(dir) {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.hbs'))
    .map((name) => resolve(dir, name))
    .sort();
}

function main(argv) {
  const dir = resolve(ROOT, argv[0] ?? DEFAULT_DIR);
  const templates = listTemplates(dir);
  let count = 0;
  for (const file of templates) {
    for (const finding of checkTemplate(readFileSync(file, 'utf8'), { layout: isLayout(dir, file) })) {
      count += 1;
      console.error(`${relative(ROOT, file)}:${finding.line}:${finding.column}  ${finding.message}`);
    }
  }
  if (count > 0) {
    console.error(`\ncheck-views: ${count} problem(s) in ${relative(ROOT, dir)}`);
    return 1;
  }
  console.log(`check-views: ${templates.length} template(s) in ${relative(ROOT, dir)} are clean`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`check-views: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
