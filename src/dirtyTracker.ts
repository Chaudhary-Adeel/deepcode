/**
 * Dirty Flag Tracker for DeepCode
 *
 * Tracks which workspace files have changed since they were last indexed.
 * Does ZERO work on file change — only sets a flag in an in-memory Set.
 *
 * On activation: compares stored lastIndexed timestamps against file mtimes
 * to pre-populate the dirty set. Uses VSCode's built-in file system watcher
 * for real-time tracking (no external dependencies).
 *
 * Persistence: `.deepcode/index-meta.json`
 */

import * as vscode from 'vscode';
import * as path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Persisted metadata for a single file's index state */
export interface IndexMetaEntry {
    /** Unix epoch ms when this file was last marked clean (indexed) */
    lastIndexed: number;
}

/** Shape of the .deepcode/index-meta.json file */
export interface IndexMetaFile {
    version: number;
    entries: Record<string, IndexMetaEntry>;
}

/** Event payload fired when a file transitions dirty ↔ clean */
export interface DirtyChangeEvent {
    /** Workspace-relative path (forward slashes) */
    filepath: string;
    /** Whether the file is now dirty (true) or clean (false) */
    dirty: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEEPCODE_DIR = '.deepcode';
const META_FILE = '.deepcode/index-meta.json';
const SAVE_DEBOUNCE_MS = 2000;

const IGNORED_DIRS = new Set([
    'node_modules', '.git', 'out', 'dist', '__pycache__', '.deepcode',
]);

const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/__pycache__/**,**/.deepcode/**}';

/** Extensions that the index engine can actually parse — only these should be dirty-tracked */
const INDEXABLE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
]);

// ─── DirtyTracker ────────────────────────────────────────────────────────────

export class DirtyTracker implements vscode.Disposable {

    private readonly dirtySet = new Set<string>();
    private indexMeta: IndexMetaFile = { version: 1, entries: {} };
    private readonly workspaceRoot: string;
    private readonly disposables: vscode.Disposable[] = [];
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    private readonly _onDidChange = new vscode.EventEmitter<DirtyChangeEvent>();
    /** Fires when a file transitions dirty ↔ clean */
    public readonly onDidChange: vscode.Event<DirtyChangeEvent> = this._onDidChange.event;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    // ─── Public API ──────────────────────────────────────────────────────

    /**
     * Async initialization: load persisted meta, scan mtimes, start watchers.
     * Designed to be called fire-and-forget (non-blocking).
     */
    async initialize(): Promise<void> {
        this.indexMeta = await this.loadMeta();
        await this.populateInitialDirtySet();
        this.startWatchers();
    }

    /** Check if a file is marked dirty */
    isDirty(filepath: string): boolean {
        return this.dirtySet.has(this.normalize(filepath));
    }

    /**
     * Mark a file as clean (called by IndexEngine after successful indexing).
     * Updates the lastIndexed timestamp and schedules a debounced persist.
     */
    markClean(filepath: string): void {
        const rel = this.normalize(filepath);
        this.dirtySet.delete(rel);
        this.indexMeta.entries[rel] = { lastIndexed: Date.now() };
        this._onDidChange.fire({ filepath: rel, dirty: false });
        this.scheduleSave();
    }

    /**
     * Mark a file as dependency-dirty (called by IndexEngine when an
     * upstream file's exports change). Unlike file-system dirtiness,
     * this is triggered by semantic analysis.
     */
    markDependencyDirty(filepath: string): void {
        const rel = this.normalize(filepath);
        if (this.dirtySet.has(rel)) { return; }
        this.dirtySet.add(rel);
        this._onDidChange.fire({ filepath: rel, dirty: true });
    }

    /** Get all currently dirty file paths (workspace-relative) */
    getDirty(): string[] {
        return Array.from(this.dirtySet);
    }

    /** Get count of dirty files */
    getDirtyCount(): number {
        return this.dirtySet.size;
    }

    /** Stop watching and clean up */
    stop(): void {
        this.dispose();
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;

        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
        this._onDidChange.dispose();

        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }

        // Final flush — fire-and-forget
        this.saveMeta().catch(() => {});
    }

    // ─── Private: Persistence ────────────────────────────────────────────

    private async loadMeta(): Promise<IndexMetaFile> {
        try {
            const metaPath = path.join(this.workspaceRoot, META_FILE);
            const uri = vscode.Uri.file(metaPath);
            const data = await vscode.workspace.fs.readFile(uri);
            const parsed = JSON.parse(Buffer.from(data).toString('utf-8'));
            if (parsed && parsed.version === 1 && parsed.entries) {
                return parsed as IndexMetaFile;
            }
        } catch {
            // File missing or corrupt — start fresh
        }
        return { version: 1, entries: {} };
    }

    private scheduleSave(): void {
        if (this.disposed) { return; }
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => {
            this.saveMeta().catch(() => {});
        }, SAVE_DEBOUNCE_MS);
    }

    private async saveMeta(): Promise<void> {
        if (!this.workspaceRoot) { return; }

        // Ensure .deepcode/ directory exists
        const dirUri = vscode.Uri.file(path.join(this.workspaceRoot, DEEPCODE_DIR));
        try {
            await vscode.workspace.fs.stat(dirUri);
        } catch {
            await vscode.workspace.fs.createDirectory(dirUri);
        }

        const metaUri = vscode.Uri.file(path.join(this.workspaceRoot, META_FILE));
        const json = JSON.stringify(this.indexMeta, null, 2);
        await vscode.workspace.fs.writeFile(metaUri, Buffer.from(json, 'utf-8'));
    }

    // ─── Private: Initial Scan ───────────────────────────────────────────

    private async populateInitialDirtySet(): Promise<void> {
        try {
            const files = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB);

            for (const uri of files) {
                const rel = this.toRelative(uri);
                if (this.isIgnored(rel)) { continue; }

                // Only track files the index engine can actually process
                if (!this.isIndexableExtension(rel)) { continue; }

                try {
                    const stat = await vscode.workspace.fs.stat(uri);
                    const mtime = stat.mtime;
                    const entry = this.indexMeta.entries[rel];

                    if (!entry || mtime > entry.lastIndexed) {
                        this.dirtySet.add(rel);
                    }
                } catch {
                    // Can't stat — mark dirty to be safe
                    this.dirtySet.add(rel);
                }
            }
        } catch {
            // findFiles failed — workspace not ready; watchers will catch changes
        }
    }

    // ─── Private: File Watchers ──────────────────────────────────────────

    private startWatchers(): void {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');

        this.disposables.push(
            watcher,
            watcher.onDidChange(uri => this.onFileChanged(uri)),
            watcher.onDidCreate(uri => this.onFileChanged(uri)),
            watcher.onDidDelete(uri => this.onFileDeleted(uri)),
        );
    }

    private onFileChanged(uri: vscode.Uri): void {
        const rel = this.toRelative(uri);
        if (this.isIgnored(rel)) { return; }
        if (!this.isIndexableExtension(rel)) { return; } // Only track indexable files
        if (this.dirtySet.has(rel)) { return; } // already dirty — no-op

        this.dirtySet.add(rel);
        this._onDidChange.fire({ filepath: rel, dirty: true });
    }

    private onFileDeleted(uri: vscode.Uri): void {
        const rel = this.toRelative(uri);
        this.dirtySet.delete(rel);
        delete this.indexMeta.entries[rel];
        this.scheduleSave();
    }

    // ─── Private: Path Helpers ───────────────────────────────────────────

    /** Convert absolute URI to workspace-relative path with forward slashes */
    private toRelative(uri: vscode.Uri): string {
        return path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, '/');
    }

    /** Normalize a filepath to workspace-relative with forward slashes */
    private normalize(filepath: string): string {
        if (path.isAbsolute(filepath)) {
            return path.relative(this.workspaceRoot, filepath).replace(/\\/g, '/');
        }
        return filepath.replace(/\\/g, '/');
    }

    /** Check if a path falls under an ignored directory */
    private isIgnored(relativePath: string): boolean {
        const segments = relativePath.split('/');
        return segments.some(seg => IGNORED_DIRS.has(seg));
    }

    /** Check if a file has an extension the index engine can process */
    private isIndexableExtension(filepath: string): boolean {
        const ext = filepath.substring(filepath.lastIndexOf('.')).toLowerCase();
        return INDEXABLE_EXTENSIONS.has(ext);
    }
}
