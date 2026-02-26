/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            tsconfig: 'tsconfig.json',
        }],
    },
    // VS Code's `vscode` module is not available in test env — mock it
    moduleNameMapper: {
        '^vscode$': '<rootDir>/src/__tests__/__mocks__/vscode.ts',
    },
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/__tests__/**',
        '!src/extension.ts',
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
};
