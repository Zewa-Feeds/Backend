// ESLint flat config (eslint 10). Replaces the legacy .eslintrc.json format.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        // Both scopes: src/ compiles to dist/, while prisma/seed.ts and
        // prisma.config.ts run through tsx and live in tsconfig.scripts.json.
        project: ['./tsconfig.json', './tsconfig.scripts.json'],
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Use the pino logger, not console — structured logs are the contract.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // CLI scripts print to stdout by design — they run in a terminal, not in a
    // request, so there is no structured logger to route through.
    files: ['prisma/seed.ts', 'scripts/**/*.ts', 'src/config/env.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
