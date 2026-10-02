import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const LETTERS = '/[A-Za-zА-Яа-яЁё]/';
const I18N_MESSAGE =
  'User-facing text must come from i18n: use t() with a key in packages/shared/src/i18n/locales.';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'apps/server/src/db/migrations/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    // Node-side config, type-checked with its own tsconfig (not part of the browser project).
    files: [
      'apps/miniapp/vite.config.ts',
      'apps/miniapp/dev-env.ts',
      'apps/miniapp/dev-env.test.ts',
    ],
    languageOptions: {
      parserOptions: { projectService: false, project: './apps/miniapp/tsconfig.node.json' },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // Runtime server code must never import the dev/test initData signer.
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/http/auth/init-data-signer.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/init-data-signer'],
              message: 'The initData signer is for dev scripts and tests only.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts'],
    plugins: { vitest },
    rules: {
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/expect-expect': [
        'error',
        {
          assertFunctionNames: [
            'expect',
            'expectDenied',
            'expectError',
            'expectParity',
            'fc.assert',
          ],
        },
      ],
    },
  },
  {
    files: ['apps/miniapp/src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // No hardcoded user-facing strings in Mini App JSX (CLAUDE.md, i18n).
    files: ['apps/miniapp/src/**/*.tsx'],
    ignores: ['**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        // Text children: <p>Hello</p>, <p>{'Hello'}</p>, <p>{`Hello`}</p>
        {
          selector: `:matches(JSXElement, JSXFragment) > JSXText[value=${LETTERS}]`,
          message: I18N_MESSAGE,
        },
        {
          selector: `:matches(JSXElement, JSXFragment) > JSXExpressionContainer > Literal[value=${LETTERS}]`,
          message: I18N_MESSAGE,
        },
        {
          selector: `:matches(JSXElement, JSXFragment) > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=${LETTERS}]`,
          message: I18N_MESSAGE,
        },
        // Accessible names and visible attribute text.
        {
          selector: `JSXAttribute[name.name=/^(aria-label|aria-description|title|placeholder|alt)$/] Literal[value=${LETTERS}]`,
          message: I18N_MESSAGE,
        },
      ],
    },
  },
);
