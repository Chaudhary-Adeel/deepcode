/**
 * SymbolGraph unit tests — focused on call-graph edge tracking.
 */

import { SymbolGraph, GraphSymbol } from '../symbolGraph';
import type { IndexEntry, SymbolInfo, IndexEngine } from '../indexEngine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSymbol(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
    return {
        name: 'testFn',
        kind: 'function',
        line: 0,
        endLine: 5,
        params: [],
        returnType: 'void',
        isExported: false,
        isAsync: false,
        isStatic: false,
        ...overrides,
    };
}

function makeEntry(overrides: Partial<IndexEntry> = {}): IndexEntry {
    return {
        filepath: 'src/test.ts',
        contentHash: 'abc123',
        lastIndexed: Date.now(),
        symbols: [],
        exports: [],
        imports: [],
        skeleton: '',
        ...overrides,
    };
}

// Minimal mock IndexEngine — SymbolGraph only uses it as a constructor arg
const mockIndexEngine = {} as IndexEngine;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SymbolGraph', () => {

    let graph: SymbolGraph;

    beforeEach(() => {
        graph = new SymbolGraph(mockIndexEngine);
    });

    // ─── Basic symbol lookups ────────────────────────────────────────────

    test('getSymbol returns empty for unknown name', () => {
        expect(graph.getSymbol('nonexistent')).toEqual([]);
    });

    test('getSymbol returns symbol after updateFromEntry', () => {
        graph.updateFromEntry(makeEntry({
            filepath: 'src/foo.ts',
            symbols: [makeSymbol({ name: 'foo', isExported: true })],
            exports: [{ name: 'foo', kind: 'function', line: 0 }],
        }));

        const results = graph.getSymbol('foo');
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('foo');
        expect(results[0].filepath).toBe('src/foo.ts');
    });

    test('searchSymbols with fuzzy query', () => {
        graph.updateFromEntry(makeEntry({
            filepath: 'src/utils.ts',
            symbols: [
                makeSymbol({ name: 'handleClick', isExported: true }),
                makeSymbol({ name: 'handleSubmit', isExported: true }),
                makeSymbol({ name: 'parseData', isExported: false }),
            ],
        }));

        const results = graph.searchSymbols('handle');
        expect(results).toHaveLength(2);
        expect(results.map(r => r.name)).toEqual(
            expect.arrayContaining(['handleClick', 'handleSubmit']),
        );
    });

    // ─── Import edge tracking ────────────────────────────────────────────

    test('getImporters returns files that import a given file', () => {
        graph.updateFromEntry(makeEntry({
            filepath: 'src/utils.ts',
            symbols: [makeSymbol({ name: 'helper', isExported: true })],
            exports: [{ name: 'helper', kind: 'function', line: 0 }],
        }));

        graph.updateFromEntry(makeEntry({
            filepath: 'src/main.ts',
            imports: [{ source: './utils', specifiers: ['helper'], isTypeOnly: false, line: 0 }],
        }));

        const importers = graph.getImporters('src/utils.ts');
        expect(importers).toContain('src/main.ts');
    });

    // ─── Call-graph edges ────────────────────────────────────────────────

    test('getCallees returns functions called by a symbol', () => {
        // File A defines `caller` which calls `callee`
        // File A also defines `callee`
        graph.updateFromEntry(makeEntry({
            filepath: 'src/a.ts',
            symbols: [
                makeSymbol({ name: 'callee', isExported: true, line: 0, endLine: 3 }),
                makeSymbol({ name: 'caller', isExported: true, line: 5, endLine: 10, calls: ['callee'] }),
            ],
            exports: [
                { name: 'callee', kind: 'function', line: 0 },
                { name: 'caller', kind: 'function', line: 5 },
            ],
        }));

        const callees = graph.getCallees('caller');
        expect(callees).toHaveLength(1);
        expect(callees[0].name).toBe('callee');
    });

    test('getCallers returns functions that call a symbol', () => {
        graph.updateFromEntry(makeEntry({
            filepath: 'src/a.ts',
            symbols: [
                makeSymbol({ name: 'target', isExported: true, line: 0, endLine: 3 }),
                makeSymbol({ name: 'alpha', isExported: false, line: 5, endLine: 10, calls: ['target'] }),
                makeSymbol({ name: 'beta', isExported: false, line: 12, endLine: 17, calls: ['target'] }),
            ],
            exports: [{ name: 'target', kind: 'function', line: 0 }],
        }));

        const callers = graph.getCallers('target');
        expect(callers).toHaveLength(2);
        expect(callers.map(c => c.name).sort()).toEqual(['alpha', 'beta']);
    });

    test('getCallees resolves cross-file calls via imports', () => {
        // File B exports `doWork`
        graph.updateFromEntry(makeEntry({
            filepath: 'src/b.ts',
            symbols: [makeSymbol({ name: 'doWork', isExported: true })],
            exports: [{ name: 'doWork', kind: 'function', line: 0 }],
        }));

        // File A imports `doWork` from B and calls it
        graph.updateFromEntry(makeEntry({
            filepath: 'src/a.ts',
            symbols: [
                makeSymbol({ name: 'main', isExported: true, calls: ['doWork'] }),
            ],
            imports: [{ source: './b', specifiers: ['doWork'], isTypeOnly: false, line: 0 }],
            exports: [{ name: 'main', kind: 'function', line: 0 }],
        }));

        const callees = graph.getCallees('main');
        expect(callees.some(c => c.name === 'doWork')).toBe(true);

        const callers = graph.getCallers('doWork');
        expect(callers.some(c => c.name === 'main')).toBe(true);
    });

    test('call edges are cleaned up on file re-index', () => {
        graph.updateFromEntry(makeEntry({
            filepath: 'src/a.ts',
            symbols: [
                makeSymbol({ name: 'foo', isExported: true }),
                makeSymbol({ name: 'bar', calls: ['foo'] }),
            ],
            exports: [{ name: 'foo', kind: 'function', line: 0 }],
        }));

        expect(graph.getCallers('foo')).toHaveLength(1);

        // Re-index the same file — bar no longer calls foo
        graph.updateFromEntry(makeEntry({
            filepath: 'src/a.ts',
            symbols: [
                makeSymbol({ name: 'foo', isExported: true }),
                makeSymbol({ name: 'bar' }), // no calls
            ],
            exports: [{ name: 'foo', kind: 'function', line: 0 }],
        }));

        expect(graph.getCallers('foo')).toHaveLength(0);
    });

    // ─── Class method call edges ─────────────────────────────────────────

    test('method-level call edges work', () => {
        graph.updateFromEntry(makeEntry({
            filepath: 'src/service.ts',
            symbols: [
                makeSymbol({
                    name: 'Service',
                    kind: 'class',
                    isExported: true,
                    methods: [
                        makeSymbol({ name: 'init', kind: 'method', calls: ['connect'] }),
                        makeSymbol({ name: 'connect', kind: 'method' }),
                    ],
                }),
            ],
            exports: [{ name: 'Service', kind: 'class', line: 0 }],
        }));

        const callees = graph.getCallees('init');
        expect(callees.some(c => c.name === 'connect')).toBe(true);
    });

    // ─── Stats ───────────────────────────────────────────────────────────

    test('getStats includes call edge count', () => {
        graph.updateFromEntry(makeEntry({
            filepath: 'src/a.ts',
            symbols: [
                makeSymbol({ name: 'a', calls: ['b'] }),
                makeSymbol({ name: 'b' }),
            ],
        }));

        const stats = graph.getStats();
        expect(stats.totalCallEdges).toBeGreaterThanOrEqual(1);
    });

    // ─── findReferences ──────────────────────────────────────────────────

    test('findReferences includes definitions and imports', () => {
        graph.updateFromEntry(makeEntry({
            filepath: 'src/lib.ts',
            symbols: [makeSymbol({ name: 'helper', isExported: true })],
            exports: [{ name: 'helper', kind: 'function', line: 0 }],
        }));

        graph.updateFromEntry(makeEntry({
            filepath: 'src/app.ts',
            symbols: [makeSymbol({ name: 'main' })],
            imports: [{ source: './lib', specifiers: ['helper'], isTypeOnly: false, line: 0 }],
        }));

        const refs = graph.findReferences('helper');
        expect(refs.length).toBeGreaterThanOrEqual(2);
        expect(refs.some(r => r.kind === 'export')).toBe(true);
        expect(refs.some(r => r.kind === 'import')).toBe(true);
    });
});
