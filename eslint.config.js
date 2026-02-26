// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
    // Global ignores
    {
        ignores: ['out/', 'node_modules/', 'coverage/', '*.js', 'parsers/'],
    },

    // Base recommended rules
    ...tseslint.configs.recommended,

    // TypeScript source files
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // Relaxed for existing codebase — tighten incrementally
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-require-imports': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'prefer-const': 'warn',
            'no-console': 'off',
        },
    },

    // Test files — relax some rules
    {
        files: ['src/__tests__/**/*.ts', 'src/**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
);
