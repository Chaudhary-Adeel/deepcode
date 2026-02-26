/**
 * Index Engine for DeepCode
 *
 * Parses TypeScript/JavaScript files using web-tree-sitter (WASM) to extract
 * symbols, exports, imports, and generate file skeletons. Operates lazily:
 * getEntry() only re-parses when the file is dirty AND its content hash changed.
 *
 * Persistence: `.deepcode/symbols.json`
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import type { DirtyTracker } from './dirtyTracker';

// web-tree-sitter is loaded dynamically to handle WASM init
type TreeSitterModule = typeof import('web-tree-sitter');
type Parser = import('web-tree-sitter').Parser;
type SyntaxNode = import('web-tree-sitter').Node;
type Language = import('web-tree-sitter').Language;

// ─── Types ───────────────────────────────────────────────────────────────────

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'method';

export interface SymbolParam {
    name: string;
    type: string;
}

export interface SymbolInfo {
    name: string;
    kind: SymbolKind;
    line: number;
    endLine: number;
    params: SymbolParam[];
    returnType: string;
    isExported: boolean;
    isAsync: boolean;
    isStatic: boolean;
    methods?: SymbolInfo[];
    /** Names of functions/methods called within this symbol's body */
    calls?: string[];
}

export interface ImportInfo {
    source: string;
    specifiers: string[];
    isTypeOnly: boolean;
    line: number;
}

export interface ExportInfo {
    name: string;
    kind: SymbolKind | 'reexport' | 'default';
    line: number;
}

export interface IndexEntry {
    filepath: string;
    contentHash: string;
    lastIndexed: number;
    symbols: SymbolInfo[];
    exports: ExportInfo[];
    imports: ImportInfo[];
    skeleton: string;
}

interface SymbolsFile {
    version: number;
    entries: Record<string, IndexEntry>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEEPCODE_DIR = '.deepcode';
const SYMBOLS_FILE = '.deepcode/symbols.json';
const SAVE_DEBOUNCE_MS = 2000;

const INDEXABLE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
]);

const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/__pycache__/**,**/.deepcode/**}';

// ─── IndexEngine ─────────────────────────────────────────────────────────────

export class IndexEngine implements vscode.Disposable {

    private readonly workspaceRoot: string;
    private readonly extensionPath: string;
    private readonly dirtyTracker: DirtyTracker;
    private readonly cache = new Map<string, IndexEntry>();

    // Tree-sitter instances
    private ParserClass: TreeSitterModule | null = null;
    private parser: Parser | null = null;
    private tsLanguage: Language | null = null;
    private tsxLanguage: Language | null = null;
    private jsLanguage: Language | null = null;
    private initialized = false;
    private initPromise: Promise<void> | null = null;

    // Reverse dependency map: filepath -> Set of files that import from it
    private importersMap = new Map<string, Set<string>>();

    // Persistence
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    // Events
    private readonly _onDidProgress = new vscode.EventEmitter<{ indexed: number; total: number }>();
    public readonly onDidProgress = this._onDidProgress.event;

    private readonly _onDidComplete = new vscode.EventEmitter<void>();
    /** Fires when background indexing finishes */
    public readonly onDidComplete = this._onDidComplete.event;

    private readonly _onDidIndex = new vscode.EventEmitter<IndexEntry>();
    public readonly onDidIndex = this._onDidIndex.event;

    constructor(workspaceRoot: string, extensionPath: string, dirtyTracker: DirtyTracker) {
        this.workspaceRoot = workspaceRoot;
        this.extensionPath = extensionPath;
        this.dirtyTracker = dirtyTracker;
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────

    async initialize(): Promise<void> {
        await this.ensureInitialized();
        await this.loadCache();
        this.rebuildImportersMap();
        // Background index dirty files (non-blocking)
        this.backgroundIndex().catch(() => {});
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initialized) { return; }
        if (this.initPromise) { return this.initPromise; }

        this.initPromise = this.doInit();
        await this.initPromise;
    }

    private async doInit(): Promise<void> {
        try {
            const TreeSitter = require('web-tree-sitter') as TreeSitterModule;
            this.ParserClass = TreeSitter;

            const parsersDir = path.join(this.extensionPath, 'parsers');

            await (TreeSitter as any).init({
                locateFile: (_scriptName: string) => path.join(parsersDir, 'tree-sitter.wasm'),
            });

            this.parser = new (TreeSitter as any)() as Parser;

            // Load language grammars
            const [tsLang, tsxLang, jsLang] = await Promise.all([
                TreeSitter.Language.load(path.join(parsersDir, 'tree-sitter-typescript.wasm')),
                TreeSitter.Language.load(path.join(parsersDir, 'tree-sitter-tsx.wasm')),
                TreeSitter.Language.load(path.join(parsersDir, 'tree-sitter-javascript.wasm')),
            ]);

            this.tsLanguage = tsLang;
            this.tsxLanguage = tsxLang;
            this.jsLanguage = jsLang;
            this.initialized = true;
        } catch (err) {
            console.error('DeepCode: Failed to initialize tree-sitter:', err);
            // Degrade gracefully — getEntry() will return undefined
        }
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;

        this._onDidProgress.dispose();
        this._onDidComplete.dispose();
        this._onDidIndex.dispose();

        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }

        if (this.parser) {
            this.parser.delete();
            this.parser = null;
        }

        this.saveCache().catch(() => {});
    }

    // ─── Public API ──────────────────────────────────────────────────────

    async getEntry(filepath: string): Promise<IndexEntry | undefined> {
        await this.ensureInitialized();
        if (!this.parser || !this.initialized) { return undefined; }

        const rel = this.normalize(filepath);
        if (!this.isIndexable(rel)) { return undefined; }

        // Step 1: Not dirty + in cache → return cached
        if (!this.dirtyTracker.isDirty(rel)) {
            const cached = this.cache.get(rel);
            if (cached) { return cached; }
        }

        // Step 2: Read file
        let content: Buffer;
        try {
            const uri = vscode.Uri.file(this.toAbsolute(rel));
            content = Buffer.from(await vscode.workspace.fs.readFile(uri));
        } catch {
            return undefined;
        }

        // Step 3: Hash check — if content unchanged, skip re-parse
        const hash = this.hashContent(content);
        const existing = this.cache.get(rel);
        if (existing && existing.contentHash === hash) {
            existing.lastIndexed = Date.now();
            this.dirtyTracker.markClean(rel);
            this.scheduleSave();
            return existing;
        }

        // Step 4: Parse with tree-sitter
        const language = this.getLanguageForFile(rel);
        if (!language) { return undefined; }

        const sourceCode = content.toString('utf-8');
        const oldExports = existing?.exports ?? [];
        const parsed = this.parseFile(rel, sourceCode, language);

        // Step 5: Build entry
        const entry: IndexEntry = {
            filepath: rel,
            contentHash: hash,
            lastIndexed: Date.now(),
            ...parsed,
        };

        // Step 6: Update cache + importers
        this.cache.set(rel, entry);
        this.updateImportersForFile(rel, parsed.imports);

        // Step 7: Mark clean
        this.dirtyTracker.markClean(rel);

        // Step 8: Dependency propagation
        this.propagateDependencyDirtiness(rel, oldExports, parsed.exports);

        // Step 9: Persist + notify
        this.scheduleSave();
        this._onDidIndex.fire(entry);

        return entry;
    }

    async getEntries(filepaths: string[]): Promise<Map<string, IndexEntry>> {
        const result = new Map<string, IndexEntry>();
        for (const fp of filepaths) {
            const entry = await this.getEntry(fp);
            if (entry) { result.set(entry.filepath, entry); }
        }
        return result;
    }

    async getSkeleton(filepath: string): Promise<string | undefined> {
        const entry = await this.getEntry(filepath);
        return entry?.skeleton;
    }

    getAllCached(): Map<string, IndexEntry> {
        return new Map(this.cache);
    }

    async reindex(filepath: string): Promise<IndexEntry | undefined> {
        const rel = this.normalize(filepath);
        this.dirtyTracker.markDependencyDirty(rel);
        return this.getEntry(rel);
    }

    async rebuildAll(token?: vscode.CancellationToken): Promise<void> {
        this.cache.clear();
        this.importersMap.clear();
        await this.ensureInitialized();

        try {
            const files = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB);
            for (const uri of files) {
                const rel = path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, '/');
                if (!this.isIndexable(rel)) { continue; }
                this.dirtyTracker.markDependencyDirty(rel);
            }
        } catch {
            // Fall back to currently dirty set only
        }

        await this.backgroundIndex(token);
    }

    getImporters(filepath: string): string[] {
        const rel = this.normalize(filepath);
        const importers = this.importersMap.get(rel);
        return importers ? Array.from(importers) : [];
    }

    // ─── Private: Parsing ────────────────────────────────────────────────

    private getLanguageForFile(filepath: string): Language | null {
        const ext = path.extname(filepath).toLowerCase();
        switch (ext) {
            case '.ts': case '.mts': case '.cts':
                return this.tsLanguage;
            case '.tsx':
                return this.tsxLanguage;
            case '.js': case '.jsx': case '.mjs': case '.cjs':
                return this.jsLanguage;
            default:
                return null;
        }
    }

    private parseFile(filepath: string, sourceCode: string, language: Language): {
        symbols: SymbolInfo[];
        exports: ExportInfo[];
        imports: ImportInfo[];
        skeleton: string;
    } {
        this.parser!.setLanguage(language);
        const tree = this.parser!.parse(sourceCode);
        if (!tree) {
            return { symbols: [], exports: [], imports: [], skeleton: '' };
        }

        try {
            const rootNode = tree.rootNode;
            const symbols = this.extractSymbols(rootNode, sourceCode);
            const imports = this.extractImports(rootNode);
            const exports = this.extractExports(rootNode, symbols);
            const skeleton = this.generateSkeleton(rootNode, sourceCode);

            return { symbols, exports, imports, skeleton };
        } finally {
            tree.delete();
        }
    }

    // ─── Symbol Extraction ───────────────────────────────────────────────

    private extractSymbols(rootNode: SyntaxNode, _sourceCode: string): SymbolInfo[] {
        const symbols: SymbolInfo[] = [];

        for (const child of rootNode.children) {
            const extracted = this.extractSymbolFromNode(child);
            if (extracted) {
                symbols.push(...extracted);
            }
        }

        return symbols;
    }

    private extractSymbolFromNode(node: SyntaxNode): SymbolInfo[] | null {
        switch (node.type) {
            case 'function_declaration':
            case 'generator_function_declaration':
                return [this.extractFunction(node, false)];

            case 'class_declaration':
            case 'abstract_class_declaration':
                return [this.extractClass(node, false)];

            case 'interface_declaration':
                return [this.extractInterface(node, false)];

            case 'type_alias_declaration':
                return [this.extractTypeAlias(node, false)];

            case 'enum_declaration':
                return [this.extractEnum(node, false)];

            case 'lexical_declaration':
            case 'variable_declaration':
                return this.extractVariableDeclaration(node, false);

            case 'export_statement':
                return this.extractFromExportStatement(node);

            default:
                return null;
        }
    }

    private extractFunction(node: SyntaxNode, isExported: boolean): SymbolInfo {
        const nameNode = node.childForFieldName('name');
        const params = this.extractParams(node.childForFieldName('parameters'));
        const returnType = this.extractReturnType(node);
        const isAsync = node.children.some(c => c.type === 'async');
        const body = node.childForFieldName('body');
        const calls = body ? this.extractCallExpressions(body) : [];

        return {
            name: nameNode?.text || '<anonymous>',
            kind: 'function',
            line: node.startPosition.row,
            endLine: node.endPosition.row,
            params,
            returnType,
            isExported,
            isAsync,
            isStatic: false,
            calls,
        };
    }

    private extractClass(node: SyntaxNode, isExported: boolean): SymbolInfo {
        const nameNode = node.childForFieldName('name');
        const bodyNode = node.childForFieldName('body');
        const methods: SymbolInfo[] = [];

        if (bodyNode) {
            for (const member of bodyNode.namedChildren) {
                if (member.type === 'method_definition') {
                    methods.push(this.extractMethod(member));
                } else if (member.type === 'abstract_method_signature') {
                    methods.push(this.extractMethodSignature(member));
                }
            }
        }

        return {
            name: nameNode?.text || '<anonymous>',
            kind: 'class',
            line: node.startPosition.row,
            endLine: node.endPosition.row,
            params: [],
            returnType: '',
            isExported,
            isAsync: false,
            isStatic: false,
            methods,
        };
    }

    private extractInterface(node: SyntaxNode, isExported: boolean): SymbolInfo {
        const nameNode = node.childForFieldName('name');
        const bodyNode = node.childForFieldName('body');
        const methods: SymbolInfo[] = [];

        if (bodyNode) {
            for (const member of bodyNode.namedChildren) {
                if (member.type === 'method_signature') {
                    methods.push(this.extractMethodSignature(member));
                } else if (member.type === 'property_signature') {
                    const propName = member.childForFieldName('name');
                    const typeNode = member.childForFieldName('type');
                    methods.push({
                        name: propName?.text || '',
                        kind: 'variable',
                        line: member.startPosition.row,
                        endLine: member.endPosition.row,
                        params: [],
                        returnType: typeNode?.text || '',
                        isExported: false,
                        isAsync: false,
                        isStatic: false,
                    });
                }
            }
        }

        return {
            name: nameNode?.text || '<anonymous>',
            kind: 'interface',
            line: node.startPosition.row,
            endLine: node.endPosition.row,
            params: [],
            returnType: '',
            isExported,
            isAsync: false,
            isStatic: false,
            methods,
        };
    }

    private extractTypeAlias(node: SyntaxNode, isExported: boolean): SymbolInfo {
        const nameNode = node.childForFieldName('name');
        return {
            name: nameNode?.text || '<anonymous>',
            kind: 'type',
            line: node.startPosition.row,
            endLine: node.endPosition.row,
            params: [],
            returnType: '',
            isExported,
            isAsync: false,
            isStatic: false,
        };
    }

    private extractEnum(node: SyntaxNode, isExported: boolean): SymbolInfo {
        const nameNode = node.childForFieldName('name');
        return {
            name: nameNode?.text || '<anonymous>',
            kind: 'enum',
            line: node.startPosition.row,
            endLine: node.endPosition.row,
            params: [],
            returnType: '',
            isExported,
            isAsync: false,
            isStatic: false,
        };
    }

    private extractVariableDeclaration(node: SyntaxNode, isExported: boolean): SymbolInfo[] {
        const results: SymbolInfo[] = [];

        for (const child of node.namedChildren) {
            if (child.type !== 'variable_declarator') { continue; }
            const nameNode = child.childForFieldName('name');
            const valueNode = child.childForFieldName('value');

            if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression' || valueNode.type === 'function')) {
                const params = this.extractParams(valueNode.childForFieldName('parameters'));
                const returnType = this.extractReturnType(valueNode);
                const isAsync = valueNode.children.some(c => c.type === 'async');
                const body = valueNode.childForFieldName('body');
                const calls = body ? this.extractCallExpressions(body) : [];
                results.push({
                    name: nameNode?.text || '<anonymous>',
                    kind: 'function',
                    line: node.startPosition.row,
                    endLine: node.endPosition.row,
                    params,
                    returnType,
                    isExported,
                    isAsync,
                    isStatic: false,
                    calls,
                });
            } else {
                const typeNode = child.childForFieldName('type');
                results.push({
                    name: nameNode?.text || '<anonymous>',
                    kind: 'variable',
                    line: node.startPosition.row,
                    endLine: node.endPosition.row,
                    params: [],
                    returnType: typeNode?.text || '',
                    isExported,
                    isAsync: false,
                    isStatic: false,
                });
            }
        }

        return results;
    }

    private extractFromExportStatement(node: SyntaxNode): SymbolInfo[] | null {
        const declaration = node.childForFieldName('declaration');
        if (declaration) {
            const symbols = this.extractSymbolFromNode(declaration);
            if (symbols) {
                for (const sym of symbols) { sym.isExported = true; }
                return symbols;
            }
        }

        // export default expression
        const valueNode = node.childForFieldName('value');
        if (valueNode && node.children.some(c => c.text === 'default')) {
            return [{
                name: 'default',
                kind: 'variable',
                line: node.startPosition.row,
                endLine: node.endPosition.row,
                params: [],
                returnType: '',
                isExported: true,
                isAsync: false,
                isStatic: false,
            }];
        }

        return null;
    }

    private extractMethod(node: SyntaxNode): SymbolInfo {
        const nameNode = node.childForFieldName('name');
        const params = this.extractParams(node.childForFieldName('parameters'));
        const returnType = this.extractReturnType(node);
        const isAsync = node.children.some(c => c.type === 'async');
        const isStatic = node.children.some(c => c.text === 'static');
        const body = node.childForFieldName('body');
        const calls = body ? this.extractCallExpressions(body) : [];

        return {
            name: nameNode?.text || '<anonymous>',
            kind: 'method',
            line: node.startPosition.row,
            endLine: node.endPosition.row,
            params,
            returnType,
            isExported: false,
            isAsync,
            isStatic,
            calls,
        };
    }

    private extractMethodSignature(node: SyntaxNode): SymbolInfo {
        const nameNode = node.childForFieldName('name');
        const params = this.extractParams(node.childForFieldName('parameters'));
        const returnType = this.extractReturnType(node);

        return {
            name: nameNode?.text || '<anonymous>',
            kind: 'method',
            line: node.startPosition.row,
            endLine: node.endPosition.row,
            params,
            returnType,
            isExported: false,
            isAsync: false,
            isStatic: false,
        };
    }

    private extractParams(paramsNode: SyntaxNode | null): SymbolParam[] {
        if (!paramsNode) { return []; }
        const params: SymbolParam[] = [];

        for (const child of paramsNode.namedChildren) {
            if (child.type === 'required_parameter' || child.type === 'optional_parameter') {
                const patternNode = child.childForFieldName('pattern');
                const typeNode = child.childForFieldName('type');
                params.push({
                    name: patternNode?.text || child.text,
                    type: typeNode?.text || '',
                });
            } else if (child.type === 'rest_pattern') {
                params.push({ name: child.text, type: '' });
            } else if (child.type === 'identifier') {
                // JS parameter (untyped)
                params.push({ name: child.text, type: '' });
            }
        }

        return params;
    }

    private extractReturnType(node: SyntaxNode): string {
        const returnTypeNode = node.childForFieldName('return_type');
        if (returnTypeNode) {
            // Strip leading ': ' from type annotation
            const text = returnTypeNode.text;
            return text.startsWith(':') ? text.slice(1).trim() : text;
        }
        return '';
    }

    // ─── Call Expression Extraction ──────────────────────────────────────

    /**
     * Walk a function/method body and collect all call_expression callee names.
     * Handles: plain calls `foo()`, method calls `this.bar()`, member calls `obj.baz()`.
     */
    private extractCallExpressions(bodyNode: SyntaxNode): string[] {
        const calls = new Set<string>();
        this.walkForCalls(bodyNode, calls);
        return Array.from(calls);
    }

    private walkForCalls(node: SyntaxNode, calls: Set<string>): void {
        if (node.type === 'call_expression') {
            const funcNode = node.childForFieldName('function');
            if (funcNode) {
                const callee = this.extractCalleeName(funcNode);
                if (callee) {
                    calls.add(callee);
                }
            }
        }

        for (const child of node.children) {
            this.walkForCalls(child, calls);
        }
    }

    /**
     * Extract a human-readable callee name from the function position of a call_expression.
     * - `foo` → "foo"
     * - `this.bar` → "bar"
     * - `obj.baz` → "baz"
     * - `a.b.c` → "c" (last member)
     * - `new Foo()` → "Foo"
     */
    private extractCalleeName(node: SyntaxNode): string | null {
        switch (node.type) {
            case 'identifier':
                return node.text;

            case 'member_expression': {
                const property = node.childForFieldName('property');
                return property?.text || null;
            }

            case 'new_expression': {
                const constructor = node.childForFieldName('constructor');
                return constructor?.text || null;
            }

            default:
                return null;
        }
    }

    // ─── Import Extraction ───────────────────────────────────────────────

    private extractImports(rootNode: SyntaxNode): ImportInfo[] {
        const imports: ImportInfo[] = [];

        for (const child of rootNode.children) {
            if (child.type !== 'import_statement') { continue; }

            const sourceNode = child.childForFieldName('source');
            if (!sourceNode) { continue; }

            const source = sourceNode.text.replace(/['"]/g, '');
            const specifiers: string[] = [];
            const isTypeOnly = child.children.some(c => c.text === 'type' && c.startPosition.column < (sourceNode.startPosition.column));

            const importClause = child.children.find(c =>
                c.type === 'import_clause' || c.type === 'named_imports' || c.type === 'namespace_import'
            );

            if (importClause) {
                this.collectImportSpecifiers(importClause, specifiers);
            }

            // Also check direct children for default/namespace imports
            if (specifiers.length === 0) {
                for (const c of child.namedChildren) {
                    if (c.type === 'identifier' && c !== sourceNode) {
                        specifiers.push(c.text);
                    } else if (c.type === 'namespace_import') {
                        specifiers.push('*');
                    } else if (c.type === 'named_imports') {
                        this.collectImportSpecifiers(c, specifiers);
                    } else if (c.type === 'import_clause') {
                        this.collectImportSpecifiers(c, specifiers);
                    }
                }
            }

            imports.push({
                source,
                specifiers: specifiers.length > 0 ? specifiers : ['*'],
                isTypeOnly,
                line: child.startPosition.row,
            });
        }

        return imports;
    }

    private collectImportSpecifiers(node: SyntaxNode, specifiers: string[]): void {
        for (const child of node.namedChildren) {
            if (child.type === 'identifier') {
                specifiers.push(child.text);
            } else if (child.type === 'import_specifier') {
                const nameNode = child.childForFieldName('name') || child.childForFieldName('alias');
                if (nameNode) { specifiers.push(nameNode.text); }
                else { specifiers.push(child.text); }
            } else if (child.type === 'namespace_import') {
                specifiers.push('*');
            } else if (child.type === 'named_imports') {
                this.collectImportSpecifiers(child, specifiers);
            }
        }
    }

    // ─── Export Extraction ───────────────────────────────────────────────

    private extractExports(rootNode: SyntaxNode, symbols: SymbolInfo[]): ExportInfo[] {
        const exports: ExportInfo[] = [];

        // Exports from symbols marked as exported
        for (const sym of symbols) {
            if (sym.isExported) {
                exports.push({
                    name: sym.name,
                    kind: sym.name === 'default' ? 'default' : sym.kind,
                    line: sym.line,
                });
            }
        }

        // Re-exports: export { X } from './foo'
        for (const child of rootNode.children) {
            if (child.type !== 'export_statement') { continue; }
            const sourceNode = child.childForFieldName('source');
            if (!sourceNode) { continue; } // Only re-exports have source

            // Already handled if it has a declaration
            if (child.childForFieldName('declaration')) { continue; }

            for (const specChild of child.namedChildren) {
                if (specChild.type === 'export_clause') {
                    for (const spec of specChild.namedChildren) {
                        if (spec.type === 'export_specifier') {
                            const nameNode = spec.childForFieldName('name');
                            exports.push({
                                name: nameNode?.text || spec.text,
                                kind: 'reexport',
                                line: child.startPosition.row,
                            });
                        }
                    }
                }
            }
        }

        return exports;
    }

    // ─── Skeleton Generation ─────────────────────────────────────────────

    private generateSkeleton(rootNode: SyntaxNode, sourceCode: string): string {
        const lines = sourceCode.split('\n');
        const bodyRanges: Array<{ start: number; end: number }> = [];

        this.collectBodyRanges(rootNode, bodyRanges);

        // Sort by start line, merge overlapping
        bodyRanges.sort((a, b) => a.start - b.start);
        const merged: typeof bodyRanges = [];
        for (const range of bodyRanges) {
            const last = merged[merged.length - 1];
            if (last && range.start <= last.end + 1) {
                last.end = Math.max(last.end, range.end);
            } else {
                merged.push({ ...range });
            }
        }

        // Build skeleton: copy lines, replacing body ranges
        const output: string[] = [];
        let currentLine = 0;

        for (const range of merged) {
            // Copy lines before this body range
            for (let i = currentLine; i < range.start && i < lines.length; i++) {
                output.push(lines[i]);
            }

            // Add the signature line with collapsed body
            if (range.start < lines.length) {
                const sigLine = lines[range.start];
                const braceIdx = sigLine.indexOf('{');
                if (braceIdx >= 0) {
                    output.push(sigLine.substring(0, braceIdx) + '{ ... }');
                } else {
                    output.push(sigLine + ' { ... }');
                }
            }

            currentLine = range.end + 1;
        }

        // Copy remaining lines
        for (let i = currentLine; i < lines.length; i++) {
            output.push(lines[i]);
        }

        return output.join('\n');
    }

    private collectBodyRanges(node: SyntaxNode, ranges: Array<{ start: number; end: number }>): void {
        for (const child of node.children) {
            this.collectBodyRangesFromNode(child, ranges);
        }
    }

    private collectBodyRangesFromNode(node: SyntaxNode, ranges: Array<{ start: number; end: number }>): void {
        const bodyBearingTypes = new Set([
            'function_declaration', 'generator_function_declaration',
            'method_definition',
        ]);

        if (bodyBearingTypes.has(node.type)) {
            const body = node.childForFieldName('body');
            if (body && body.type === 'statement_block' && body.endPosition.row > body.startPosition.row) {
                ranges.push({ start: body.startPosition.row, end: body.endPosition.row });
            }
            return;
        }

        if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') {
            const classBody = node.childForFieldName('body');
            if (classBody) {
                for (const member of classBody.namedChildren) {
                    if (member.type === 'method_definition') {
                        const body = member.childForFieldName('body');
                        if (body && body.type === 'statement_block' && body.endPosition.row > body.startPosition.row) {
                            ranges.push({ start: body.startPosition.row, end: body.endPosition.row });
                        }
                    }
                }
            }
            return;
        }

        if (node.type === 'export_statement') {
            const decl = node.childForFieldName('declaration');
            if (decl) {
                this.collectBodyRangesFromNode(decl, ranges);
            }
            return;
        }

        if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
            for (const declarator of node.namedChildren) {
                if (declarator.type === 'variable_declarator') {
                    const value = declarator.childForFieldName('value');
                    if (value && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'function')) {
                        const body = value.childForFieldName('body');
                        if (body && body.type === 'statement_block' && body.endPosition.row > body.startPosition.row) {
                            ranges.push({ start: body.startPosition.row, end: body.endPosition.row });
                        }
                    }
                }
            }
            return;
        }
    }

    // ─── Dependency Propagation ──────────────────────────────────────────

    private rebuildImportersMap(): void {
        this.importersMap.clear();
        for (const [filepath, entry] of this.cache) {
            this.updateImportersForFile(filepath, entry.imports);
        }
    }

    private updateImportersForFile(filepath: string, imports: ImportInfo[]): void {
        // Remove old entries for this file
        for (const [, importers] of this.importersMap) {
            importers.delete(filepath);
        }

        // Add new entries
        for (const imp of imports) {
            const resolved = this.resolveImportPath(filepath, imp.source);
            if (!resolved) { continue; }

            let importers = this.importersMap.get(resolved);
            if (!importers) {
                importers = new Set();
                this.importersMap.set(resolved, importers);
            }
            importers.add(filepath);
        }
    }

    private propagateDependencyDirtiness(
        filepath: string,
        oldExports: ExportInfo[],
        newExports: ExportInfo[],
    ): void {
        const oldSet = new Set(oldExports.map(e => `${e.name}:${e.kind}`));
        const newSet = new Set(newExports.map(e => `${e.name}:${e.kind}`));

        const changed = oldSet.size !== newSet.size ||
            [...oldSet].some(x => !newSet.has(x)) ||
            [...newSet].some(x => !oldSet.has(x));

        if (!changed) { return; }

        const importers = this.importersMap.get(filepath);
        if (importers) {
            for (const importer of importers) {
                this.dirtyTracker.markDependencyDirty(importer);
            }
        }
    }

    private resolveImportPath(fromFile: string, importSource: string): string | null {
        // Only resolve relative imports
        if (!importSource.startsWith('.')) { return null; }

        const fromDir = path.dirname(path.join(this.workspaceRoot, fromFile));
        const resolved = path.resolve(fromDir, importSource);
        const relative = path.relative(this.workspaceRoot, resolved).replace(/\\/g, '/');

        // Try extensions
        const candidates = [
            relative + '.ts', relative + '.tsx',
            relative + '.js', relative + '.jsx',
            relative + '/index.ts', relative + '/index.js',
            relative,
        ];

        for (const candidate of candidates) {
            if (this.cache.has(candidate)) {
                return candidate;
            }
        }

        // Best guess: .ts extension
        return relative + '.ts';
    }

    // ─── Background Index ────────────────────────────────────────────────

    private async backgroundIndex(token?: vscode.CancellationToken): Promise<void> {
        const dirty = this.dirtyTracker.getDirty().filter(fp => this.isIndexable(fp));
        if (dirty.length === 0) {
            this._onDidComplete.fire();
            return;
        }

        const total = dirty.length;
        let indexed = 0;
        const BATCH_SIZE = 10;

        for (let i = 0; i < dirty.length; i += BATCH_SIZE) {
            if (token?.isCancellationRequested || this.disposed) { break; }

            const batch = dirty.slice(i, i + BATCH_SIZE);
            for (const filepath of batch) {
                try {
                    await this.getEntry(filepath);
                } catch { /* skip */ }
                indexed++;
                this._onDidProgress.fire({ indexed, total });
            }

            // Yield to event loop
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Signal completion so status bar can update
        this._onDidComplete.fire();
    }

    // ─── Persistence ─────────────────────────────────────────────────────

    private async loadCache(): Promise<void> {
        try {
            const metaPath = path.join(this.workspaceRoot, SYMBOLS_FILE);
            const uri = vscode.Uri.file(metaPath);
            const data = await vscode.workspace.fs.readFile(uri);
            const parsed = JSON.parse(Buffer.from(data).toString('utf-8')) as SymbolsFile;

            if (parsed && parsed.version === 1 && parsed.entries) {
                for (const [key, entry] of Object.entries(parsed.entries)) {
                    this.cache.set(key, entry);
                }
            }
        } catch {
            // File missing or corrupt — start fresh
        }
    }

    private scheduleSave(): void {
        if (this.disposed) { return; }
        if (this.saveTimer) { clearTimeout(this.saveTimer); }
        this.saveTimer = setTimeout(() => {
            this.saveCache().catch(() => {});
        }, SAVE_DEBOUNCE_MS);
    }

    private async saveCache(): Promise<void> {
        if (!this.workspaceRoot) { return; }

        const dirUri = vscode.Uri.file(path.join(this.workspaceRoot, DEEPCODE_DIR));
        try { await vscode.workspace.fs.stat(dirUri); }
        catch { await vscode.workspace.fs.createDirectory(dirUri); }

        const symbolsFile: SymbolsFile = {
            version: 1,
            entries: Object.fromEntries(this.cache),
        };

        const uri = vscode.Uri.file(path.join(this.workspaceRoot, SYMBOLS_FILE));
        const json = JSON.stringify(symbolsFile, null, 2);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf-8'));
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    private hashContent(data: Buffer): string {
        return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
    }

    private isIndexable(filepath: string): boolean {
        const ext = path.extname(filepath).toLowerCase();
        return INDEXABLE_EXTENSIONS.has(ext);
    }

    private normalize(filepath: string): string {
        if (path.isAbsolute(filepath)) {
            return path.relative(this.workspaceRoot, filepath).replace(/\\/g, '/');
        }
        return filepath.replace(/\\/g, '/');
    }

    private toAbsolute(filepath: string): string {
        if (path.isAbsolute(filepath)) { return filepath; }
        return path.join(this.workspaceRoot, filepath);
    }
}
