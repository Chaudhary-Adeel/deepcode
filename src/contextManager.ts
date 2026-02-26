/**
 * Context Manager for DeepCode
 *
 * Centralises workspace context gathering for the agent loop.
 * Provides helpers for building workspace summaries, reading files,
 * assembling user prompts, compressing context, and enforcing token budgets.
 *
 * Includes:
 *   - ContextBudget: Token-aware budget allocator (Module 10)
 *   - Rolling summary: Summarizes older turns (Module 8)
 *   - OperationEntry log: Structured operation history (Module 8)
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

// ─── Module 8: Operation History ─────────────────────────────────────────────

/** Structured log entry for what each agent did */
export interface OperationEntry {
    timestamp: number;
    agentType: 'intent' | 'planner' | 'generator' | 'verifier' | 'reference-miner' | 'orchestrator';
    action: string;
    target: string;
    result: 'success' | 'failure' | 'partial';
    notes: string;
}

// ─── Module 8: Rolling Context Summary ───────────────────────────────────────

/**
 * Manages rolling summaries of conversation history.
 * Keeps the last N turns verbatim; summarizes older turns into a compact digest.
 */
export class RollingContext {
    private summaries: string[] = [];
    private rawTurns: Array<{ role: string; content: string }> = [];
    private operationLog: OperationEntry[] = [];

    /** Number of recent turns to keep verbatim */
    private readonly keepVerbatim: number;
    /** Max chars for the summary section */
    private readonly maxSummaryChars: number;

    constructor(keepVerbatim = 4, maxSummaryChars = 2000) {
        this.keepVerbatim = keepVerbatim;
        this.maxSummaryChars = maxSummaryChars;
    }

    /** Add a conversation turn */
    addTurn(role: string, content: string): void {
        this.rawTurns.push({ role, content });
    }

    /** Add an operation log entry */
    addOperation(entry: OperationEntry): void {
        this.operationLog.push(entry);
        // Keep last 50 operations
        if (this.operationLog.length > 50) {
            this.operationLog = this.operationLog.slice(-50);
        }
    }

    /** Get recent operations (for detecting repeated failures) */
    getRecentOperations(count = 10): OperationEntry[] {
        return this.operationLog.slice(-count);
    }

    /** Check if the same action has failed repeatedly */
    hasRepeatedFailure(action: string, threshold = 3): boolean {
        const recent = this.operationLog.slice(-10);
        const failures = recent.filter(
            op => op.action === action && op.result === 'failure'
        );
        return failures.length >= threshold;
    }

    /**
     * Build the context string for injection into prompts.
     * Returns: summary of old turns + verbatim recent turns.
     */
    buildContext(): string {
        const parts: string[] = [];

        // Summarized older turns
        if (this.summaries.length > 0) {
            parts.push('## Conversation Summary');
            parts.push(this.summaries.join('\n'));
        }

        // Verbatim recent turns
        const recent = this.rawTurns.slice(-this.keepVerbatim);
        if (recent.length > 0) {
            parts.push('## Recent Conversation');
            for (const turn of recent) {
                parts.push(`[${turn.role}]: ${turn.content.substring(0, 1000)}`);
            }
        }

        return parts.join('\n\n');
    }

    /**
     * Summarize older turns to free up context space.
     * Call this periodically (e.g., every 4 messages).
     * Pass a summarize function that calls DeepSeek with a mini-prompt.
     */
    async maybeSummarize(
        summarizeFn: (text: string) => Promise<string>
    ): Promise<void> {
        if (this.rawTurns.length <= this.keepVerbatim) {
            return; // Not enough turns to summarize
        }

        // Take the oldest turns beyond what we keep verbatim
        const toSummarize = this.rawTurns.slice(0, -this.keepVerbatim);
        if (toSummarize.length === 0) { return; }

        const text = toSummarize
            .map(t => `[${t.role}]: ${t.content.substring(0, 500)}`)
            .join('\n');

        try {
            const summary = await summarizeFn(text);
            this.summaries.push(summary);

            // Trim summaries to budget
            let totalChars = this.summaries.join('\n').length;
            while (totalChars > this.maxSummaryChars && this.summaries.length > 1) {
                this.summaries.shift();
                totalChars = this.summaries.join('\n').length;
            }

            // Remove summarized turns from raw
            this.rawTurns = this.rawTurns.slice(-this.keepVerbatim);
        } catch {
            // Summarization failed — keep raw turns
        }
    }

    /** Get total turn count (for deciding when to summarize) */
    getTurnCount(): number {
        return this.rawTurns.length;
    }
}

// ─── Module 10: Context Budget Manager ───────────────────────────────────────

export interface BudgetComponents {
    systemPrompt: string;
    summary: string;
    skeletons: string;
    toolResults: string;
    history: Array<{ role: string; content: string }>;
}

export interface BudgetResult {
    systemPrompt: string;
    summary: string;
    skeletons: string;
    toolResults: string;
    history: Array<{ role: string; content: string }>;
    totalTokens: number;
    dropped: string[];
}

/**
 * Token-aware context budget allocator.
 * Ensures the total context fits within the model's window.
 *
 * Budget allocation (for 26k usable tokens):
 *   - System prompt: ~500 tokens (never dropped)
 *   - Summary: ~1k tokens
 *   - Skeletons: ~3k tokens
 *   - Tool results: ~8k tokens
 *   - History: ~6k tokens (last 3 turns never dropped)
 *   - Output: ~8k tokens (reserved, not in input)
 *
 * Drop order when over budget:
 *   1. Skeletons (lowest priority)
 *   2. Oldest tool results
 *   3. Compress summary
 *   4. NEVER drop system prompt or last 3 history turns
 */
export class ContextBudget {
    /** Max tokens for the entire input context */
    private readonly maxTokens: number;
    /** Approximate chars per token (conservative) */
    private readonly charsPerToken = 4;
    /** Number of recent history turns that are never dropped */
    private readonly protectedHistoryTurns = 3;

    constructor(maxTokens = 26000) {
        this.maxTokens = maxTokens;
    }

    /** Estimate token count from a string */
    estimateTokens(text: string): number {
        return Math.ceil(text.length / this.charsPerToken);
    }

    /**
     * Trim components to fit within the token budget.
     * Returns ready-to-use components with a report of what was dropped.
     */
    fit(components: BudgetComponents): BudgetResult {
        const dropped: string[] = [];
        let { systemPrompt, summary, skeletons, toolResults } = components;
        let history = [...components.history];

        const measure = () =>
            this.estimateTokens(systemPrompt) +
            this.estimateTokens(summary) +
            this.estimateTokens(skeletons) +
            this.estimateTokens(toolResults) +
            history.reduce((acc, h) => acc + this.estimateTokens(h.content), 0);

        let total = measure();

        // Step 1: Drop skeletons
        if (total > this.maxTokens && skeletons.length > 0) {
            const saved = this.estimateTokens(skeletons);
            skeletons = '';
            dropped.push(`skeletons (~${saved} tokens)`);
            total = measure();
        }

        // Step 2: Truncate oldest tool results
        if (total > this.maxTokens && toolResults.length > 0) {
            const targetChars = Math.max(0,
                toolResults.length - (total - this.maxTokens) * this.charsPerToken
            );
            if (targetChars <= 0) {
                dropped.push(`all tool results (~${this.estimateTokens(toolResults)} tokens)`);
                toolResults = '';
            } else {
                const originalTokens = this.estimateTokens(toolResults);
                toolResults = toolResults.substring(toolResults.length - targetChars);
                // Find a clean line break
                const lineBreak = toolResults.indexOf('\n');
                if (lineBreak > 0 && lineBreak < 200) {
                    toolResults = toolResults.substring(lineBreak + 1);
                }
                const keptTokens = this.estimateTokens(toolResults);
                dropped.push(`older tool results (~${originalTokens - keptTokens} tokens)`);
            }
            total = measure();
        }

        // Step 3: Compress summary
        if (total > this.maxTokens && summary.length > 0) {
            const targetChars = Math.max(200,
                summary.length - (total - this.maxTokens) * this.charsPerToken
            );
            if (targetChars < summary.length) {
                const saved = this.estimateTokens(summary) - this.estimateTokens(summary.substring(0, targetChars));
                summary = summary.substring(0, targetChars) + '...';
                dropped.push(`summary truncated (~${saved} tokens)`);
                total = measure();
            }
        }

        // Step 4: Trim older history (protect last N turns)
        if (total > this.maxTokens && history.length > this.protectedHistoryTurns) {
            const removable = history.slice(0, -this.protectedHistoryTurns);
            let tokensToFree = total - this.maxTokens;
            let removed = 0;

            while (removable.length > 0 && tokensToFree > 0) {
                const turn = removable.shift()!;
                const turnTokens = this.estimateTokens(turn.content);
                tokensToFree -= turnTokens;
                removed++;
            }

            history = history.slice(removed);
            dropped.push(`${removed} older history turn(s)`);
            total = measure();
        }

        return {
            systemPrompt,
            summary,
            skeletons,
            toolResults,
            history,
            totalTokens: measure(),
            dropped,
        };
    }

    /** Check if components fit without modification */
    fits(components: BudgetComponents): boolean {
        const total =
            this.estimateTokens(components.systemPrompt) +
            this.estimateTokens(components.summary) +
            this.estimateTokens(components.skeletons) +
            this.estimateTokens(components.toolResults) +
            components.history.reduce((acc, h) => acc + this.estimateTokens(h.content), 0);
        return total <= this.maxTokens;
    }
}
