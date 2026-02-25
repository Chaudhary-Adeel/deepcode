/**
 * Context Manager for DeepCode
 *
 * Centralises workspace context gathering for the agent loop.
 * Provides helpers for building workspace summaries, reading files,
 * assembling user prompts, and compressing context to fit within
 * token budgets.
 */

import * as vscode from 'vscode';

// ─── Binary-file detection ──────────────────────────────────────────────────

const BINARY_EXTS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp', 'avif',
    'mp3', 'mp4', 'wav', 'ogg', 'webm', 'avi', 'mov', 'mkv',
    'zip', 'gz', 'tar', 'bz2', 'rar', '7z', 'jar',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite',
    'pyc', 'class', 'o', 'obj', 'wasm',
]);

const TREE_EXCLUDE = new Set([
    'node_modules', '.git', 'out', 'dist', '__pycache__', '.deepcode',
]);

// ─── Public interface ────────────────────────────────────────────────────────

export class ContextManager {

    // ── Workspace context ────────────────────────────────────────────────

    /**
     * Build a concise textual summary of the workspace for the LLM.
     *
     * Includes:
     *   - Workspace name and root path
     *   - File tree (top 3 levels, common noisy dirs excluded)
     *   - Currently open file name and language
     *   - Currently selected text (if any)
     */
    async buildWorkspaceContext(): Promise<string> {
        const parts: string[] = [];

        // Workspace root
        const root = vscode.workspace.workspaceFolders?.[0];
        if (root) {
            parts.push(`Workspace: ${root.name}`);
            parts.push(`Root: ${root.uri.fsPath}`);
        } else {
            parts.push('No workspace open.');
        }

        // File tree
        const tree = await this.getFileTree();
        if (tree) {
            parts.push('');
            parts.push('File tree (top 3 levels):');
            parts.push(tree);
        }

        // Active editor
        const editor = this.getActiveEditorInfo();
        if (editor) {
            parts.push('');
            parts.push(`Open file: ${editor.fileName} (${editor.language})`);
            if (editor.selection) {
                parts.push(`\nSelected text:\n\`\`\`${editor.language}\n${editor.selection}\n\`\`\``);
            }
        }

        return parts.join('\n');
    }

    // ── User prompt assembly ─────────────────────────────────────────────

    /**
     * Build the full user prompt sent to the model.
     *
     * Combines:
     *   1. The user's raw message
     *   2. Content of any attached files (read from disk)
     *   3. Active editor content / selection
     *   4. Recent conversation history snippet
     */
    async buildUserPrompt(
        message: string,
        attachedFiles?: string[],
        conversationHistory?: Array<{ role: string; content: string }>,
    ): Promise<string> {
        const sections: string[] = [];

        // 1. User message
        sections.push(message);

        // 2. Attached files
        if (attachedFiles && attachedFiles.length > 0) {
            const fileContents = await this.readMultipleFiles(attachedFiles);
            sections.push('\n--- Attached Files ---');
            for (const fc of fileContents) {
                const ext = fc.path.split('.').pop() || '';
                sections.push(`\nFile: ${fc.path}\n\`\`\`${ext}\n${fc.content}\n\`\`\``);
            }
        }

        // 3. Active editor context
        const editor = this.getActiveEditorInfo();
        if (editor) {
            sections.push(`\n--- Active Editor ---`);
            sections.push(`File: ${editor.fileName} (${editor.language})`);
            if (editor.selection) {
                sections.push(`\nSelected code:\n\`\`\`${editor.language}\n${editor.selection}\n\`\`\``);
            } else {
                // Include a trimmed view of the full file so the model has context
                const trimmed = editor.content.length > 10_000
                    ? editor.content.substring(0, 10_000) + '\n... (truncated)'
                    : editor.content;
                sections.push(`\nFull file:\n\`\`\`${editor.language}\n${trimmed}\n\`\`\``);
            }
        }

        // 4. Recent conversation history
        if (conversationHistory && conversationHistory.length > 0) {
            const recent = conversationHistory.slice(-10);
            sections.push(
                '\n--- Conversation History ---\n' +
                recent.map(m => `[${m.role}]: ${m.content.substring(0, 500)}`).join('\n') +
                '\n---',
            );
        }

        return sections.join('\n');
    }

    // ── File I/O ─────────────────────────────────────────────────────────

    /**
     * Read multiple files from disk, returning `{ path, content }[]`.
     *
     * Binary files (detected by extension *and* by NUL-byte sampling)
     * are returned with a descriptive placeholder instead of raw bytes.
     * Very large files (>100 KB) are truncated.
     */
    async readMultipleFiles(paths: string[]): Promise<{ path: string; content: string }[]> {
        const results: { path: string; content: string }[] = [];

        for (const fp of paths) {
            // Quick extension check
            if (this.isBinaryFile(fp)) {
                const name = fp.split('/').pop() || fp;
                results.push({ path: fp, content: `[Binary file: ${name} — not readable as text]` });
                continue;
            }

            try {
                const uri = vscode.Uri.file(fp);
                const bytes = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(bytes).toString('utf-8');

                // Detect binary content via NUL / replacement-char sampling
                const sample = content.substring(0, 8192);
                if (sample.includes('\0') || sample.includes('\ufffd')) {
                    const name = fp.split('/').pop() || fp;
                    results.push({ path: fp, content: `[Binary file: ${name} — not readable as text]` });
                    continue;
                }

                // Truncate very large files
                if (content.length > 100_000) {
                    results.push({
                        path: fp,
                        content: `[File too large: ${(content.length / 1024).toFixed(0)}KB - truncated]\n${content.substring(0, 5000)}\n...`,
                    });
                } else {
                    results.push({ path: fp, content });
                }
            } catch {
                results.push({ path: fp, content: '[Could not read file]' });
            }
        }

        return results;
    }

    // ── Context compression ──────────────────────────────────────────────

    /**
     * Smart context compression that preserves the most useful parts of
     * source code while trimming to fit within `maxChars`.
     *
     * Priority order:
     *   1. Import / export statements  (high)
     *   2. Function & class signatures (medium)
     *   3. Function bodies             (low — truncated first)
     */
    compressContext(text: string, maxChars: number): string {
        if (text.length <= maxChars) {
            return text;
        }

        const lines = text.split('\n');

        // Classify every line
        const classified = lines.map(line => {
            const trimmed = line.trimStart();
            if (
                trimmed.startsWith('import ') ||
                trimmed.startsWith('export ') ||
                trimmed.startsWith('from ') ||
                trimmed.startsWith('require(') ||
                trimmed.startsWith('module.exports')
            ) {
                return { line, priority: 0 }; // high — keep
            }
            if (
                /^\s*(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var)\s/.test(line) ||
                /^\s*(public|private|protected|static|async)\s/.test(line) ||
                /^\s*\/\*\*/.test(line) || // JSDoc openers
                /^\s*\*\//.test(line)      // JSDoc closers
            ) {
                return { line, priority: 1 }; // medium — keep if room
            }
            return { line, priority: 2 }; // low — body lines
        });

        // Build result: always include priority-0, then priority-1, then
        // fill with priority-2 until we hit the budget.
        const buckets: string[][] = [[], [], []];
        for (const { line, priority } of classified) {
            buckets[priority].push(line);
        }

        let result = buckets[0].join('\n');
        if (result.length >= maxChars) {
            return result.substring(0, maxChars);
        }

        // Add signatures
        const sigBlock = buckets[1].join('\n');
        if (result.length + 1 + sigBlock.length <= maxChars) {
            result += '\n' + sigBlock;
        } else {
            const remaining = maxChars - result.length - 1;
            if (remaining > 0) {
                result += '\n' + sigBlock.substring(0, remaining);
            }
            return result;
        }

        // Fill with body lines
        const bodyBlock = buckets[2].join('\n');
        if (result.length + 1 + bodyBlock.length <= maxChars) {
            result += '\n' + bodyBlock;
        } else {
            const remaining = maxChars - result.length - 1;
            if (remaining > 0) {
                result += '\n' + bodyBlock.substring(0, remaining) + '\n... (truncated)';
            }
        }

        return result;
    }

    // ── Private helpers ──────────────────────────────────────────────────

    /**
     * Lightweight file tree (top 3 levels, common noisy dirs excluded).
     */
    private async getFileTree(maxDepth: number = 3): Promise<string | null> {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) {
            return null;
        }

        const lines: string[] = [];
        await this.buildTree(root, '', maxDepth, lines);
        return lines.join('\n');
    }

    private async buildTree(
        uri: vscode.Uri,
        prefix: string,
        depth: number,
        result: string[],
    ): Promise<void> {
        if (depth <= 0) {
            return;
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            const filtered = entries.filter(
                ([name]) => !name.startsWith('.') && !TREE_EXCLUDE.has(name),
            );

            for (const [name, type] of filtered) {
                const isDir = type === vscode.FileType.Directory;
                result.push(`${prefix}${isDir ? '📁' : '📄'} ${name}`);
                if (isDir) {
                    const childUri = vscode.Uri.joinPath(uri, name);
                    await this.buildTree(childUri, prefix + '  ', depth - 1, result);
                }
            }
        } catch {
            // Permission denied or other FS error — silently skip
        }
    }

    /**
     * Retrieve info about the currently active text editor.
     */
    private getActiveEditorInfo(): {
        content: string;
        fileName: string;
        selection?: string;
        language: string;
    } | null {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return null;
        }

        const document = editor.document;
        const selection = editor.selection;
        const selectedText = !selection.isEmpty
            ? document.getText(selection)
            : undefined;

        return {
            content: document.getText(),
            fileName: document.fileName,
            selection: selectedText,
            language: document.languageId,
        };
    }

    /**
     * Check whether a file is binary based on its extension.
     */
    private isBinaryFile(filePath: string): boolean {
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        return BINARY_EXTS.has(ext);
    }
}
