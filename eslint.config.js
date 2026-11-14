import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'dist-server/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.{ts,tsx}'], rules: { 'no-undef': 'off', 'no-unreachable': 'error', 'no-dupe-args': 'error' } },
];
