/**
 * CodeSearch — Fast local TF-IDF code search engine
 *
 * Zero external dependencies. Chunks code by function/class boundaries
 * from IndexEngine AST data, builds an inverted TF-IDF index, and
 * supports cosine-similarity search for natural language → code queries.
 *
 * Persistence: `.deepcode/search-index.json`
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { IndexEntry, SymbolInfo } from './indexEngine';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CodeChunk {
    /** Unique ID: filepath#symbolName or filepath#line */
    id: string;
    filepath: string;
    symbolName: string;
    kind: string;
    startLine: number;
    endLine: number;
    /** Lowercased, split, stemmed tokens */
    tokens: string[];
    /** Raw signature/preview (first ~200 chars) */
    preview: string;
}

export interface SearchResult {
    chunk: CodeChunk;
    score: number;
}

interface PersistData {
    version: number;
    fileHashes: Record<string, string>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const INDEX_FILE = '.deepcode/search-index.json';
const MIN_TOKEN_LENGTH = 2;
const MAX_RESULTS_DEFAULT = 10;

/** Common JS/TS keywords to down-weight (not remove — they still carry some signal) */
const STOP_WORDS = new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
    'do', 'switch', 'case', 'break', 'continue', 'new', 'this', 'class',
    'extends', 'implements', 'import', 'export', 'from', 'default', 'async',
    'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof',
    'void', 'null', 'undefined', 'true', 'false', 'in', 'of', 'type',
    'interface', 'enum', 'public', 'private', 'protected', 'static',
    'readonly', 'abstract', 'override', 'declare', 'module', 'namespace',
    'require', 'string', 'number', 'boolean', 'any', 'unknown', 'never',
    'object', 'symbol', 'bigint', 'promise',
]);

// ─── CodeSearch ──────────────────────────────────────────────────────────────

export class CodeSearch implements vscode.Disposable {
    private readonly workspaceRoot: string;
    private chunks: CodeChunk[] = [];
    /** Inverted index: token → Set of chunk indices */
    private invertedIndex = new Map<string, Set<number>>();
    /** IDF cache: token → idf value */
    private idfCache = new Map<string, number>();
    /** Track which files are indexed (by content hash) */
    private fileHashes = new Map<string, string>();
    private dirty = false;
    private saveTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────

    async initialize(): Promise<void> {
        await this.loadFromDisk();
    }

    dispose(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        if (this.dirty) {
            this.saveToDiskSync();
        }
    }

    // ─── Indexing ────────────────────────────────────────────────────────

    /**
     * Update the search index from an IndexEntry.
     * Called whenever IndexEngine re-indexes a file.
     */
    updateFromEntry(entry: IndexEntry): void {
        const relPath = path.relative(this.workspaceRoot, entry.filepath);

        // Skip if the file hasn't changed since last indexing
        if (this.fileHashes.get(relPath) === entry.contentHash) {
            return;
        }

        // Remove old chunks for this file
        this.removeFile(relPath);

        // Build new chunks from AST symbols
        const newChunks = this.buildChunks(entry, relPath);

        // Add to index
        for (const chunk of newChunks) {
            const idx = this.chunks.length;
            this.chunks.push(chunk);
            for (const token of chunk.tokens) {
                let set = this.invertedIndex.get(token);
                if (!set) {
                    set = new Set();
                    this.invertedIndex.set(token, set);
                }
                set.add(idx);
            }
        }

        this.fileHashes.set(relPath, entry.contentHash);
        this.dirty = true;
        this.idfCache.clear(); // Invalidate IDF cache
        this.scheduleSave();
    }

    /**
     * Bulk-load from cached entries (called on activation).
     */
    loadFromEntries(entries: IndexEntry[]): void {
        for (const entry of entries) {
            this.updateFromEntry(entry);
        }
    }

    // ─── Search ──────────────────────────────────────────────────────────

    /**
     * Search code chunks using TF-IDF cosine similarity.
     * Returns top-K results sorted by relevance.
     */
    search(query: string, topK = MAX_RESULTS_DEFAULT): SearchResult[] {
        if (this.chunks.length === 0) { return []; }

        const queryTokens = this.tokenize(query);
        if (queryTokens.length === 0) { return []; }

        // Build query TF vector
        const queryTF = new Map<string, number>();
        for (const t of queryTokens) {
            queryTF.set(t, (queryTF.get(t) || 0) + 1);
        }

        // Score each candidate chunk
        const scores: Array<{ idx: number; score: number }> = [];

        // Gather candidate chunk indices (union of inverted lists)
        const candidates = new Set<number>();
        for (const t of queryTokens) {
            const list = this.invertedIndex.get(t);
            if (list) {
                for (const idx of list) {
                    candidates.add(idx);
                }
            }
        }

        for (const idx of candidates) {
            const chunk = this.chunks[idx];
            const score = this.cosineSimilarity(queryTF, queryTokens, chunk);
            if (score > 0) {
                scores.push({ idx, score });
            }
        }

        // Sort descending by score and take top K
        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, topK).map(s => ({
            chunk: this.chunks[s.idx],
            score: Math.round(s.score * 1000) / 1000,
        }));
    }

    /** Get total chunk count */
    getChunkCount(): number {
        return this.chunks.length;
    }

    /** Get indexed file count */
    getFileCount(): number {
        return this.fileHashes.size;
    }

    // ─── TF-IDF Internals ────────────────────────────────────────────────

    private cosineSimilarity(
        queryTF: Map<string, number>,
        queryTokens: string[],
        chunk: CodeChunk
    ): number {
        // Build chunk TF
        const chunkTF = new Map<string, number>();
        for (const t of chunk.tokens) {
            chunkTF.set(t, (chunkTF.get(t) || 0) + 1);
        }

        let dotProduct = 0;
        let queryMag = 0;
        let chunkMag = 0;

        const allTokens = new Set([...queryTF.keys(), ...chunkTF.keys()]);

        for (const token of allTokens) {
            const qTF = queryTF.get(token) || 0;
            const cTF = chunkTF.get(token) || 0;
            const idf = this.getIDF(token);

            const qWeight = qTF * idf;
            const cWeight = cTF * idf;

            dotProduct += qWeight * cWeight;
            queryMag += qWeight * qWeight;
            chunkMag += cWeight * cWeight;
        }

        if (queryMag === 0 || chunkMag === 0) { return 0; }
        return dotProduct / (Math.sqrt(queryMag) * Math.sqrt(chunkMag));
    }

    private getIDF(token: string): number {
        let idf = this.idfCache.get(token);
        if (idf !== undefined) { return idf; }

        const N = this.chunks.length;
        const df = this.invertedIndex.get(token)?.size || 0;

        // Standard IDF with smoothing
        idf = df > 0 ? Math.log((N + 1) / (df + 1)) + 1 : 0;

        // Down-weight stop words
        if (STOP_WORDS.has(token)) {
            idf *= 0.3;
        }

        this.idfCache.set(token, idf);
        return idf;
    }

    // ─── Chunking ────────────────────────────────────────────────────────

    private buildChunks(entry: IndexEntry, relPath: string): CodeChunk[] {
        const chunks: CodeChunk[] = [];

        for (const sym of entry.symbols) {
            const chunk = this.symbolToChunk(sym, relPath);
            chunks.push(chunk);

            // Also index methods of classes
            if (sym.methods) {
                for (const method of sym.methods) {
                    chunks.push(this.symbolToChunk(method, relPath, sym.name));
                }
            }
        }

        // If a file has no symbols (e.g., a config file), index the whole skeleton
        if (chunks.length === 0 && entry.skeleton) {
            chunks.push({
                id: `${relPath}#file`,
                filepath: relPath,
                symbolName: path.basename(relPath, path.extname(relPath)),
                kind: 'file',
                startLine: 1,
                endLine: entry.skeleton.split('\n').length,
                tokens: this.tokenize(entry.skeleton),
                preview: entry.skeleton.substring(0, 200),
            });
        }

        return chunks;
    }

    private symbolToChunk(
        sym: SymbolInfo,
        relPath: string,
        parentName?: string
    ): CodeChunk {
        const fullName = parentName ? `${parentName}.${sym.name}` : sym.name;
        const id = `${relPath}#${fullName}`;

        // Build searchable text from the symbol
        const parts: string[] = [
            sym.name,
            sym.kind,
            ...sym.params.map(p => `${p.name} ${p.type}`),
            sym.returnType,
        ];
        if (parentName) { parts.push(parentName); }
        // Add the filepath components as tokens too
        parts.push(...relPath.split(/[/\\.]/).filter(Boolean));

        const text = parts.join(' ');
        const tokens = this.tokenize(text);

        // Build preview
        const paramStr = sym.params.map(p => p.type ? `${p.name}: ${p.type}` : p.name).join(', ');
        const ret = sym.returnType ? `: ${sym.returnType}` : '';
        const prefix = sym.isAsync ? 'async ' : '';
        const exp = sym.isExported ? 'export ' : '';
        const preview = `${exp}${prefix}${sym.kind} ${fullName}(${paramStr})${ret}`;

        return {
            id,
            filepath: relPath,
            symbolName: fullName,
            kind: sym.kind,
            startLine: sym.line,
            endLine: sym.endLine,
            tokens,
            preview: preview.substring(0, 200),
        };
    }

    // ─── Tokenization ────────────────────────────────────────────────────

    /**
     * Code-aware tokenizer:
     * - Splits camelCase: getSymbolGraph → [get, symbol, graph]
     * - Splits snake_case: dirty_tracker → [dirty, tracker]
     * - Splits on non-alphanumeric chars
     * - Lowercases everything
     * - Filters short tokens
     */
    tokenize(text: string): string[] {
        if (!text) { return []; }

        // Split camelCase/PascalCase
        const expanded = text.replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

        // Split on non-alphanumeric
        const raw = expanded.toLowerCase().split(/[^a-z0-9]+/);

        // Filter and deduplicate while preserving order
        const seen = new Set<string>();
        const tokens: string[] = [];

        for (const t of raw) {
            if (t.length >= MIN_TOKEN_LENGTH && !seen.has(t)) {
                seen.add(t);
                tokens.push(t);
            }
        }

        return tokens;
    }

    // ─── Index Management ────────────────────────────────────────────────

    private removeFile(relPath: string): void {
        // Find all chunks for this file
        const toRemove = new Set<number>();
        for (let i = 0; i < this.chunks.length; i++) {
            if (this.chunks[i].filepath === relPath) {
                toRemove.add(i);
            }
        }

        if (toRemove.size === 0) { return; }

        // Remove from inverted index
        for (const [token, indices] of this.invertedIndex) {
            for (const idx of toRemove) {
                indices.delete(idx);
            }
            if (indices.size === 0) {
                this.invertedIndex.delete(token);
            }
        }

        // Compact chunks array and rebuild index references
        const newChunks: CodeChunk[] = [];
        const oldToNew = new Map<number, number>();

        for (let i = 0; i < this.chunks.length; i++) {
            if (!toRemove.has(i)) {
                oldToNew.set(i, newChunks.length);
                newChunks.push(this.chunks[i]);
            }
        }

        // Remap inverted index
        const newInverted = new Map<string, Set<number>>();
        for (const [token, indices] of this.invertedIndex) {
            const newSet = new Set<number>();
            for (const oldIdx of indices) {
                const newIdx = oldToNew.get(oldIdx);
                if (newIdx !== undefined) {
                    newSet.add(newIdx);
                }
            }
            if (newSet.size > 0) {
                newInverted.set(token, newSet);
            }
        }

        this.chunks = newChunks;
        this.invertedIndex = newInverted;
        this.idfCache.clear();
        this.fileHashes.delete(relPath);
    }

    // ─── Persistence ─────────────────────────────────────────────────────

    private getIndexPath(): string {
        return path.join(this.workspaceRoot, INDEX_FILE);
    }

    private async loadFromDisk(): Promise<void> {
        try {
            const filePath = this.getIndexPath();
            if (!fs.existsSync(filePath)) { return; }
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data: PersistData = JSON.parse(raw);
            if (data.version !== 1) { return; }
            this.fileHashes = new Map(Object.entries(data.fileHashes || {}));
        } catch {
            // Corrupt index — will rebuild naturally
        }
    }

    private scheduleSave(): void {
        if (this.saveTimer) { clearTimeout(this.saveTimer); }
        this.saveTimer = setTimeout(() => this.saveToDiskAsync(), 3000);
    }

    private async saveToDiskAsync(): Promise<void> {
        try {
            this.saveToDiskSync();
        } catch {
            // Best effort
        }
    }

    private saveToDiskSync(): void {
        const filePath = this.getIndexPath();
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const data: PersistData = {
            version: 1,
            fileHashes: Object.fromEntries(this.fileHashes),
        };

        fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
        this.dirty = false;
    }
}
