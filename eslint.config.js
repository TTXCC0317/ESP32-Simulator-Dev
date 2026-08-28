// ESLint flat config — 见《02-实施方案》§3.4.1
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import importPlugin from 'eslint-plugin-import';

export default [
  // ---- 全局忽略 ----
  {
    ignores: [
      'dist/**',
      'build/**',
      'data/**',
      'logs/**',
      'config/**', // 运行期配置不入 lint
      'apps/web/src/sim/mpy/**', // WASM 产物目录
      '**/*.wasm',
      'coverage/**',
      '.playwright-report/**',
      'test-results/**',
    ],
  },

  // ---- 基础：JS recommended ----
  js.configs.recommended,

  // ---- TypeScript 文件（apps/ + packages/）----
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      import: importPlugin,
    },
    rules: {
      ...tseslint.configs.strict.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // ---- 前端 React（apps/web）----
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
    },
    settings: {
      react: { version: 'detect' },
    },
  },

  // ---- 后端安全（apps/server，M6 起按 06-§6.1 启用 security 全表）----
  // M0 暂不加载 eslint-plugin-security（v3 flat config 兼容性差），
  // M6 起替换为 import security from 'eslint-plugin-security' 并启用 recommended 规则
  {
    files: ['apps/server/**/*.ts'],
    rules: {
      // 先开少量与 security 无关但等价于约束的规则
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
];
