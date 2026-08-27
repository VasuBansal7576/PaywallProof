import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', '**/.next/**', '.local/**', 'coverage/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.ts', '**/*.tsx'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
);
