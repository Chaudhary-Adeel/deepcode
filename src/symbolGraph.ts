/**
 * Symbol Graph for DeepCode
 *
 * Provides a traversable graph of all symbols (functions, classes, interfaces,
 * types, enums, variables) across the workspace. Built from IndexEngine AST
 * output and updated incrementally as files are indexed.
 *
 * Supports:
 * - Symbol lookup by name (exact + fuzzy)
 * - Caller/callee relationships
 * - Import/export edge traversal
 * - Type signature retrieval for public symbols
 */

import type {
    IndexEntry,
    SymbolInfo,
    ImportInfo,
    ExportInfo,
    SymbolKind,
    IndexEngine,
} from './indexEngine';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GraphSymbol {
    /** Symbol name */
    name: string;
    /** Fully qualified name: filepath#name */
    fqn: string;
    /** Symbol kind (function, class, etc.) */
    kind: SymbolKind;
    /** Workspace-relative file path */
    filepath: string;
    /** 0-based start line */
    line: number;
    /** 0-based end line */
    endLine: number;
    /** Human-readable type signature */
    signature: string;
    /** Whether the symbol is exported */
    isExported: boolean;
    /** Whether the symbol is async */
    isAsync: boolean;
    /** Child methods (for classes/interfaces) */
    methods: GraphSymbol[];
}

export interface SymbolReference {
    /** The symbol being referenced */
    symbol: GraphSymbol;
    /** How it's referenced */
    kind: 'import' | 'call' | 'export' | 'reexport';
}

export interface CallEdge {
    /** FQN of the caller symbol */
    callerFQN: string;
    /** FQN of the callee symbol */
    calleeFQN: string;
}

export interface ImportEdge {
    /** File that imports */
    importer: string;
    /** File that is imported from */
    source: string;
    /** Specifiers imported */
    specifiers: string[];
    /** Whether it's a type-only import */
    isTypeOnly: boolean;
}

// ─── SymbolGraph ─────────────────────────────────────────────────────────────

export class SymbolGraph {

    private readonly indexEngine: IndexEngine;

    // Primary index: FQN → GraphSymbol
    private readonly symbolsByFQN = new Map<string, GraphSymbol>();

    // Name index: name → Set of FQNs (handles duplicates across files)
    private readonly symbolsByName = new Map<string, Set<string>>();

    // File index: filepath → Set of FQNs
    private readonly symbolsByFile = new Map<string, Set<string>>();

    // Import edges: importer filepath → ImportEdge[]
    private readonly importEdges = new Map<string, ImportEdge[]>();

    // Reverse import map: source filepath → Set of importer filepaths
    private readonly reverseImports = new Map<string, Set<string>>();

    // Export index: filepath → exported symbol names
    private readonly exportsByFile = new Map<string, Set<string>>();

    // Call graph: callerFQN → Set of calleeFQNs
    private readonly calleeEdges = new Map<string, Set<string>>();

    // Reverse call graph: calleeFQN → Set of callerFQNs
    private readonly callerEdges = new Map<string, Set<string>>();

    constructor(indexEngine: IndexEngine) {
        this.indexEngine = indexEngine;
    }

    // ─── Incremental Update ──────────────────────────────────────────────

    /**
     * Update the graph from a freshly indexed file entry.
     * Removes old data for the file, then adds new symbols/edges.
     */
    updateFromEntry(entry: IndexEntry): void {
        const filepath = entry.filepath;

        // 1. Remove old data for this file
        this.removeFile(filepath);

        // 2. Add symbols
        for (const sym of entry.symbols) {
            this.addSymbol(filepath, sym);
        }

        // 3. Add import edges
        const edges: ImportEdge[] = [];
        for (const imp of entry.imports) {
            const edge: ImportEdge = {
                importer: filepath,
                source: imp.source,
                specifiers: imp.specifiers,
                isTypeOnly: imp.isTypeOnly,
            };
            edges.push(edge);

            // Build reverse import map (resolve relative imports only)
            if (imp.source.startsWith('.')) {
                const resolved = this.resolveImportSource(filepath, imp.source);
                if (resolved) {
                    let importers = this.reverseImports.get(resolved);
                    if (!importers) {
                        importers = new Set();
                        this.reverseImports.set(resolved, importers);
                    }
                    importers.add(filepath);
                }
            }
        }
        this.importEdges.set(filepath, edges);

        // 4. Add exports
        const exportNames = new Set(entry.exports.map(e => e.name));
        this.exportsByFile.set(filepath, exportNames);

        // 5. Build call-graph edges from symbol calls
        this.buildCallEdgesForFile(filepath, entry);
    }

    /**
     * Bulk-load from all cached entries (called on startup).
     */
    loadFromCache(entries: Map<string, IndexEntry>): void {
        for (const [, entry] of entries) {
            this.updateFromEntry(entry);
        }
    }

    // ─── Public Query API ────────────────────────────────────────────────

    /**
     * Look up symbols by exact name.
     * Returns all symbols with that name across all files.
     */
    getSymbol(name: string): GraphSymbol[] {
        const fqns = this.symbolsByName.get(name);
        if (!fqns) { return []; }

        const results: GraphSymbol[] = [];
        for (const fqn of fqns) {
            const sym = this.symbolsByFQN.get(fqn);
            if (sym) { results.push(sym); }
        }
        return results;
    }

    /**
     * Fuzzy symbol search — matches symbols whose name contains the query.
     * Returns at most `limit` results, prioritizing exported symbols.
     */
    searchSymbols(query: string, limit = 20): GraphSymbol[] {
        const lowerQuery = query.toLowerCase();
        const results: GraphSymbol[] = [];

        for (const [name, fqns] of this.symbolsByName) {
            if (!name.toLowerCase().includes(lowerQuery)) { continue; }
            for (const fqn of fqns) {
                const sym = this.symbolsByFQN.get(fqn);
                if (sym) { results.push(sym); }
            }
        }

        // Sort: exported first, then exact match, then alphabetical
        results.sort((a, b) => {
            if (a.isExported !== b.isExported) { return a.isExported ? -1 : 1; }
            const aExact = a.name.toLowerCase() === lowerQuery;
            const bExact = b.name.toLowerCase() === lowerQuery;
            if (aExact !== bExact) { return aExact ? -1 : 1; }
            return a.name.localeCompare(b.name);
        });

        return results.slice(0, limit);
    }

    /**
     * Get all symbols defined in a specific file.
     */
    getSymbolsInFile(filepath: string): GraphSymbol[] {
        const fqns = this.symbolsByFile.get(filepath);
        if (!fqns) { return []; }

        const results: GraphSymbol[] = [];
        for (const fqn of fqns) {
            const sym = this.symbolsByFQN.get(fqn);
            if (sym) { results.push(sym); }
        }
        return results;
    }

    /**
     * Get files that import from the given file (reverse import lookup).
     */
    getImporters(filepath: string): string[] {
        const importers = this.reverseImports.get(filepath);
        return importers ? Array.from(importers) : [];
    }

    /**
     * Get files that the given file imports from.
     */
    getImports(filepath: string): ImportEdge[] {
        return this.importEdges.get(filepath) || [];
    }

    /**
     * Get all symbols that call the given symbol (callers / "who calls me?").
     * Looks up by symbol name — returns all caller GraphSymbols across the workspace.
     */
    getCallers(symbolName: string): GraphSymbol[] {
        const targets = this.getSymbol(symbolName);
        if (targets.length === 0) { return []; }

        const callerFQNs = new Set<string>();

        for (const target of targets) {
            // Check direct FQN match
            const directCallers = this.callerEdges.get(target.fqn);
            if (directCallers) {
                for (const fqn of directCallers) { callerFQNs.add(fqn); }
            }

            // Also check by bare name (for cross-file calls resolved by name)
            for (const [calleeFQN, callers] of this.callerEdges) {
                if (calleeFQN.endsWith('#' + symbolName) || calleeFQN.endsWith('.' + symbolName)) {
                    for (const fqn of callers) { callerFQNs.add(fqn); }
                }
            }
        }

        const results: GraphSymbol[] = [];
        for (const fqn of callerFQNs) {
            const sym = this.symbolsByFQN.get(fqn);
            if (sym) { results.push(sym); }
        }
        return results;
    }

    /**
     * Get all symbols that a given symbol calls (callees / "what do I call?").
     */
    getCallees(symbolName: string): GraphSymbol[] {
        const sources = this.getSymbol(symbolName);
        if (sources.length === 0) { return []; }

        const calleeFQNs = new Set<string>();

        for (const source of sources) {
            const directCallees = this.calleeEdges.get(source.fqn);
            if (directCallees) {
                for (const fqn of directCallees) { calleeFQNs.add(fqn); }
            }
        }

        const results: GraphSymbol[] = [];
        for (const fqn of calleeFQNs) {
            const sym = this.symbolsByFQN.get(fqn);
            if (sym) { results.push(sym); }
        }
        return results;
    }

    /**
     * Get all symbols exported by a file.
     */
    getExportedSymbols(filepath: string): GraphSymbol[] {
        const fqns = this.symbolsByFile.get(filepath);
        if (!fqns) { return []; }

        const results: GraphSymbol[] = [];
        for (const fqn of fqns) {
            const sym = this.symbolsByFQN.get(fqn);
            if (sym && sym.isExported) { results.push(sym); }
        }
        return results;
    }

    /**
     * Find all references to a symbol name across the workspace.
     * Checks import specifiers and re-exports.
     */
    findReferences(symbolName: string): SymbolReference[] {
        const refs: SymbolReference[] = [];

        // 1. Find the definition(s)
        const definitions = this.getSymbol(symbolName);
        for (const def of definitions) {
            refs.push({ symbol: def, kind: 'export' });
        }

        // 2. Find imports of this symbol
        for (const [importerPath, edges] of this.importEdges) {
            for (const edge of edges) {
                if (edge.specifiers.includes(symbolName) || edge.specifiers.includes('*')) {
                    // This file imports the symbol
                    const importerSymbols = this.getSymbolsInFile(importerPath);
                    if (importerSymbols.length > 0) {
                        refs.push({
                            symbol: {
                                name: symbolName,
                                fqn: `${importerPath}#import:${symbolName}`,
                                kind: 'variable',
                                filepath: importerPath,
                                line: 0,
                                endLine: 0,
                                signature: `import { ${symbolName} } from '${edge.source}'`,
                                isExported: false,
                                isAsync: false,
                                methods: [],
                            },
                            kind: 'import',
                        });
                    }
                }
            }
        }

        // 3. Find re-exports
        for (const [filepath, exports] of this.exportsByFile) {
            if (exports.has(symbolName)) {
                const existing = definitions.find(d => d.filepath === filepath);
                if (!existing) {
                    refs.push({
                        symbol: {
                            name: symbolName,
                            fqn: `${filepath}#reexport:${symbolName}`,
                            kind: 'variable',
                            filepath,
                            line: 0,
                            endLine: 0,
                            signature: `export { ${symbolName} }`,
                            isExported: true,
                            isAsync: false,
                            methods: [],
                        },
                        kind: 'reexport',
                    });
                }
            }
        }

        return refs;
    }

    /**
     * Get graph statistics for status/debugging.
     */
    getStats(): { totalSymbols: number; totalFiles: number; totalImportEdges: number; totalCallEdges: number } {
        let totalImportEdges = 0;
        for (const [, edges] of this.importEdges) {
            totalImportEdges += edges.length;
        }

        let totalCallEdges = 0;
        for (const [, callees] of this.calleeEdges) {
            totalCallEdges += callees.size;
        }

        return {
            totalSymbols: this.symbolsByFQN.size,
            totalFiles: this.symbolsByFile.size,
            totalImportEdges,
            totalCallEdges,
        };
    }

    // ─── Private Helpers ─────────────────────────────────────────────────

    private addSymbol(filepath: string, sym: SymbolInfo): void {
        const graphSym = this.toGraphSymbol(filepath, sym);

        // FQN index
        this.symbolsByFQN.set(graphSym.fqn, graphSym);

        // Name index
        let nameSet = this.symbolsByName.get(graphSym.name);
        if (!nameSet) {
            nameSet = new Set();
            this.symbolsByName.set(graphSym.name, nameSet);
        }
        nameSet.add(graphSym.fqn);

        // File index
        let fileSet = this.symbolsByFile.get(filepath);
        if (!fileSet) {
            fileSet = new Set();
            this.symbolsByFile.set(filepath, fileSet);
        }
        fileSet.add(graphSym.fqn);

        // Recursively add methods
        if (sym.methods) {
            for (const method of sym.methods) {
                const methodSym = this.toGraphSymbol(filepath, method, graphSym.name);
                this.symbolsByFQN.set(methodSym.fqn, methodSym);

                let methodNameSet = this.symbolsByName.get(methodSym.name);
                if (!methodNameSet) {
                    methodNameSet = new Set();
                    this.symbolsByName.set(methodSym.name, methodNameSet);
                }
                methodNameSet.add(methodSym.fqn);

                fileSet.add(methodSym.fqn);
            }
        }
    }

    private removeFile(filepath: string): void {
        // Remove all symbols for this file
        const fqns = this.symbolsByFile.get(filepath);
        if (fqns) {
            for (const fqn of fqns) {
                const sym = this.symbolsByFQN.get(fqn);
                if (sym) {
                    const nameSet = this.symbolsByName.get(sym.name);
                    if (nameSet) {
                        nameSet.delete(fqn);
                        if (nameSet.size === 0) {
                            this.symbolsByName.delete(sym.name);
                        }
                    }
                }
                this.symbolsByFQN.delete(fqn);
            }
            this.symbolsByFile.delete(filepath);
        }

        // Remove import edges originating from this file
        const oldEdges = this.importEdges.get(filepath);
        if (oldEdges) {
            for (const edge of oldEdges) {
                if (edge.source.startsWith('.')) {
                    const resolved = this.resolveImportSource(filepath, edge.source);
                    if (resolved) {
                        const importers = this.reverseImports.get(resolved);
                        if (importers) {
                            importers.delete(filepath);
                            if (importers.size === 0) {
                                this.reverseImports.delete(resolved);
                            }
                        }
                    }
                }
            }
            this.importEdges.delete(filepath);
        }

        // Remove exports
        this.exportsByFile.delete(filepath);

        // Remove call edges originating from symbols in this file
        if (fqns) {
            for (const fqn of fqns) {
                // Remove outgoing call edges
                const callees = this.calleeEdges.get(fqn);
                if (callees) {
                    for (const calleeFQN of callees) {
                        const callers = this.callerEdges.get(calleeFQN);
                        if (callers) {
                            callers.delete(fqn);
                            if (callers.size === 0) { this.callerEdges.delete(calleeFQN); }
                        }
                    }
                    this.calleeEdges.delete(fqn);
                }

                // Remove incoming call edges
                const callers = this.callerEdges.get(fqn);
                if (callers) {
                    for (const callerFQN of callers) {
                        const cees = this.calleeEdges.get(callerFQN);
                        if (cees) {
                            cees.delete(fqn);
                            if (cees.size === 0) { this.calleeEdges.delete(callerFQN); }
                        }
                    }
                    this.callerEdges.delete(fqn);
                }
            }
        }
    }

    private toGraphSymbol(filepath: string, sym: SymbolInfo, parentName?: string): GraphSymbol {
        const qualifiedName = parentName ? `${parentName}.${sym.name}` : sym.name;
        const fqn = `${filepath}#${qualifiedName}`;

        return {
            name: sym.name,
            fqn,
            kind: sym.kind,
            filepath,
            line: sym.line,
            endLine: sym.endLine,
            signature: this.buildSignature(sym),
            isExported: sym.isExported,
            isAsync: sym.isAsync,
            methods: sym.methods
                ? sym.methods.map(m => this.toGraphSymbol(filepath, m, qualifiedName))
                : [],
        };
    }

    private buildSignature(sym: SymbolInfo): string {
        const parts: string[] = [];

        if (sym.isExported) { parts.push('export'); }
        if (sym.isAsync) { parts.push('async'); }
        if (sym.isStatic) { parts.push('static'); }

        switch (sym.kind) {
            case 'function':
            case 'method': {
                parts.push(sym.kind === 'method' ? sym.name : `function ${sym.name}`);
                const paramStr = sym.params
                    .map(p => p.type ? `${p.name}: ${p.type}` : p.name)
                    .join(', ');
                parts[parts.length - 1] += `(${paramStr})`;
                if (sym.returnType) {
                    parts[parts.length - 1] += `: ${sym.returnType}`;
                }
                break;
            }
            case 'class':
                parts.push(`class ${sym.name}`);
                break;
            case 'interface':
                parts.push(`interface ${sym.name}`);
                break;
            case 'type':
                parts.push(`type ${sym.name}`);
                break;
            case 'enum':
                parts.push(`enum ${sym.name}`);
                break;
            case 'variable':
                parts.push(`${sym.name}`);
                if (sym.returnType) {
                    parts[parts.length - 1] += `: ${sym.returnType}`;
                }
                break;
        }

        return parts.join(' ');
    }

    /**
     * Build call-graph edges for all symbols in a file.
     * For each symbol with `calls`, resolve each callee name to known FQNs
     * and create bidirectional edges (calleeEdges / callerEdges).
     */
    private buildCallEdgesForFile(filepath: string, entry: IndexEntry): void {
        const allSymbols = this.collectSymbolsWithCalls(filepath, entry.symbols);

        // Build a set of imported names → their source FQNs for resolution
        const importedNames = new Map<string, string[]>();
        for (const imp of entry.imports) {
            if (imp.source.startsWith('.')) {
                const resolved = this.resolveImportSource(filepath, imp.source);
                if (resolved) {
                    for (const spec of imp.specifiers) {
                        if (spec === '*') { continue; }
                        const fqn = `${resolved}#${spec}`;
                        let existing = importedNames.get(spec);
                        if (!existing) {
                            existing = [];
                            importedNames.set(spec, existing);
                        }
                        existing.push(fqn);
                    }
                }
            }
        }

        for (const { callerFQN, calls } of allSymbols) {
            if (!calls || calls.length === 0) { continue; }

            for (const calleeName of calls) {
                const resolvedFQNs = this.resolveCallee(calleeName, filepath, importedNames);

                for (const calleeFQN of resolvedFQNs) {
                    // Add outgoing edge: caller → callee
                    let calleeSet = this.calleeEdges.get(callerFQN);
                    if (!calleeSet) {
                        calleeSet = new Set();
                        this.calleeEdges.set(callerFQN, calleeSet);
                    }
                    calleeSet.add(calleeFQN);

                    // Add incoming edge: callee → caller
                    let callerSet = this.callerEdges.get(calleeFQN);
                    if (!callerSet) {
                        callerSet = new Set();
                        this.callerEdges.set(calleeFQN, callerSet);
                    }
                    callerSet.add(callerFQN);
                }
            }
        }
    }

    /**
     * Collect all symbols (including methods) with their FQNs and calls arrays.
     */
    private collectSymbolsWithCalls(
        filepath: string,
        symbols: SymbolInfo[],
        parentName?: string,
    ): Array<{ callerFQN: string; calls: string[] }> {
        const result: Array<{ callerFQN: string; calls: string[] }> = [];

        for (const sym of symbols) {
            const qualifiedName = parentName ? `${parentName}.${sym.name}` : sym.name;
            const fqn = `${filepath}#${qualifiedName}`;

            if (sym.calls && sym.calls.length > 0) {
                result.push({ callerFQN: fqn, calls: sym.calls });
            }

            if (sym.methods) {
                result.push(...this.collectSymbolsWithCalls(filepath, sym.methods, qualifiedName));
            }
        }

        return result;
    }

    /**
     * Resolve a callee name to known FQNs in the graph.
     * Priority: 1) same-file symbol, 2) imported symbol, 3) any known symbol by name.
     */
    private resolveCallee(
        name: string,
        currentFile: string,
        importedNames: Map<string, string[]>,
    ): string[] {
        // 1. Same-file symbol
        const localFQN = `${currentFile}#${name}`;
        if (this.symbolsByFQN.has(localFQN)) {
            return [localFQN];
        }

        // 2. Imported symbol
        const imported = importedNames.get(name);
        if (imported && imported.length > 0) {
            // Verify at least one exists in the graph
            const valid = imported.filter(fqn => this.symbolsByFQN.has(fqn));
            if (valid.length > 0) { return valid; }
            // Even if not yet indexed, trust the import resolution
            return imported;
        }

        // 3. Global lookup by name (fallback — may produce false positives)
        const fqns = this.symbolsByName.get(name);
        if (fqns && fqns.size > 0 && fqns.size <= 3) {
            // Only use global fallback if unambiguous (≤3 matches)
            return Array.from(fqns);
        }

        return [];
    }

    /**
     * Resolve a relative import source to a workspace-relative path.
     * Best-effort: checks known files in the graph first, then guesses .ts.
     */
    private resolveImportSource(fromFile: string, importSource: string): string | null {
        if (!importSource.startsWith('.')) { return null; }

        // Simple resolution: join from directory + import source
        const fromDir = fromFile.includes('/')
            ? fromFile.substring(0, fromFile.lastIndexOf('/'))
            : '.';

        // Normalize the path
        const segments = (fromDir + '/' + importSource).split('/');
        const resolved: string[] = [];
        for (const seg of segments) {
            if (seg === '.' || seg === '') { continue; }
            if (seg === '..') { resolved.pop(); continue; }
            resolved.push(seg);
        }
        const base = resolved.join('/');

        // Try extensions in order
        const candidates = [
            base + '.ts', base + '.tsx',
            base + '.js', base + '.jsx',
            base + '/index.ts', base + '/index.js',
            base,
        ];

        for (const candidate of candidates) {
            if (this.symbolsByFile.has(candidate)) {
                return candidate;
            }
        }

        // Default guess
        return base + '.ts';
    }
}
