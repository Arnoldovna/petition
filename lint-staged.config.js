/** @type {import('lint-staged').Configuration} */
export default {
  '*.{js,mjs,cjs,ts,mts,cts,tsx,vue}': ['eslint --max-warnings=0 --fix', 'prettier --write'],
  '*.css': ['stylelint --fix', 'prettier --write'],
  '*.{json,md,yml,yaml,html}': ['prettier --write'],
  // The utility-class check needs every stylesheet to know which classes exist, so it ignores the staged file list
  // and checks the whole app whenever markup or CSS is staged (OVERVIEW.md section 18).
  'src/{views,styles}/**/*.{hbs,css}': () => 'node scripts/check-no-utilities.mjs .',
};
