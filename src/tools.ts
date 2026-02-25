/**
 * Tool System for DeepCode Agent
 *
 * Defines all tools the agent can use to interact with the workspace,
 * file system, terminal, and VS Code APIs. Inspired by Claude Code's
 * tool architecture.
 *
 * Tools:
 *   read_file      — Read file contents with optional line ranges
 *   write_file     — Create or overwrite files
 *   edit_file      — Surgical find-and-replace edits
 *   list_directory  — List directory contents
 *   search_files   — Glob-based file search
 *   grep_search    — Text/regex search across files
 *   run_command    — Execute shell commands
 *   get_diagnostics — Get VS Code errors/warnings
 *   run_subagent   — Spawn parallel sub-agents for focused tasks
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as https from 'https';
import * as http from 'http';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: Record<string, any>;
            required?: string[];
        };
    };
}

export interface ToolCallResult {
    success: boolean;
    output: string;
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const AGENT_TOOLS: ToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description:
                'Read the contents of a file in the workspace. Returns content with line numbers. ' +
                'Use startLine/endLine for large files to read specific ranges. ' +
                'Always read files before editing to understand their full content.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Relative path to the file from workspace root',
                    },
                    startLine: {
                        type: 'number',
                        description: 'Starting line number (1-based, optional)',
                    },
                    endLine: {
                        type: 'number',
                        description: 'Ending line number (1-based, inclusive, optional)',
                    },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description:
                'Create a new file or completely overwrite an existing file. ' +
                'Parent directories are created automatically. ' +
                'Use edit_file instead for making changes to existing files.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Relative path to the file from workspace root',
                    },
                    content: {
                        type: 'string',
                        description: 'The full content to write to the file',
                    },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description:
                'Make surgical edits to an existing file using find-and-replace. ' +
                'Each edit specifies an exact substring to find (oldText) and its replacement (newText). ' +
                'oldText must be a VERBATIM character-for-character match from the file. ' +
                'Include enough surrounding context in oldText to make it unique. ' +
                'Prefer this over write_file for modifying existing files.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Relative path to the file from workspace root',
                    },
                    edits: {
                        type: 'array',
                        description: 'Array of find-and-replace edits to apply sequentially',
                        items: {
                            type: 'object',
                            properties: {
                                oldText: {
                                    type: 'string',
                                    description:
                                        'Exact text to find in the file (must be a verbatim substring)',
                                },
                                newText: {
                                    type: 'string',
                                    description: 'Text to replace oldText with',
                                },
                            },
                            required: ['oldText', 'newText'],
                        },
                    },
                },
                required: ['path', 'edits'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'multi_edit_files',
            description:
                'Make edits across MULTIPLE files in a single tool call. ' +
                'More efficient than calling edit_file repeatedly. ' +
                'Each entry specifies a file path and an array of find-and-replace edits. ' +
                'All edits are applied sequentially. Failed edits are reported but do not block others. ' +
                'After applying, diagnostics are automatically checked and included in the result.',
            parameters: {
                type: 'object',
                properties: {
                    files: {
                        type: 'array',
                        description: 'Array of file edit operations',
                        items: {
                            type: 'object',
                            properties: {
                                path: {
                                    type: 'string',
                                    description: 'Relative path to the file from workspace root',
                                },
                                edits: {
                                    type: 'array',
                                    description: 'Array of find-and-replace edits for this file',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            oldText: {
                                                type: 'string',
                                                description: 'Exact text to find (must be verbatim)',
                                            },
                                            newText: {
                                                type: 'string',
                                                description: 'Text to replace oldText with',
                                            },
                                        },
                                        required: ['oldText', 'newText'],
                                    },
                                },
                            },
                            required: ['path', 'edits'],
                        },
                    },
                },
                required: ['files'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description:
                'List the contents of a directory. Returns file and folder names ' +
                '(folders end with /). Use this to understand project structure.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Relative path to the directory. Use "" or "." for workspace root.',
                    },
                    recursive: {
                        type: 'boolean',
                        description: 'List recursively up to 4 levels deep (default: false)',
                    },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_files',
            description:
                'Search for files matching a glob pattern. Returns matching file paths. ' +
                'Examples: "**/*.ts", "src/**/*.py", "**/package.json", "**/*test*"',
            parameters: {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description: 'Glob pattern to search for',
                    },
                    maxResults: {
                        type: 'number',
                        description: 'Maximum results to return (default: 30)',
                    },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'grep_search',
            description:
                'Search for text or regex patterns across workspace files. ' +
                'Returns matching lines with file paths and line numbers. ' +
                'Use this to find usages, references, definitions, or any text pattern.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Text or regex pattern to search for',
                    },
                    isRegex: {
                        type: 'boolean',
                        description: 'Whether the query is a regular expression (default: false)',
                    },
                    includePattern: {
                        type: 'string',
                        description:
                            'Glob pattern to limit search scope (e.g., "**/*.ts", "src/**")',
                    },
                    maxResults: {
                        type: 'number',
                        description: 'Maximum results (default: 50)',
                    },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description:
                'Execute a shell command in the workspace directory. ' +
                'Use for builds, tests, linting, git operations, package management, etc. ' +
                'Returns stdout, stderr, and exit code.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The shell command to execute',
                    },
                    timeout: {
                        type: 'number',
                        description: 'Timeout in milliseconds (default: 30000)',
                    },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_diagnostics',
            description:
                'Get VS Code diagnostics (errors, warnings, info) for a specific file ' +
                'or the entire workspace. Use after edits to verify correctness.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Relative path to check. Omit or use "" for all workspace diagnostics.',
                    },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'web_search',
            description:
                'Search the web using DuckDuckGo. Returns relevant search result snippets. ' +
                'Use this to look up documentation, find solutions, research APIs, ' +
                'or get information not available in the workspace. ' +
                'Good for: latest docs, error message lookup, library usage examples.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query — be specific and include library/framework names',
                    },
                    maxResults: {
                        type: 'number',
                        description: 'Maximum results to return (default: 5, max: 10)',
                    },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'fetch_webpage',
            description:
                'Fetch the text content of a URL. Strips HTML tags and returns readable text. ' +
                'Use this to read documentation pages, API references, GitHub READMEs, ' +
                'Stack Overflow answers, or any web page. ' +
                'Combine with web_search: search first, then fetch the most relevant URLs.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'Full URL to fetch (must start with http:// or https://)',
                    },
                    maxLength: {
                        type: 'number',
                        description: 'Maximum characters to return (default: 15000)',
                    },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_subagent',
            description:
                'Spawn a sub-agent to perform a focused task autonomously. ' +
                'The sub-agent has access to all workspace tools (read, write, edit, search, etc.) ' +
                'and will work independently until done. ' +
                'Use this when you need to investigate or implement multiple independent tasks in parallel. ' +
                'Multiple run_subagent calls in the SAME response execute simultaneously.',
            parameters: {
                type: 'object',
                properties: {
                    task: {
                        type: 'string',
                        description:
                            'Detailed description of the focused task for the sub-agent. ' +
                            'Be specific about what to investigate, change, or produce.',
                    },
                    context: {
                        type: 'string',
                        description:
                            'Any relevant context: file contents, error messages, requirements, etc.',
                    },
                },
                required: ['task'],
            },
        },
    },
];

/**
 * Tools available to sub-agents (no run_subagent to prevent infinite recursion).
 */
export const SUBAGENT_TOOLS: ToolDefinition[] = AGENT_TOOLS.filter(
    (t) => t.function.name !== 'run_subagent'
);

// ─── Tool Executor ───────────────────────────────────────────────────────────

export class ToolExecutor {
    private workspaceRoot: string;

    constructor() {
        const folders = vscode.workspace.workspaceFolders;
        this.workspaceRoot = folders?.[0]?.uri.fsPath || '';
    }

    /**
     * Execute a tool by name with the given arguments.
     * All tools are sandboxed to the workspace directory.
     */
    async execute(name: string, args: Record<string, any>): Promise<ToolCallResult> {
        try {
            switch (name) {
                case 'read_file':
                    return await this.readFile(args.path, args.startLine, args.endLine);
                case 'write_file':
                    return await this.writeFile(args.path, args.content);
                case 'edit_file':
                    return await this.editFile(args.path, args.edits || []);
                case 'multi_edit_files':
                    return await this.multiEditFiles(args.files || []);
                case 'list_directory':
                    return await this.listDirectory(args.path || '.', args.recursive || false);
                case 'search_files':
                    return await this.searchFiles(args.pattern, args.maxResults || 30);
                case 'grep_search':
                    return await this.grepSearch(
                        args.query,
                        args.isRegex || false,
                        args.includePattern,
                        args.maxResults || 50
                    );
                case 'run_command':
                    return await this.runCommand(args.command, args.timeout || 30000);
                case 'get_diagnostics':
                    return await this.getDiagnostics(args.path);
                case 'web_search':
                    return await this.webSearch(args.query, args.maxResults || 5);
                case 'fetch_webpage':
                    return await this.fetchWebpage(args.url, args.maxLength || 15000);
                default:
                    return { success: false, output: `Unknown tool: ${name}` };
            }
        } catch (error: any) {
            return {
                success: false,
                output: `Tool "${name}" error: ${error.message}`,
            };
        }
    }

    // ─── Path Resolution ─────────────────────────────────────────────────

    private resolvePath(relativePath: string): string {
        if (path.isAbsolute(relativePath)) {
            // Security: ensure path is within workspace
            if (!relativePath.startsWith(this.workspaceRoot)) {
                throw new Error(
                    `Path "${relativePath}" is outside the workspace. Only workspace-relative paths are allowed.`
                );
            }
            return relativePath;
        }
        return path.join(this.workspaceRoot, relativePath);
    }

    // ─── read_file ───────────────────────────────────────────────────────

    private async readFile(
        filePath: string,
        startLine?: number,
        endLine?: number
    ): Promise<ToolCallResult> {
        const fullPath = this.resolvePath(filePath);
        const uri = vscode.Uri.file(fullPath);
        const contentBytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(contentBytes).toString('utf-8');
        const lines = text.split('\n');

        const start = startLine ? Math.max(1, startLine) : 1;
        const end = endLine ? Math.min(lines.length, endLine) : lines.length;
        const selectedLines = lines.slice(start - 1, end);

        const numbered = selectedLines
            .map((line, i) => `${String(start + i).padStart(4)} | ${line}`)
            .join('\n');

        return {
            success: true,
            output: `File: ${filePath} (${lines.length} lines total, showing ${start}-${end})\n\n${numbered}`,
        };
    }

    // ─── write_file ──────────────────────────────────────────────────────

    private async writeFile(filePath: string, content: string): Promise<ToolCallResult> {
        if (!filePath) {
            return { success: false, output: 'write_file failed: "path" argument is required but was undefined or empty. Please provide a valid file path.' };
        }
        if (content === undefined || content === null) {
            return { success: false, output: `write_file failed for "${filePath}": "content" argument is required but was undefined. Please provide the file content.` };
        }
        const fullPath = this.resolvePath(filePath);
        const uri = vscode.Uri.file(fullPath);

        // Create parent directories if needed
        const dirPath = path.dirname(fullPath);
        const dirUri = vscode.Uri.file(dirPath);
        try {
            await vscode.workspace.fs.stat(dirUri);
        } catch {
            await vscode.workspace.fs.createDirectory(dirUri);
        }

        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));

        // Open the file in editor so user can see it
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, {
                preview: false,
                preserveFocus: true,
            });
        } catch {
            // Non-critical — file was still written
        }

        const lineCount = content.split('\n').length;
        return {
            success: true,
            output: `File created/written: ${filePath} (${lineCount} lines)`,
        };
    }

    // ─── edit_file ───────────────────────────────────────────────────────

    private async editFile(
        filePath: string,
        edits: Array<{ oldText: string; newText: string }>
    ): Promise<ToolCallResult> {
        if (!filePath) {
            return { success: false, output: 'edit_file failed: "path" argument is required but was undefined or empty. Please provide a valid file path.' };
        }
        if (!edits || !Array.isArray(edits) || edits.length === 0) {
            return { success: false, output: `edit_file failed for "${filePath}": "edits" argument must be a non-empty array of {oldText, newText} objects.` };
        }
        const fullPath = this.resolvePath(filePath);
        const uri = vscode.Uri.file(fullPath);

        // Read current content
        let contentBytes: Uint8Array;
        try {
            contentBytes = await vscode.workspace.fs.readFile(uri);
        } catch (readErr: any) {
            return { success: false, output: `edit_file failed: could not read "${filePath}": ${readErr.message}. Does the file exist?` };
        }
        let content = Buffer.from(contentBytes).toString('utf-8');

        let appliedCount = 0;
        const failures: string[] = [];

        for (const edit of edits) {
            if (!edit.oldText && edit.newText) {
                // Append mode
                content += '\n' + edit.newText;
                appliedCount++;
            } else if (content.includes(edit.oldText)) {
                content = content.replace(edit.oldText, edit.newText);
                appliedCount++;
            } else {
                // Try with trimmed whitespace
                const trimmedOld = edit.oldText.trim();
                if (trimmedOld && content.includes(trimmedOld)) {
                    // Find the line containing trimmedOld and replace preserving indentation
                    content = content.replace(trimmedOld, edit.newText.trim());
                    appliedCount++;
                } else {
                    failures.push(
                        edit.oldText.substring(0, 80) + (edit.oldText.length > 80 ? '...' : '')
                    );
                }
            }
        }

        if (appliedCount > 0) {
            // Apply through VS Code editor API for undo support
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, {
                preview: false,
                preserveFocus: true,
            });

            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
            );

            await editor.edit((editBuilder) => {
                editBuilder.replace(fullRange, content);
            });
        }

        let output = `Applied ${appliedCount}/${edits.length} edit(s) to ${filePath}`;
        if (failures.length > 0) {
            output += `\nFailed to find:\n${failures.map((f) => `  - "${f}"`).join('\n')}`;
            output +=
                '\n\nHint: oldText must be an EXACT verbatim substring. Read the file again to get precise text.';
        }

        // Auto-check diagnostics after edits to enable progressive error fixing
        if (appliedCount > 0) {
            const diagResult = await this.getFileDiagnosticsQuick(filePath);
            if (diagResult) {
                output += `\n\n--- Auto-diagnostics for ${filePath} ---\n${diagResult}`;
                output += '\nIf there are errors above, fix them now with another edit_file call.';
            }
        }

        return { success: appliedCount > 0, output };
    }

    // ─── multi_edit_files ────────────────────────────────────────────────

    private async multiEditFiles(
        files: Array<{ path: string; edits: Array<{ oldText: string; newText: string }> }>
    ): Promise<ToolCallResult> {
        if (!files || !Array.isArray(files) || files.length === 0) {
            return {
                success: false,
                output: 'multi_edit_files failed: "files" must be a non-empty array of {path, edits[]} objects.',
            };
        }

        const results: string[] = [];
        let totalApplied = 0;
        let totalFailed = 0;
        const editedPaths: string[] = [];

        for (const file of files) {
            if (!file.path) {
                results.push(`⚠ Skipped entry with missing path`);
                totalFailed++;
                continue;
            }
            if (!file.edits || !Array.isArray(file.edits) || file.edits.length === 0) {
                results.push(`⚠ ${file.path}: no edits provided, skipped`);
                totalFailed++;
                continue;
            }

            try {
                const editResult = await this.editFileSingle(file.path, file.edits);
                results.push(`${file.path}: ${editResult.summary}`);
                totalApplied += editResult.applied;
                totalFailed += editResult.failed;
                if (editResult.applied > 0) {
                    editedPaths.push(file.path);
                }
            } catch (err: any) {
                results.push(`${file.path}: ERROR — ${err.message}`);
                totalFailed += file.edits.length;
            }
        }

        let output = `Multi-file edit: ${totalApplied} applied, ${totalFailed} failed across ${files.length} file(s)\n\n`;
        output += results.join('\n');

        // Auto-check diagnostics for all edited files
        if (editedPaths.length > 0) {
            const diagParts: string[] = [];
            for (const p of editedPaths) {
                const diag = await this.getFileDiagnosticsQuick(p);
                if (diag) {
                    diagParts.push(`${p}:\n${diag}`);
                }
            }
            if (diagParts.length > 0) {
                output += `\n\n--- Auto-diagnostics ---\n${diagParts.join('\n')}`;
                output += '\nIf there are errors above, fix them now with another edit call.';
            }
        }

        return { success: totalApplied > 0, output };
    }

    /**
     * Internal single-file edit helper that returns granular counts — used by multiEditFiles.
     */
    private async editFileSingle(
        filePath: string,
        edits: Array<{ oldText: string; newText: string }>
    ): Promise<{ applied: number; failed: number; summary: string }> {
        const fullPath = this.resolvePath(filePath);
        const uri = vscode.Uri.file(fullPath);

        let contentBytes: Uint8Array;
        try {
            contentBytes = await vscode.workspace.fs.readFile(uri);
        } catch (readErr: any) {
            throw new Error(`could not read file: ${readErr.message}`);
        }
        let content = Buffer.from(contentBytes).toString('utf-8');

        let applied = 0;
        const failures: string[] = [];

        for (const edit of edits) {
            if (!edit.oldText && edit.newText) {
                content += '\n' + edit.newText;
                applied++;
            } else if (content.includes(edit.oldText)) {
                content = content.replace(edit.oldText, edit.newText);
                applied++;
            } else {
                const trimmedOld = edit.oldText.trim();
                if (trimmedOld && content.includes(trimmedOld)) {
                    content = content.replace(trimmedOld, edit.newText.trim());
                    applied++;
                } else {
                    failures.push(edit.oldText.substring(0, 60) + (edit.oldText.length > 60 ? '...' : ''));
                }
            }
        }

        if (applied > 0) {
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, {
                preview: false,
                preserveFocus: true,
            });
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
            );
            await editor.edit((editBuilder) => {
                editBuilder.replace(fullRange, content);
            });
        }

        let summary = `${applied}/${edits.length} edit(s) applied`;
        if (failures.length > 0) {
            summary += ` | not found: ${failures.map(f => `"${f}"`).join(', ')}`;
        }

        return { applied, failed: failures.length, summary };
    }

    /**
     * Quick diagnostics check for a single file — returns error/warning text or null if clean.
     */
    private async getFileDiagnosticsQuick(filePath: string): Promise<string | null> {
        try {
            const fullPath = this.resolvePath(filePath);
            const uri = vscode.Uri.file(fullPath);
            // Wait briefly for diagnostics to update after edits
            await new Promise(r => setTimeout(r, 500));
            const diags = vscode.languages.getDiagnostics(uri);
            const errors = diags.filter(
                d => d.severity === vscode.DiagnosticSeverity.Error ||
                     d.severity === vscode.DiagnosticSeverity.Warning
            );
            if (errors.length === 0) { return null; }
            return errors.map(d => {
                const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
                return `  Line ${d.range.start.line + 1}: [${sev}] ${d.message}`;
            }).join('\n');
        } catch {
            return null;
        }
    }

    // ─── list_directory ──────────────────────────────────────────────────

    private async listDirectory(
        dirPath: string,
        recursive: boolean
    ): Promise<ToolCallResult> {
        const fullPath = this.resolvePath(dirPath === '.' || dirPath === '' ? '' : dirPath);
        const uri = vscode.Uri.file(fullPath || this.workspaceRoot);
        const result: string[] = [];

        await this.buildDirListing(uri, '', recursive ? 4 : 1, result);

        return {
            success: true,
            output:
                result.length > 0
                    ? `Directory: ${dirPath || '.'}\n\n${result.join('\n')}`
                    : `Directory "${dirPath || '.'}" is empty or does not exist.`,
        };
    }

    private async buildDirListing(
        uri: vscode.Uri,
        prefix: string,
        depth: number,
        result: string[]
    ): Promise<void> {
        if (depth <= 0) return;

        const SKIP = new Set([
            'node_modules', '.git', 'out', 'dist', '__pycache__', '.next',
            'build', '.vscode-test', '.DS_Store', 'coverage', '.nyc_output',
            '.cache', '.turbo', '.parcel-cache', '.deepcode',
        ]);

        try {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            entries.sort((a, b) => {
                if (
                    a[1] === vscode.FileType.Directory &&
                    b[1] !== vscode.FileType.Directory
                ) { return -1; }
                if (
                    a[1] !== vscode.FileType.Directory &&
                    b[1] === vscode.FileType.Directory
                ) { return 1; }
                return a[0].localeCompare(b[0]);
            });

            for (const [name, type] of entries) {
                if (SKIP.has(name)) { continue; }

                const isDir = type === vscode.FileType.Directory;
                result.push(`${prefix}${isDir ? name + '/' : name}`);

                if (isDir && depth > 1) {
                    const childUri = vscode.Uri.joinPath(uri, name);
                    await this.buildDirListing(childUri, prefix + '  ', depth - 1, result);
                }
            }
        } catch {
            /* permission error or dir doesn't exist */
        }
    }

    // ─── search_files ────────────────────────────────────────────────────

    private async searchFiles(
        pattern: string,
        maxResults: number
    ): Promise<ToolCallResult> {
        const found = await vscode.workspace.findFiles(
            pattern,
            '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}',
            maxResults
        );

        const root = this.workspaceRoot;
        const paths = found.map((f) =>
            f.fsPath.startsWith(root) ? f.fsPath.slice(root.length + 1) : f.fsPath
        );

        return {
            success: true,
            output:
                paths.length > 0
                    ? `Found ${paths.length} file(s):\n${paths.join('\n')}`
                    : `No files found matching "${pattern}".`,
        };
    }

    // ─── grep_search ─────────────────────────────────────────────────────

    private async grepSearch(
        query: string,
        isRegex: boolean,
        includePattern?: string,
        maxResults?: number
    ): Promise<ToolCallResult> {
        if (!this.workspaceRoot) {
            return { success: false, output: 'No workspace open.' };
        }

        // Try ripgrep first (fast), fall back to VS Code search
        return new Promise<ToolCallResult>((resolve) => {
            const limit = maxResults || 50;
            const rgArgs = [
                '--line-number',
                '--no-heading',
                '--color', 'never',
                '--max-count', String(limit),
                '-i', // case insensitive
            ];

            if (!isRegex) {
                rgArgs.push('--fixed-strings');
            }

            if (includePattern) {
                rgArgs.push('--glob', includePattern);
            }

            // Exclude common dirs
            rgArgs.push(
                '--glob', '!node_modules',
                '--glob', '!.git',
                '--glob', '!out',
                '--glob', '!dist',
                '--glob', '!*.min.js',
                '--glob', '!*.map',
            );
            rgArgs.push('--', query);

            const proc = cp.spawn('rg', rgArgs, {
                cwd: this.workspaceRoot,
                timeout: 15000,
            });

            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                if (code === 0 || code === 1) {
                    const lines = stdout
                        .split('\n')
                        .filter((l) => l.trim())
                        .slice(0, limit);
                    resolve({
                        success: true,
                        output:
                            lines.length > 0
                                ? `Found ${lines.length} match(es):\n${lines.join('\n')}`
                                : 'No matches found.',
                    });
                } else {
                    // rg not available or error — use fallback
                    resolve(this.fallbackGrep(query, isRegex, includePattern, limit));
                }
            });

            proc.on('error', () => {
                resolve(this.fallbackGrep(query, isRegex, includePattern, limit));
            });
        });
    }

    private async fallbackGrep(
        query: string,
        isRegex: boolean,
        includePattern?: string,
        maxResults?: number
    ): Promise<ToolCallResult> {
        const pattern = includePattern || '**/*';
        const files = await vscode.workspace.findFiles(
            pattern,
            '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}',
            200
        );

        const results: string[] = [];
        const limit = maxResults || 50;
        const regex = isRegex ? new RegExp(query, 'gi') : null;

        for (const file of files) {
            if (results.length >= limit) { break; }
            try {
                const content = await vscode.workspace.fs.readFile(file);
                const text = Buffer.from(content).toString('utf-8');

                // Skip likely binary files
                if (text.includes('\0')) { continue; }

                const lines = text.split('\n');
                for (let i = 0; i < lines.length && results.length < limit; i++) {
                    const line = lines[i];
                    const matches = regex
                        ? regex.test(line)
                        : line.toLowerCase().includes(query.toLowerCase());
                    if (matches) {
                        const relPath = file.fsPath.startsWith(this.workspaceRoot)
                            ? file.fsPath.slice(this.workspaceRoot.length + 1)
                            : file.fsPath;
                        results.push(`${relPath}:${i + 1}: ${line.trim()}`);
                    }
                    if (regex) { regex.lastIndex = 0; }
                }
            } catch {
                /* skip unreadable files */
            }
        }

        return {
            success: true,
            output:
                results.length > 0
                    ? `Found ${results.length} match(es):\n${results.join('\n')}`
                    : 'No matches found.',
        };
    }

    // ─── run_command ─────────────────────────────────────────────────────

    private async runCommand(
        command: string,
        timeout: number
    ): Promise<ToolCallResult> {
        return new Promise<ToolCallResult>((resolve) => {
            cp.exec(
                command,
                {
                    cwd: this.workspaceRoot,
                    timeout,
                    maxBuffer: 2 * 1024 * 1024, // 2 MB
                    env: { ...process.env, FORCE_COLOR: '0' },
                },
                (error, stdout, stderr) => {
                    const parts: string[] = [];
                    if (stdout.trim()) {
                        parts.push(`stdout:\n${stdout.trim().substring(0, 50000)}`);
                    }
                    if (stderr.trim()) {
                        parts.push(`stderr:\n${stderr.trim().substring(0, 10000)}`);
                    }
                    const exitCode = error?.code ?? 0;
                    parts.push(`Exit code: ${exitCode}`);

                    resolve({
                        success: exitCode === 0,
                        output: parts.join('\n\n') || '(no output)',
                    });
                }
            );
        });
    }

    // ─── get_diagnostics ─────────────────────────────────────────────────

    private async getDiagnostics(filePath?: string): Promise<ToolCallResult> {
        let diagnosticEntries: [vscode.Uri, readonly vscode.Diagnostic[]][];

        if (filePath) {
            const fullPath = this.resolvePath(filePath);
            const uri = vscode.Uri.file(fullPath);
            const diags = vscode.languages.getDiagnostics(uri);
            diagnosticEntries = [[uri, diags]];
        } else {
            diagnosticEntries = vscode.languages
                .getDiagnostics()
                .filter(([_, diags]) => diags.length > 0);
        }

        const results: string[] = [];
        for (const [uri, diags] of diagnosticEntries) {
            const relPath = uri.fsPath.startsWith(this.workspaceRoot)
                ? uri.fsPath.slice(this.workspaceRoot.length + 1)
                : uri.fsPath;

            for (const d of diags) {
                const severity =
                    d.severity === vscode.DiagnosticSeverity.Error
                        ? 'ERROR'
                        : d.severity === vscode.DiagnosticSeverity.Warning
                        ? 'WARN'
                        : 'INFO';
                results.push(
                    `${relPath}:${d.range.start.line + 1}:${d.range.start.character + 1}: [${severity}] ${d.message}`
                );
            }
        }

        return {
            success: true,
            output:
                results.length > 0
                    ? `${results.length} diagnostic(s):\n${results.join('\n')}`
                    : 'No diagnostics (no errors or warnings).',
        };
    }

    // ─── web_search ──────────────────────────────────────────────────────

    private async webSearch(query: string, maxResults: number): Promise<ToolCallResult> {
        const limit = Math.min(maxResults || 5, 10);

        // Use DuckDuckGo HTML search — no API key needed
        const encodedQuery = encodeURIComponent(query);
        const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

        try {
            const html = await this.httpGet(url, 15000);

            // Parse results from DuckDuckGo HTML
            const results: Array<{ title: string; url: string; snippet: string }> = [];

            // Match result blocks: <a class="result__a" href="...">title</a> and <a class="result__snippet" ...>snippet</a>
            const resultBlocks = html.split(/class="result\s/g);

            for (let i = 1; i < resultBlocks.length && results.length < limit; i++) {
                const block = resultBlocks[i];

                // Extract URL
                const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
                // Extract title
                const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
                // Extract snippet
                const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

                if (urlMatch || titleMatch) {
                    let resultUrl = urlMatch?.[1] || '';
                    // DuckDuckGo wraps URLs in a redirect — extract the actual URL
                    const uddgMatch = resultUrl.match(/uddg=([^&]+)/);
                    if (uddgMatch) {
                        resultUrl = decodeURIComponent(uddgMatch[1]);
                    }

                    results.push({
                        title: this.stripHtmlTags(titleMatch?.[1] || 'No title').trim(),
                        url: resultUrl,
                        snippet: this.stripHtmlTags(snippetMatch?.[1] || '').trim().substring(0, 300),
                    });
                }
            }

            if (results.length === 0) {
                return { success: true, output: `No search results found for "${query}".` };
            }

            const formatted = results.map((r, i) =>
                `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
            ).join('\n\n');

            return {
                success: true,
                output: `Search results for "${query}" (${results.length} results):\n\n${formatted}`,
            };
        } catch (error: any) {
            return {
                success: false,
                output: `Web search failed: ${error.message}`,
            };
        }
    }

    // ─── fetch_webpage ───────────────────────────────────────────────────

    private async fetchWebpage(url: string, maxLength: number): Promise<ToolCallResult> {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return { success: false, output: 'URL must start with http:// or https://' };
        }

        try {
            const html = await this.httpGet(url, 20000);

            // Strip HTML to get readable text
            let text = html;

            // Remove script and style blocks entirely
            text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
            text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
            text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
            text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');

            // Convert common block elements to newlines
            text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');
            text = text.replace(/<br\s*\/?>/gi, '\n');
            text = text.replace(/<li[^>]*>/gi, '• ');

            // Strip remaining tags
            text = this.stripHtmlTags(text);

            // Decode HTML entities
            text = text.replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&nbsp;/g, ' ');

            // Clean up whitespace
            text = text.replace(/[ \t]+/g, ' ');
            text = text.replace(/\n{3,}/g, '\n\n');
            text = text.trim();

            // Truncate
            const limit = Math.min(maxLength || 15000, 50000);
            if (text.length > limit) {
                text = text.substring(0, limit) + '\n\n... (truncated)';
            }

            return {
                success: true,
                output: `Content from ${url} (${text.length} chars):\n\n${text}`,
            };
        } catch (error: any) {
            return {
                success: false,
                output: `Failed to fetch ${url}: ${error.message}`,
            };
        }
    }

    // ─── HTTP helpers ────────────────────────────────────────────────────

    private stripHtmlTags(html: string): string {
        return html.replace(/<[^>]+>/g, '');
    }

    private httpGet(url: string, timeout: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const lib = url.startsWith('https') ? https : http;

            const req = lib.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; DeepCode/1.0; VS Code Extension)',
                    'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                timeout,
            }, (res) => {
                // Follow redirects (up to 3)
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const redirectUrl = res.headers.location.startsWith('http')
                        ? res.headers.location
                        : new URL(res.headers.location, url).toString();
                    this.httpGet(redirectUrl, timeout).then(resolve).catch(reject);
                    res.resume();
                    return;
                }

                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                let data = '';
                res.setEncoding('utf-8');
                res.on('data', (chunk: string) => {
                    data += chunk;
                    // Safety limit: don't buffer more than 2MB
                    if (data.length > 2_000_000) {
                        res.destroy();
                        resolve(data);
                    }
                });
                res.on('end', () => resolve(data));
                res.on('error', reject);
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out'));
            });
        });
    }
}
