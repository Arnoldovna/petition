// Conventional Commits, checked by lefthook's commit-msg hook.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Scopes are optional, but when present they name a feature or package.
    'scope-case': [2, 'always', 'kebab-case'],
    'body-max-line-length': [1, 'always', 100],
  },
};
