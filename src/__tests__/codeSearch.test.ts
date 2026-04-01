import { CodeSearch } from '../codeSearch';
import type { IndexEntry } from '../indexEngine';

describe('CodeSearch', () => {
    test('preserves relative entry paths during indexing', () => {
        const search = new CodeSearch('/workspace');
        const entry: IndexEntry = {
            filepath: 'src/agentLoop.ts',
            contentHash: 'hash-1',
            lastIndexed: Date.now(),
            symbols: [
                {
                    name: 'runLoop',
                    kind: 'function',
                    line: 10,
                    endLine: 20,
                    params: [],
                    returnType: 'void',
                    isExported: true,
                    isAsync: false,
                    isStatic: false,
                },
            ],
            exports: [{ name: 'runLoop', kind: 'function', line: 10 }],
            imports: [],
            skeleton: 'export function runLoop(): void',
        };

        search.updateFromEntry(entry);
        const results = search.search('run loop', 5);

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].chunk.filepath).toBe('src/agentLoop.ts');
    });
});