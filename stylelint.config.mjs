// stylelint.config.mjs — maw modular CSS rules for Tailwind CSS v4.
// Verified with stylelint 18 + stylelint-config-standard 41 (petition adds the focus-removal ban below).
// Install: pnpm add -D stylelint stylelint-config-standard
// Run:     stylelint "src/**/*.css"   (Vue: also "src/**/*.vue" with postcss-html, see SKILL.md)

/** BEM: block, block__element, block--modifier, block__element--modifier (kebab-case parts). */
const BEM = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__[a-z0-9]+(?:-[a-z0-9]+)*)?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$';

/** Any raw length. Lengths live in tokens.css; elsewhere use tokens, --spacing(n) or @apply. */
const RAW_LENGTH = '/(?<![\\w-])-?\\d*\\.?\\d+(px|rem|em|ch|vw|vh|dvh|svh|lvh|cqi|cqb)\\b/';

const TAILWIND_AT_RULES = [
  'theme',
  'source',
  'utility',
  'variant',
  'custom-variant',
  'apply',
  'reference',
  'config',
  'plugin',
];

/** Token-only values (the `outline` removal ban is added separately, see FOCUS_REMOVAL below). */
const DISALLOWED_VALUES = {
  '/^(margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left|width|height|min-|max-|inline-size|block-size|font-size|line-height|letter-spacing|border|outline|text-underline-offset|text-decoration-thickness|translate|flex-basis|grid-template)/':
    [RAW_LENGTH],
  '/^(box-shadow|text-shadow)$/': ['/^(?!none$)/'],
  '/^(backdrop-filter|filter)$/': ['/blur/'],
  '/^background(-image)?$/': ['/gradient/'],
  '/^(border-radius|border-.*-radius)$/': ['/^(?!0$|var\\(--radius-)/'],
  'text-align': ['left', 'right'],
};

/**
 * Removing the focus outline is banned (B-66): base.css draws a global :focus-visible ring. The one exception is
 * src/styles/components/form-field.css, whose inputs replace the ring with an equally visible 2px ink underline
 * (maw-design-system "Focus", modular-css-tailwind4 section 5).
 */
const FOCUS_REMOVAL = {
  '/^outline(-style)?$/': ['/^none\\b/', '/^0(\\s|$)/'],
  'outline-width': ['/^0(\\D|$)/'],
};

/** @type {import("stylelint").Config} */
export default {
  extends: ['stylelint-config-standard'],
  ignoreFiles: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/public/**'],
  rules: {
    // --- Tailwind v4 syntax -------------------------------------------------
    'at-rule-no-unknown': [true, { ignoreAtRules: TAILWIND_AT_RULES }],
    'at-rule-no-deprecated': [true, { ignoreAtRules: ['apply'] }],
    'at-rule-prelude-no-invalid': null, // does not know @variant / @theme static / source(none)
    'import-notation': 'string', // @import "tailwindcss"; not url(...)
    'function-no-unknown': [true, { ignoreFunctions: ['--spacing', '--alpha', 'theme'] }],
    'declaration-property-value-no-unknown': null, // --spacing(4) is valid for Tailwind, unknown to csstree

    // --- Architecture -------------------------------------------------------
    'selector-max-id': 0,
    'declaration-no-important': true,
    'selector-class-pattern': [
      BEM,
      { message: (selector) => `Class "${selector}" is not BEM (block__element--modifier, kebab-case)` },
    ],
    // native CSS nesting cannot concatenate: `&__title` / `&--active` are Sass-only
    'selector-nested-pattern': [
      '^(?!&(?:__|--|-|_))',
      { message: 'Write the full BEM class (.block__element), not &__element' },
    ],
    'max-nesting-depth': [2, { ignoreAtRules: ['layer'] }],
    'selector-max-compound-selectors': 3,
    'selector-max-type': [1, { ignore: ['descendant'] }],
    'selector-no-qualifying-type': [true, { ignore: ['attribute'] }],
    'no-descending-specificity': null, // BEM + layers; specificity stays flat by construction

    // --- Tokens only --------------------------------------------------------
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch'],
    'declaration-property-value-disallowed-list': { ...DISALLOWED_VALUES, ...FOCUS_REMOVAL },
    'declaration-property-value-allowed-list': {
      'z-index': ['/^var\\(--layer-/', 'auto', '0'],
      'font-family': ['/^var\\(--font-/', 'inherit'],
      'font-weight': ['/^var\\(--font-weight-/', 'inherit'],
      '/^(transition|animation)-duration$/': ['/^var\\(--duration-/', '0s'],
      '/^(transition|animation)-timing-function$/': ['/^var\\(--ease-/', 'linear', 'steps'],
    },

    // --- Logical properties -------------------------------------------------
    'property-disallowed-list': [
      '/^(margin|padding)-(top|right|bottom|left)$/',
      '/^border-(top|right|bottom|left)(-|$)/',
      '/^(top|right|bottom|left)$/',
      'width',
      'height',
      'min-width',
      'max-width',
      'min-height',
      'max-height',
    ],
  },
  overrides: [
    {
      files: ['src/styles/components/form-field.css'],
      rules: { 'declaration-property-value-disallowed-list': DISALLOWED_VALUES },
    },
    {
      // tokens.css is the single source of raw values; fonts.css holds @font-face (petition)
      files: ['**/styles/tokens.css', '**/styles/fonts.css'],
      rules: {
        'color-no-hex': null,
        'color-named': null,
        'custom-property-pattern': null, // --text-meta--line-height, --color-*: initial
        'declaration-property-value-disallowed-list': null,
        'declaration-property-value-allowed-list': null,
        'selector-max-type': null,
        'selector-max-compound-selectors': null,
        'custom-property-empty-line-before': null, // token groups are separated by blank lines
        'value-keyword-case': null, // font names in --font-sans keep their real casing
      },
    },
  ],
};
