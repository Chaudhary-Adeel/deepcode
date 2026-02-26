import * as vscode from 'vscode';
import { DeepSeekService } from './deepseekService';
import { FileEditorService } from './fileEditorService';
import { SubAgentService } from './subAgentService';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'deepcode.chatView';
    private _view?: vscode.WebviewView;
    private readonly _subAgentService: SubAgentService;
    private _chatHistory: Array<{role: string, content: string}> = [];
    private _isCancelled = false;
    private _autoApproveEdits = false;
    private _pendingEdit: {
        editResult: import('./fileEditorService').EditResult;
        targetDocument: vscode.TextDocument;
        agentsUsed: string[];
        totalTokens: number;
    } | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
        private readonly _deepseekService: DeepSeekService,
        private readonly _fileEditorService: FileEditorService
    ) {
        this._subAgentService = new SubAgentService();
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'chat': {
                    await this.handleChatMessage(data.message, data.attachedFiles);
                    break;
                }
                case 'editFile': {
                    await this.handleEditFile(data.instruction, data.attachedFiles);
                    break;
                }
                case 'setApiKey': {
                    await this.handleSetApiKey(data.apiKey);
                    break;
                }
                case 'getApiKeyStatus': {
                    await this.sendApiKeyStatus();
                    break;
                }
                case 'clearApiKey': {
                    await this._deepseekService.clearApiKey(this._context);
                    this._view?.webview.postMessage({ type: 'apiKeyStatus', hasKey: false });
                    vscode.window.showInformationMessage('DeepCode: API key cleared.');
                    break;
                }
                case 'getSettings': {
                    await this.sendSettings();
                    break;
                }
                case 'updateSetting': {
                    await this.handleUpdateSetting(data.key, data.value);
                    break;
                }
                case 'getBalance': {
                    await this.handleGetBalance();
                    break;
                }
                case 'clearHistory': {
                    this._deepseekService.clearHistory();
                    this._chatHistory = [];
                    this._view?.webview.postMessage({ type: 'historyCleared' });
                    break;
                }
                case 'stopGeneration': {
                    this._isCancelled = true;
                    break;
                }
                case 'getWorkspaceInfo': {
                    const tree = await this._fileEditorService.getWorkspaceTree();
                    const editorContent = this._fileEditorService.getActiveEditorContent();
                    this._view?.webview.postMessage({
                        type: 'workspaceInfo',
                        tree,
                        activeFile: editorContent?.fileName || 'No file open',
                        language: editorContent?.language || '',
                    });
                    break;
                }
                case 'validateApiKey': {
                    const valid = await this._deepseekService.validateApiKey(data.apiKey);
                    this._view?.webview.postMessage({ type: 'apiKeyValidation', valid });
                    break;
                }
                case 'pickFiles': {
                    const uris = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: true,
                        openLabel: 'Attach Files',
                    });
                    if (uris && uris.length > 0) {
                        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                        const files = uris.map(u => {
                            const rel = u.fsPath.startsWith(workspaceRoot) 
                                ? u.fsPath.slice(workspaceRoot.length + 1) 
                                : u.fsPath;
                            return { path: rel, fullPath: u.fsPath };
                        });
                        this._view?.webview.postMessage({ type: 'filesAttached', files });
                    }
                    break;
                }
                case 'pickFolder': {
                    const folderUris = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        openLabel: 'Attach Folder',
                    });
                    if (folderUris && folderUris.length > 0) {
                        const folderUri = folderUris[0];
                        const files = await this.collectFolderFiles(folderUri, 5);
                        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                        const mapped = files.map(f => {
                            const rel = f.startsWith(workspaceRoot) 
                                ? f.slice(workspaceRoot.length + 1) 
                                : f;
                            return { path: rel, fullPath: f };
                        });
                        this._view?.webview.postMessage({ type: 'filesAttached', files: mapped });
                    }
                    break;
                }
                case 'readAttachedFiles': {
                    const contents = await this.readMultipleFiles(data.files);
                    this._view?.webview.postMessage({ type: 'attachedFileContents', contents });
                    break;
                }
                case 'searchFiles': {
                    const query = (data.query || '').toLowerCase();
                    try {
                        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                        const results: { path: string; fullPath: string; isFolder?: boolean }[] = [];

                        // Find files
                        const found = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 200);
                        for (const f of found) {
                            const rel = f.fsPath.startsWith(workspaceRoot)
                                ? f.fsPath.slice(workspaceRoot.length + 1)
                                : f.fsPath;
                            if (rel.toLowerCase().includes(query)) {
                                results.push({ path: rel, fullPath: f.fsPath });
                            }
                        }

                        // Find matching directories
                        if (workspaceRoot) {
                            const SKIP = new Set(['node_modules', '.git', 'out', 'dist', '__pycache__', '.vscode-test', '.next', 'build']);
                            const dirSet = new Set<string>();
                            for (const f of found) {
                                const rel = f.fsPath.startsWith(workspaceRoot) ? f.fsPath.slice(workspaceRoot.length + 1) : f.fsPath;
                                const parts = rel.split('/');
                                // Collect each directory segment
                                for (let i = 1; i < parts.length; i++) {
                                    const dir = parts.slice(0, i).join('/');
                                    if (!SKIP.has(parts[i - 1])) {
                                        dirSet.add(dir);
                                    }
                                }
                            }
                            for (const dir of dirSet) {
                                if (dir.toLowerCase().includes(query)) {
                                    results.push({
                                        path: dir + '/',
                                        fullPath: workspaceRoot + '/' + dir,
                                        isFolder: true,
                                    });
                                }
                            }
                        }

                        // Sort: folders first, then files; limit to 20
                        results.sort((a, b) => {
                            if (a.isFolder && !b.isFolder) { return -1; }
                            if (!a.isFolder && b.isFolder) { return 1; }
                            return a.path.length - b.path.length;
                        });

                        this._view?.webview.postMessage({ type: 'fileSearchResults', files: results.slice(0, 20) });
                    } catch {
                        this._view?.webview.postMessage({ type: 'fileSearchResults', files: [] });
                    }
                    break;
                }
                case 'expandFolder': {
                    const folderUri = vscode.Uri.file(data.folderPath);
                    const files = await this.collectFolderFiles(folderUri, 3);
                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                    const mapped = files.map(f => {
                        const rel = f.startsWith(workspaceRoot) ? f.slice(workspaceRoot.length + 1) : f;
                        return { path: rel, fullPath: f };
                    });
                    this._view?.webview.postMessage({ type: 'filesAttached', files: mapped });
                    break;
                }
                case 'webSearch': {
                    const query = (data.query || '').trim();
                    if (!query) { break; }
                    this._view?.webview.postMessage({ type: 'agentStatus', status: `Searching web for: ${query}...` });
                    try {
                        const results = await this._subAgentService.webSearch(query);
                        this._view?.webview.postMessage({ type: 'webSearchResults', query, results });
                    } catch (err: any) {
                        this._view?.webview.postMessage({ type: 'webSearchResults', query, results: '', error: err.message });
                    }
                    break;
                }
                case 'saveChat': {
                    const chats: any[] = this._context.globalState.get('deepcode.chatHistory', []);
                    const idx = chats.findIndex((c: any) => c.id === data.chat.id);
                    if (idx >= 0) {
                        chats[idx] = data.chat;
                    } else {
                        chats.unshift(data.chat);
                    }
                    if (chats.length > 50) { chats.length = 50; }
                    await this._context.globalState.update('deepcode.chatHistory', chats);
                    break;
                }
                case 'loadChats': {
                    const allChats: any[] = this._context.globalState.get('deepcode.chatHistory', []);
                    this._view?.webview.postMessage({ type: 'chatList', chats: allChats });
                    break;
                }
                case 'deleteChat': {
                    const stored: any[] = this._context.globalState.get('deepcode.chatHistory', []);
                    const filtered = stored.filter((c: any) => c.id !== data.id);
                    await this._context.globalState.update('deepcode.chatHistory', filtered);
                    this._view?.webview.postMessage({ type: 'chatList', chats: filtered });
                    break;
                }
                case 'approveEdit': {
                    await this.applyPendingEdit();
                    break;
                }
                case 'approveAllEdits': {
                    this._autoApproveEdits = true;
                    await this.applyPendingEdit();
                    break;
                }
                case 'rejectEdit': {
                    this._pendingEdit = null;
                    this._view?.webview.postMessage({ type: 'editCancelled' });
                    break;
                }
            }
        });

        // Send initial state when view becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.sendApiKeyStatus();
                this.sendSettings();
            }
        });
    }

    /**
     * Search workspace files for code related to the file being edited.
     * Extracts key identifiers and searches for their usages in other files.
     */
    private async findRelatedWorkspaceCode(fileContent: string, targetFileName: string): Promise<string> {
        const idRegex = /(?:^|\s)(?:function|class|const|let|var|def|func|interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]{2,})/gm;
        const identifiers = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = idRegex.exec(fileContent)) !== null) {
            identifiers.add(m[1]);
        }
        if (identifiers.size === 0) { return ''; }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const contextParts: string[] = [];

        for (const id of Array.from(identifiers).slice(0, 3)) {
            const results = await this._fileEditorService.searchWorkspaceContent(id, 4);
            for (const result of results) {
                if (result.file === targetFileName) { continue; }
                const relPath = result.file.startsWith(workspaceRoot)
                    ? result.file.slice(workspaceRoot.length + 1)
                    : result.file.split('/').pop() || result.file;
                contextParts.push(`${relPath}:${result.line}:\n${result.preview}`);
            }
        }

        return contextParts.slice(0, 6).join('\n\n');
    }

    /**
     * Detect if the user's message implies they want file edits applied.
     * Works with OR without attached files — if files aren't attached but
     * the message mentions a specific file or editing intent, we'll resolve
     * the file ourselves.
     */
    private looksLikeEditRequest(message: string): boolean {
        const lower = message.toLowerCase();
        // Strong edit-intent verbs / phrases
        const editPatterns = [
            /\b(fix|change|update|modify|edit|replace|rename|refactor|correct|rewrite|remove|delete|add|insert|move|swap|convert|transform|migrate|patch|adjust|set)\b/,
            /\bmake (this|that|the|it|these|those)\b/,
            /\bcan you (fix|change|update|modify|edit|replace|rename|refactor|correct|rewrite|remove|delete|add|insert)\b/,
            /\bplease (fix|change|update|modify|edit|replace|rename|refactor|correct|rewrite|remove|delete|add|insert)\b/,
            /\bapply\b.*\b(change|edit|fix|patch|update)\b/,
            /\b(it'?s wrong|is wrong|is incorrect|is broken|needs? (to be |)(fix|chang|updat))/,
            /\bshould (update|fix|change|edit|modify|correct|replace)\b/,
            /\b(update|fix|change|edit|modify) (it|that|this|the file|the code)\b/,
        ];
        return editPatterns.some(p => p.test(lower));
    }

    /**
     * Resolve file paths from the user's message by searching the workspace.
     * Handles references like "readme file", "README.md", "package.json",
     * "the config file", etc.
     */
    private async resolveFilesFromMessage(message: string): Promise<string[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return []; }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        // Extract explicit file names (with extensions)
        const fileNamePattern = /\b([\w\-\.]+\.\w{1,10})\b/g;
        const candidates: string[] = [];
        let match;
        while ((match = fileNamePattern.exec(message)) !== null) {
            candidates.push(match[1]);
        }

        // Extract natural language file references: "the readme", "readme file", etc.
        const naturalRefs: { keyword: string; glob: string }[] = [
            { keyword: 'readme', glob: '**/README*' },
            { keyword: 'package.json', glob: '**/package.json' },
            { keyword: 'tsconfig', glob: '**/tsconfig*.json' },
            { keyword: 'config', glob: '**/*config*' },
            { keyword: 'gitignore', glob: '**/.gitignore' },
            { keyword: 'env', glob: '**/.env*' },
            { keyword: 'changelog', glob: '**/CHANGELOG*' },
            { keyword: 'license', glob: '**/LICENSE*' },
            { keyword: 'makefile', glob: '**/Makefile' },
            { keyword: 'dockerfile', glob: '**/Dockerfile*' },
        ];

        const lower = message.toLowerCase();
        const resolvedPaths: string[] = [];

        // Search for explicit file name matches
        for (const name of candidates) {
            // Skip very common words that look like filenames but aren't
            if (/^(i\.e|e\.g|vs\.|etc\.)$/i.test(name)) { continue; }
            try {
                const found = await vscode.workspace.findFiles(
                    `**/${name}`,
                    '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}',
                    3
                );
                for (const f of found) {
                    if (!resolvedPaths.includes(f.fsPath)) {
                        resolvedPaths.push(f.fsPath);
                    }
                }
            } catch { /* ignore search errors */ }
        }

        // Search for natural language references
        for (const ref of naturalRefs) {
            if (lower.includes(ref.keyword)) {
                try {
                    const found = await vscode.workspace.findFiles(
                        ref.glob,
                        '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}',
                        3
                    );
                    for (const f of found) {
                        if (!resolvedPaths.includes(f.fsPath)) {
                            resolvedPaths.push(f.fsPath);
                        }
                    }
                } catch { /* ignore */ }
            }
        }

        // Also check conversation history for recently mentioned files
        if (resolvedPaths.length === 0) {
            const recentHistory = this._chatHistory.slice(-6);
            for (const entry of recentHistory) {
                const histMatch = entry.content.match(/\b([\w\-\.]+\.\w{1,10})\b/g);
                if (histMatch) {
                    for (const name of histMatch) {
                        if (/^(i\.e|e\.g|vs\.|etc\.)$/i.test(name)) { continue; }
                        try {
                            const found = await vscode.workspace.findFiles(
                                `**/${name}`,
                                '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}',
                                2
                            );
                            for (const f of found) {
                                if (!resolvedPaths.includes(f.fsPath)) {
                                    resolvedPaths.push(f.fsPath);
                                }
                            }
                        } catch { /* ignore */ }
                    }
                }
            }

            // Check for natural language refs in history too
            for (const ref of naturalRefs) {
                for (const entry of recentHistory) {
                    if (entry.content.toLowerCase().includes(ref.keyword)) {
                        try {
                            const found = await vscode.workspace.findFiles(
                                ref.glob,
                                '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}',
                                2
                            );
                            for (const f of found) {
                                if (!resolvedPaths.includes(f.fsPath)) {
                                    resolvedPaths.push(f.fsPath);
                                }
                            }
                        } catch { /* ignore */ }
                    }
                }
            }
        }

        return resolvedPaths;
    }

    private _toolCallCounter = 0;

    private async handleChatMessage(message: string, attachedFiles?: string[]) {
        const apiKey = await this._deepseekService.getApiKey(this._context);
        if (!apiKey) {
            this._view?.webview.postMessage({
                type: 'error',
                message: 'Please set your DeepSeek API key in settings.',
            });
            return;
        }

        // Handle @web prefix: perform web search and include results as context
        let actualMessage = message;
        let webContext = '';
        const webMatch = message.match(/^@web\s+(.+)/is);
        if (webMatch) {
            actualMessage = webMatch[1].trim();
            this._view?.webview.postMessage({ type: 'agentStatus', status: `Searching web for: ${actualMessage}...` });
            try {
                webContext = await this._subAgentService.webSearch(actualMessage);
            } catch { /* ignore web search errors */ }
        }

        // Smart routing: if the message looks like an edit request, route to
        // the edit handler so changes are actually applied to the file.
        // Skip edit routing when @web prefix is used (user explicitly wants chat + web context).
        if (!webMatch && this.looksLikeEditRequest(actualMessage)) {
            let filesToEdit = attachedFiles && attachedFiles.length > 0 ? attachedFiles : [];

            // If no files were explicitly attached, try to resolve them from the message
            // and conversation history (the AI should find files on its own)
            if (filesToEdit.length === 0) {
                this._view?.webview.postMessage({ type: 'agentStatus', status: 'Resolving target files...' });
                const resolved = await this.resolveFilesFromMessage(message);
                if (resolved.length > 0) {
                    filesToEdit = resolved;
                }
            }

            if (filesToEdit.length > 0) {
                await this.handleEditFile(message, filesToEdit);
                return;
            }
            // If we still can't find files, fall through to chat — the agent
            // will use tools to find and edit files autonomously.
        }

        // Get active editor context
        const editorContent = this._fileEditorService.getActiveEditorContent();
        let context = '';
        if (editorContent) {
            context = `Currently open file: ${editorContent.fileName} (${editorContent.language})`;
            if (editorContent.selection) {
                context += `\n\nSelected code:\n\`\`\`${editorContent.language}\n${editorContent.selection}\n\`\`\``;
            }
        }

        // Read attached files and add to context
        if (attachedFiles && attachedFiles.length > 0) {
            const fileContents = await this.readMultipleFiles(attachedFiles);
            context += '\n\n--- Attached Files ---';
            for (const fc of fileContents) {
                const ext = fc.path.split('.').pop() || '';
                context += `\n\nFile: ${fc.path}\n\`\`\`${ext}\n${fc.content}\n\`\`\``;
            }
        }

        // Build conversation context from recent history
        if (this._chatHistory.length > 0) {
            const recent = this._chatHistory.slice(-10);
            context += '\n\n--- Conversation History ---\n' + recent.map(m => `[${m.role}]: ${m.content.substring(0, 500)}`).join('\n') + '\n---';
        }

        // Include web search results in context when @web prefix was used
        if (webContext) {
            context += `\n\n--- Web Search Results for "${actualMessage}" ---\n${webContext}\n---`;
        }

        this._isCancelled = false;
        this._chatHistory.push({ role: 'user', content: actualMessage });

        this._view?.webview.postMessage({ type: 'streamStart' });

        try {
            const cfg = this._deepseekService.getConfig();
            let streamedTokens = false;

            // Use the full agentic tool-use loop with real-time visibility
            const result = await this._subAgentService.runAgentLoop(
                apiKey,
                cfg.model,
                actualMessage,
                context,
                cfg.temperature,
                cfg.topP,
                attachedFiles,
                undefined, // conversationHistory — managed separately
                // onStatus
                (status) => {
                    this._view?.webview.postMessage({ type: 'agentStatus', status });
                },
                // onToolCall — real-time tool call visibility
                (toolName, args) => {
                    this._toolCallCounter++;
                    this._view?.webview.postMessage({
                        type: 'toolCall',
                        name: toolName,
                        args,
                        callId: this._toolCallCounter,
                    });
                },
                // onToolResult — tool completion feedback
                (toolName, toolResult) => {
                    this._view?.webview.postMessage({
                        type: 'toolResult',
                        name: toolName,
                        success: toolResult.success,
                        output: toolResult.output,
                        callId: this._toolCallCounter,
                    });
                },
                // checkCancelled
                () => this._isCancelled,
                // onToken — real-time streaming of final response
                (token) => {
                    streamedTokens = true;
                    this._view?.webview.postMessage({ type: 'streamToken', token });
                },
            );

            // If streaming didn't already send tokens, send the full content
            if (!streamedTokens) {
                const content = result.content;
                const chunkSize = 40;
                for (let i = 0; i < content.length; i += chunkSize) {
                    const chunk = content.substring(i, i + chunkSize);
                    this._view?.webview.postMessage({ type: 'streamToken', token: chunk });
                    await new Promise(r => setTimeout(r, 5));
                }
            }

            this._chatHistory.push({ role: 'assistant', content: result.content });

            // Build agent summary for UI
            const agentsUsed: string[] = ['logic'];
            if (result.toolCalls.length > 0) { agentsUsed.push('tools'); }
            if (result.subAgentResults.length > 0) { agentsUsed.push('subagents'); }

            this._view?.webview.postMessage({
                type: 'streamEnd',
                usage: { total_tokens: result.totalTokens, prompt_tokens: 0, completion_tokens: 0 },
                agentsUsed,
                toolCallCount: result.toolCalls.length,
                iterations: result.iterations,
                subAgentCount: result.subAgentResults.length,
            });
        } catch (error: any) {
            if (this._isCancelled) {
                this._view?.webview.postMessage({ type: 'generationStopped' });
                return;
            }
            this._view?.webview.postMessage({
                type: 'error',
                message: error.message || 'An error occurred while processing your request.',
            });
        }
    }

    private async handleEditFile(instruction: string, attachedFiles?: string[]) {
        const apiKey = await this._deepseekService.getApiKey(this._context);
        if (!apiKey) {
            this._view?.webview.postMessage({
                type: 'error',
                message: 'Please set your DeepSeek API key first.',
            });
            return;
        }

        // Determine the target file to edit.
        // Smart logic: among attached files, pick the first editable text file
        // as the edit target. Binary/image files become context references.
        // If the instruction mentions a specific file name, prefer that.
        let targetDocument: vscode.TextDocument | undefined;
        let targetContent: string | undefined;
        let targetFileName: string | undefined;
        let targetSelection: string | undefined;
        let extraContextFiles: string[] = [];

        if (attachedFiles && attachedFiles.length > 0) {
            // Separate editable text files from binary/context-only files
            const editablePaths = attachedFiles.filter(f => this.isEditableTextFile(f));
            const contextOnlyPaths = attachedFiles.filter(f => this.isBinaryFile(f));

            // Try to pick the best edit target from editable files
            let bestTarget: string | undefined;

            if (editablePaths.length === 1) {
                bestTarget = editablePaths[0];
            } else if (editablePaths.length > 1) {
                // If instruction mentions a specific file name, use that
                const lowerInstruction = instruction.toLowerCase();
                bestTarget = editablePaths.find(f => {
                    const name = (f.split('/').pop() || '').toLowerCase();
                    return lowerInstruction.includes(name);
                });
                // Fallback: first editable file
                if (!bestTarget) { bestTarget = editablePaths[0]; }
                // Rest become context files
                extraContextFiles = [...editablePaths.filter(f => f !== bestTarget), ...contextOnlyPaths];
            }

            if (bestTarget) {
                const targetUri = vscode.Uri.file(bestTarget);
                try {
                    const doc = await vscode.workspace.openTextDocument(targetUri);
                    await vscode.window.showTextDocument(doc, { preview: false });
                    targetDocument = doc;
                    targetContent = doc.getText();
                    targetFileName = doc.fileName;
                    // Any remaining files (including binary) are context
                    if (extraContextFiles.length === 0) {
                        extraContextFiles = [...contextOnlyPaths];
                    }
                } catch {
                    this._view?.webview.postMessage({
                        type: 'error',
                        message: `Could not open file: ${bestTarget}`,
                    });
                    return;
                }
            } else {
                // All attached files are binary — fall back to active editor, use files as context
                const editorContent = this._fileEditorService.getActiveEditorContent();
                if (!editorContent) {
                    this._view?.webview.postMessage({
                        type: 'error',
                        message: 'No editable text file attached and no file open in the editor.',
                    });
                    return;
                }
                targetDocument = vscode.window.activeTextEditor?.document;
                targetContent = editorContent.content;
                targetFileName = editorContent.fileName;
                targetSelection = editorContent.selection;
                extraContextFiles = attachedFiles;
            }
        } else {
            // No attached files — use active editor
            const editorContent = this._fileEditorService.getActiveEditorContent();
            if (!editorContent) {
                this._view?.webview.postMessage({
                    type: 'error',
                    message: 'No file is currently open in the editor.',
                });
                return;
            }
            targetDocument = vscode.window.activeTextEditor?.document;
            targetContent = editorContent.content;
            targetFileName = editorContent.fileName;
            targetSelection = editorContent.selection;
        }

        if (!targetDocument || !targetContent || !targetFileName) {
            this._view?.webview.postMessage({
                type: 'error',
                message: 'Could not determine the target file to edit.',
            });
            return;
        }

        // Build extra context from additional attached files
        let extraInstruction = instruction;
        if (extraContextFiles.length > 0) {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            const fileContents = await this.readMultipleFiles(extraContextFiles);
            
            // Separate text content from binary file references
            const textFiles: typeof fileContents = [];
            const binaryFiles: string[] = [];
            
            for (const fc of fileContents) {
                if (fc.content.startsWith('[Binary file:')) {
                    // Compute relative path from workspace root for image references
                    const relPath = fc.path.startsWith(workspaceRoot)
                        ? fc.path.slice(workspaceRoot.length + 1)
                        : fc.path.split('/').pop() || fc.path;
                    binaryFiles.push(relPath);
                } else {
                    textFiles.push(fc);
                }
            }

            if (textFiles.length > 0) {
                extraInstruction += '\n\nReference files:\n';
                for (const fc of textFiles) {
                    const ext = fc.path.split('.').pop() || '';
                    extraInstruction += `\nFile: ${fc.path}\n\`\`\`${ext}\n${fc.content}\n\`\`\`\n`;
                }
            }

            if (binaryFiles.length > 0) {
                extraInstruction += '\n\nAvailable image/asset files (use these relative paths in markdown):\n';
                for (const relPath of binaryFiles) {
                    extraInstruction += `- ${relPath}\n`;
                }
            }
        }

        this._isCancelled = false;
        this._view?.webview.postMessage({ type: 'editStart' });

        // Search workspace for related code to enrich edit context
        this._view?.webview.postMessage({ type: 'agentStatus', status: 'Searching workspace for related code...' });
        const relatedCode = await this.findRelatedWorkspaceCode(targetContent, targetFileName);
        if (relatedCode) {
            extraInstruction += '\n\nRelated workspace code (for reference):\n' + relatedCode;
        }

        try {
            const cfg = this._deepseekService.getConfig();

            // Use multi-agent orchestration for edits
            const result = await this._subAgentService.orchestrateEdit(
                apiKey,
                cfg.model,
                targetContent,
                targetFileName,
                extraInstruction,
                targetSelection,
                cfg.temperature,
                cfg.topP,
                (status) => {
                    this._view?.webview.postMessage({ type: 'agentStatus', status });
                },
                () => this._isCancelled,
            );

            const editResult = result.editResult || this._fileEditorService.parseEditResponse(result.content);

            // Store pending edit for approval
            this._pendingEdit = {
                editResult,
                targetDocument,
                agentsUsed: result.agentsUsed,
                totalTokens: result.totalTokens,
            };

            // If auto-approve is on, apply immediately
            if (this._autoApproveEdits) {
                await this.applyPendingEdit();
                return;
            }

            // Otherwise, send proposal to webview for inline approval
            const shortName = targetFileName.split('/').pop() || targetFileName;
            this._view?.webview.postMessage({
                type: 'editProposal',
                fileName: shortName,
                editCount: editResult.edits.length,
                explanation: editResult.explanation,
                agentsUsed: result.agentsUsed,
                edits: editResult.edits.map(e => ({
                    oldText: e.oldText,
                    newText: e.newText,
                })),
                language: targetFileName.split('.').pop() || '',
            });
        } catch (error: any) {
            this._view?.webview.postMessage({
                type: 'error',
                message: `Edit failed: ${error.message}`,
            });
        }
    }

    /**
     * Apply the pending edit (called from inline approval or auto-approve).
     */
    private async applyPendingEdit() {
        const pending = this._pendingEdit;
        if (!pending) {
            this._view?.webview.postMessage({ type: 'error', message: 'No pending edit to apply.' });
            return;
        }
        this._pendingEdit = null;

        const { editResult, targetDocument, agentsUsed, totalTokens } = pending;

        try {
            // Open the document without showing it — applyEdits handles everything
            const doc = await vscode.workspace.openTextDocument(targetDocument.uri);

            const success = await this._fileEditorService.applyEdits(doc, editResult);
            this._view?.webview.postMessage({
                type: 'editComplete',
                success,
                explanation: editResult.explanation,
                agentsUsed,
                totalTokens,
            });
        } catch (error: any) {
            this._view?.webview.postMessage({
                type: 'error',
                message: `Failed to apply edit: ${error.message}`,
            });
        }
    }

    private async handleSetApiKey(apiKey: string) {
        if (!apiKey || apiKey.trim().length === 0) {
            this._view?.webview.postMessage({
                type: 'error',
                message: 'API key cannot be empty.',
            });
            return;
        }

        await this._deepseekService.setApiKey(this._context, apiKey.trim());
        this._view?.webview.postMessage({ type: 'apiKeyStatus', hasKey: true });
        vscode.window.showInformationMessage('DeepCode: API key saved securely.');
    }

    private async sendApiKeyStatus() {
        const apiKey = await this._deepseekService.getApiKey(this._context);
        this._view?.webview.postMessage({
            type: 'apiKeyStatus',
            hasKey: !!apiKey,
        });
    }

    private async sendSettings() {
        const config = this._deepseekService.getConfig();
        this._view?.webview.postMessage({
            type: 'settings',
            settings: config,
        });
    }

    private async handleUpdateSetting(key: string, value: any) {
        const config = vscode.workspace.getConfiguration('deepcode');
        try {
            await config.update(key, value, vscode.ConfigurationTarget.Global);
            this._view?.webview.postMessage({
                type: 'settingUpdated',
                key,
                value,
            });
        } catch (error: any) {
            this._view?.webview.postMessage({
                type: 'error',
                message: `Failed to update setting: ${error.message}`,
            });
        }
    }

    private async handleGetBalance() {
        const apiKey = await this._deepseekService.getApiKey(this._context);
        if (!apiKey) {
            this._view?.webview.postMessage({
                type: 'balance',
                balance: null,
                error: 'No API key set',
            });
            return;
        }

        const balance = await this._deepseekService.getBalance(apiKey);
        this._view?.webview.postMessage({
            type: 'balance',
            balance,
        });
    }

    public postMessage(message: any) {
        this._view?.webview.postMessage(message);
    }

    private async collectFolderFiles(folderUri: vscode.Uri, maxDepth: number): Promise<string[]> {
        const files: string[] = [];
        const SKIP = new Set(['node_modules', '.git', 'out', 'dist', '__pycache__', '.vscode-test', '.next', 'build']);
        const MAX_FILES = 50;

        const walk = async (uri: vscode.Uri, depth: number) => {
            if (depth <= 0 || files.length >= MAX_FILES) { return; }
            try {
                const entries = await vscode.workspace.fs.readDirectory(uri);
                for (const [name, type] of entries) {
                    if (files.length >= MAX_FILES) { break; }
                    if (name.startsWith('.')) { continue; }
                    const childUri = vscode.Uri.joinPath(uri, name);
                    if (type === vscode.FileType.Directory) {
                        if (!SKIP.has(name)) {
                            await walk(childUri, depth - 1);
                        }
                    } else if (type === vscode.FileType.File) {
                        files.push(childUri.fsPath);
                    }
                }
            } catch { /* skip unreadable dirs */ }
        };

        await walk(folderUri, maxDepth);
        return files;
    }

    /**
     * Check if a file is binary/non-text based on extension.
     */
    private isBinaryFile(filePath: string): boolean {
        const BINARY_EXTS = new Set([
            'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp', 'avif',
            'mp3', 'mp4', 'wav', 'ogg', 'webm', 'avi', 'mov', 'mkv',
            'zip', 'gz', 'tar', 'bz2', 'rar', '7z', 'jar',
            'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
            'ttf', 'otf', 'woff', 'woff2', 'eot',
            'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite',
            'pyc', 'class', 'o', 'obj', 'wasm',
        ]);
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        return BINARY_EXTS.has(ext);
    }

    /**
     * Check if a file is an editable text file (not binary/image).
     */
    private isEditableTextFile(filePath: string): boolean {
        return !this.isBinaryFile(filePath);
    }

    private async readMultipleFiles(filePaths: string[]): Promise<{ path: string; content: string }[]> {
        const results: { path: string; content: string }[] = [];
        for (const fp of filePaths) {
            // Skip binary files — just list them as references
            if (this.isBinaryFile(fp)) {
                const name = fp.split('/').pop() || fp;
                results.push({ path: fp, content: `[Binary file: ${name} — not readable as text]` });
                continue;
            }
            try {
                const uri = vscode.Uri.file(fp);
                const bytes = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(bytes).toString('utf-8');
                // Check for actual binary content (NUL bytes in first 8KB)
                const sample = content.substring(0, 8192);
                if (sample.includes('\0') || sample.includes('\ufffd')) {
                    const name = fp.split('/').pop() || fp;
                    results.push({ path: fp, content: `[Binary file: ${name} — not readable as text]` });
                    continue;
                }
                // Skip very large files
                if (content.length > 100000) {
                    results.push({ path: fp, content: `[File too large: ${(content.length / 1024).toFixed(0)}KB - truncated]\n${content.substring(0, 5000)}\n...` });
                } else {
                    results.push({ path: fp, content });
                }
            } catch {
                results.push({ path: fp, content: '[Could not read file]' });
            }
        }
        return results;
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();

        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>DeepCode</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        :root {
            --dc-font-size: 8px;
            --dc-font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
            --dc-editor-font: var(--vscode-editor-font-family, 'Menlo', 'Consolas', 'Courier New', monospace);
            --dc-editor-font-size: 8px;
        }

        body {
            font-family: var(--dc-font-family);
            font-size: var(--dc-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            line-height: 1.4;
            position: relative;
        }

        /* ── Chat Container ─────────────────────────────── */
        .chat-container {
            display: flex;
            flex: 1;
            flex-direction: column;
            overflow: hidden;
        }

        .chat-messages {
            flex: 1;
            overflow-y: auto;
            padding: 0;
            display: flex;
            flex-direction: column;
        }

        /* ── Messages — editor-like appearance ──────────── */
        .message {
            padding: 8px 16px;
            font-size: var(--dc-editor-font-size);
            line-height: 1.6;
            word-wrap: break-word;
            white-space: pre-wrap;
            color: var(--vscode-foreground);
            font-family: var(--dc-editor-font);
            border-bottom: 1px solid var(--vscode-editorGroup-border, transparent);
        }

        .message.user {
            background: var(--vscode-editor-background);
            padding: 10px 16px 8px;
            position: relative;
        }

        .message.user::before {
            content: 'You';
            display: block;
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            font-family: var(--dc-font-family);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .message.assistant {
            background: var(--vscode-editorInlayHint-background, var(--vscode-editor-background));
            padding: 10px 16px 8px;
            position: relative;
        }

        .message.assistant::before {
            content: 'DeepCode';
            display: block;
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
            margin-bottom: 4px;
            font-family: var(--dc-font-family);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .message.error {
            color: var(--vscode-errorForeground);
            font-size: var(--dc-editor-font-size);
            background: var(--vscode-inputValidation-errorBackground, transparent);
            border-left: 3px solid var(--vscode-errorForeground);
            padding-left: 13px;
        }

        .message.system {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            font-family: var(--dc-font-family);
            padding: 4px 16px;
            background: transparent;
            border-bottom: none;
        }

        /* Inline code */
        .message code {
            background: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground, #ce9178);
            padding: 1px 5px;
            border-radius: 3px;
            font-family: var(--dc-editor-font);
            font-size: var(--dc-editor-font-size);
            border: 1px solid var(--vscode-editorGroup-border, transparent);
        }

        /* Code blocks — styled like VS Code editor */
        .message pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 10px 12px;
            border-radius: 3px;
            overflow-x: auto;
            margin: 8px 0;
            border: 1px solid var(--vscode-editorGroup-border, transparent);
            line-height: 1.5;
        }

        .message pre code {
            padding: 0;
            background: none;
            border: none;
            font-size: var(--dc-editor-font-size);
        }

        /* ── Chat Input — editor-style textarea ─────────── */

        /* ── Inline Edit Proposal ───────────────────────── */
        .edit-proposal {
            background: var(--vscode-editorInlayHint-background, var(--vscode-editor-background));
            border: 1px solid var(--vscode-focusBorder);
            border-radius: 4px;
            margin: 8px 12px;
            padding: 10px 14px;
            font-family: var(--dc-font-family);
            font-size: 12px;
        }

        .edit-proposal-header {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 6px;
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .edit-proposal-file {
            color: var(--vscode-foreground);
            font-family: var(--dc-editor-font);
            font-size: var(--dc-editor-font-size);
            font-weight: normal;
            text-transform: none;
            letter-spacing: 0;
        }

        .edit-proposal-explanation {
            color: var(--vscode-foreground);
            margin-bottom: 8px;
            line-height: 1.5;
        }

        .edit-proposal-diff {
            background: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-editorGroup-border, transparent);
            border-radius: 3px;
            padding: 0;
            margin-bottom: 10px;
            font-family: var(--dc-editor-font);
            font-size: var(--dc-editor-font-size);
            overflow-x: auto;
            max-height: 300px;
            overflow-y: auto;
        }

        .diff-header {
            padding: 4px 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.04));
            border-bottom: 1px solid var(--vscode-editorGroup-border, transparent);
            font-family: var(--dc-editor-font);
        }

        .diff-line {
            display: flex;
            line-height: 1.6;
            min-height: 18px;
        }

        .diff-line-num {
            display: inline-block;
            min-width: 32px;
            padding: 0 6px;
            text-align: right;
            color: var(--vscode-editorLineNumber-foreground, #858585);
            user-select: none;
            flex-shrink: 0;
            font-size: var(--dc-editor-font-size);
        }

        .diff-line-sign {
            display: inline-block;
            width: 14px;
            text-align: center;
            flex-shrink: 0;
            user-select: none;
            font-weight: 700;
        }

        .diff-line-content {
            flex: 1;
            padding-right: 8px;
            white-space: pre-wrap;
            word-break: break-all;
        }

        .diff-line.diff-added {
            background: var(--vscode-diffEditor-insertedLineBackground, rgba(115, 201, 145, 0.15));
        }

        .diff-line.diff-added .diff-line-sign {
            color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
        }

        .diff-line.diff-removed {
            background: var(--vscode-diffEditor-removedLineBackground, rgba(244, 71, 71, 0.15));
        }

        .diff-line.diff-removed .diff-line-sign {
            color: var(--vscode-gitDecoration-deletedResourceForeground, #f44747);
        }

        .diff-line.diff-context {
            background: transparent;
        }

        .diff-line.diff-context .diff-line-sign {
            color: transparent;
        }

        .diff-old {
            color: var(--vscode-gitDecoration-deletedResourceForeground, #f44747);
            text-decoration: line-through;
            opacity: 0.8;
        }

        .diff-new {
            color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
        }

        /* ── Code syntax highlighting tokens ──────────── */
        .tok-keyword { color: var(--vscode-debugTokenExpression-name, #569cd6); }
        .tok-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
        .tok-number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
        .tok-comment { color: var(--vscode-editorLineNumber-foreground, #6a9955); font-style: italic; }
        .tok-function { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
        .tok-type { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
        .tok-operator { color: var(--vscode-foreground); }
        .tok-punctuation { color: var(--vscode-foreground); }
        .tok-property { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
        .tok-builtin { color: var(--vscode-debugTokenExpression-name, #4fc1ff); }
        .tok-tag { color: var(--vscode-debugTokenExpression-name, #569cd6); }
        .tok-attr-name { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
        .tok-attr-value { color: var(--vscode-debugTokenExpression-string, #ce9178); }

        .code-block-wrapper {
            position: relative;
        }

        .code-lang-label {
            position: absolute;
            top: 0;
            right: 0;
            padding: 1px 8px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.06));
            border-bottom-left-radius: 3px;
            font-family: var(--dc-font-family);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            user-select: none;
        }

        .code-block-wrapper pre {
            margin: 0;
        }

        .edit-proposal-actions {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }

        .edit-proposal-actions button {
            padding: 4px 12px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            border: 1px solid transparent;
        }

        .btn-apply {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .btn-apply:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .btn-apply-all {
            background: transparent;
            color: var(--vscode-textLink-foreground);
            border-color: var(--vscode-textLink-foreground) !important;
        }

        .btn-apply-all:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }

        .btn-reject {
            background: transparent;
            color: var(--vscode-descriptionForeground);
        }

        .btn-reject:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-errorForeground);
        }

        .chat-input-area {
            padding: 8px 12px;
            border-top: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border));
            flex-shrink: 0;
            background: var(--vscode-editor-background);
        }

        .chat-textarea {
            width: 100%;
            min-height: 54px;
            max-height: 150px;
            resize: vertical;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 3px;
            padding: 8px 10px;
            font-family: var(--dc-editor-font);
            font-size: var(--dc-editor-font-size);
            line-height: 1.5;
            outline: none;
        }

        .chat-textarea:focus {
            border-color: var(--vscode-focusBorder);
        }

        .chat-textarea::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        .action-buttons {
            display: flex;
            gap: 2px;
            align-items: center;
            margin-top: 6px;
        }

        /* ── Buttons — VS Code native ───────────────────── */
        button {
            background: transparent;
            color: var(--vscode-foreground);
            border: none;
            padding: 4px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: var(--dc-font-size);
            font-family: var(--dc-font-family);
            white-space: nowrap;
            line-height: 1.4;
        }

        button:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }

        button:disabled { opacity: 0.4; cursor: not-allowed; }

        button.secondary {
            background: transparent;
            color: var(--vscode-foreground);
        }

        button.danger {
            color: var(--vscode-errorForeground);
        }

        button.danger:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }

        button.small {
            padding: 3px 6px;
            font-size: 11px;
        }

        /* ── Settings Panel ─────────────────────────────── */

        .settings-group {
            margin-bottom: 16px;
        }

        .settings-group h3 {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 10px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border));
            padding-bottom: 4px;
            font-weight: 600;
        }

        .setting-item {
            margin-bottom: 12px;
        }

        .setting-item label {
            display: block;
            font-size: var(--dc-font-size);
            margin-bottom: 3px;
            color: var(--vscode-foreground);
        }

        .setting-item .description {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }

        .setting-item input[type="text"],
        .setting-item input[type="number"],
        .setting-item input[type="password"],
        .setting-item select,
        .setting-item textarea {
            width: 100%;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 3px;
            padding: 4px 8px;
            font-family: var(--dc-font-family);
            font-size: var(--dc-font-size);
            outline: none;
        }

        .setting-item select {
            cursor: pointer;
            appearance: none;
            -webkit-appearance: none;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 8px center;
            padding-right: 24px;
        }

        .setting-item input:focus,
        .setting-item select:focus,
        .setting-item textarea:focus {
            border-color: var(--vscode-focusBorder);
        }

        .setting-item textarea {
            min-height: 60px;
            resize: vertical;
        }

        /* Range sliders — VS Code style */
        .setting-item input[type="range"] {
            -webkit-appearance: none;
            appearance: none;
            width: 100%;
            height: 4px;
            background: var(--vscode-input-background);
            border-radius: 2px;
            outline: none;
            border: none;
            margin: 8px 0;
        }

        .setting-item input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 14px;
            height: 14px;
            background: var(--vscode-focusBorder, #007acc);
            border-radius: 50%;
            cursor: pointer;
            border: none;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }

        .setting-item input[type="range"]::-webkit-slider-thumb:hover {
            background: var(--vscode-textLink-activeForeground, var(--vscode-focusBorder));
            transform: scale(1.15);
        }

        .setting-item input[type="range"]:focus::-webkit-slider-thumb {
            box-shadow: 0 0 0 2px var(--vscode-focusBorder);
        }

        /* Toggle switches */
        .toggle-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .toggle {
            position: relative;
            width: 36px;
            height: 20px;
            flex-shrink: 0;
        }

        .toggle input { opacity: 0; width: 0; height: 0; }

        .toggle-slider {
            position: absolute;
            cursor: pointer;
            top: 0; left: 0; right: 0; bottom: 0;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 10px;
            transition: 0.15s;
        }

        .toggle-slider:before {
            content: "";
            position: absolute;
            height: 14px;
            width: 14px;
            left: 2px;
            bottom: 2px;
            background: var(--vscode-descriptionForeground);
            border-radius: 50%;
            transition: 0.15s;
        }

        .toggle input:checked + .toggle-slider {
            background: var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }

        .toggle input:checked + .toggle-slider:before {
            transform: translateX(16px);
            background: var(--vscode-editor-background);
        }

        /* ── Account Panel ──────────────────────────────── */

        .account-section {
            margin-bottom: 20px;
        }

        .account-section h3 {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 10px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border));
            padding-bottom: 4px;
            font-weight: 600;
        }

        .api-key-input-group {
            display: flex;
            gap: 4px;
            margin-bottom: 6px;
        }

        .api-key-input-group input {
            flex: 1;
            min-width: 0;
        }

        .status-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: var(--dc-font-size);
            padding: 6px 10px;
            border-radius: 3px;
            background: var(--vscode-textCodeBlock-background);
            margin-bottom: 10px;
            border: 1px solid var(--vscode-editorGroup-border, transparent);
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            flex-shrink: 0;
        }

        .status-dot.connected { background: var(--vscode-testing-iconPassed, #4ec9b0); }
        .status-dot.disconnected { background: var(--vscode-errorForeground); }

        .balance-info {
            padding: 8px 10px;
            background: var(--vscode-textCodeBlock-background);
            border-radius: 3px;
            border: 1px solid var(--vscode-editorGroup-border, transparent);
        }

        .balance-row {
            display: flex;
            justify-content: space-between;
            padding: 3px 0;
            font-size: var(--dc-font-size);
        }

        .balance-label { color: var(--vscode-descriptionForeground); }
        .balance-value { font-weight: 600; }

        /* ── Loading indicator ──────────────────────────── */
        .typing-indicator {
            display: inline-flex;
            gap: 4px;
            padding: 4px 0;
        }

        .typing-indicator span {
            width: 5px;
            height: 5px;
            background: var(--vscode-foreground);
            opacity: 0.3;
            border-radius: 50%;
            animation: bounce 1.4s ease-in-out infinite;
        }

        .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
        .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

        @keyframes bounce {
            0%, 60%, 100% { transform: translateY(0); }
            30% { transform: translateY(-4px); }
        }

        /* ── Welcome card — clean, editor-native ────────── */
        .welcome-card {
            padding: 24px 16px;
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            gap: 8px;
        }

        .welcome-icon {
            width: 32px;
            height: 32px;
            color: var(--vscode-textLink-foreground);
            margin-bottom: 4px;
        }

        .welcome-card h2 {
            font-size: 14px;
            margin-bottom: 0;
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .welcome-card p {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.6;
            max-width: 260px;
        }

        .welcome-card kbd {
            display: inline-block;
            padding: 1px 5px;
            font-size: 11px;
            font-family: var(--dc-editor-font);
            background: var(--vscode-keybindingLabel-background, var(--vscode-textCodeBlock-background));
            color: var(--vscode-keybindingLabel-foreground, var(--vscode-foreground));
            border: 1px solid var(--vscode-keybindingLabel-border, var(--vscode-editorGroup-border, transparent));
            border-radius: 3px;
            box-shadow: 0 1px 0 var(--vscode-keybindingLabel-bottomBorder, transparent);
        }

        /* ── Agent badges ───────────────────────────────── */
        .agent-badges {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-bottom: 4px;
        }

        .agent-badge {
            display: inline-block;
            padding: 1px 6px;
            border-radius: 3px;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-family: var(--dc-font-family);
            font-weight: 600;
        }

        /* ── Inline activity feed ──────────────────────── */
        .activity-feed {
            margin: 2px 0 6px;
            padding: 0;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .activity-feed.collapsed {
            display: none;
        }

        .activity-step {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 3px 0;
            opacity: 0.5;
            transition: opacity 0.3s;
            line-height: 1.3;
        }

        .activity-step.current {
            opacity: 1;
            color: var(--vscode-foreground);
        }

        .activity-step .step-icon {
            flex-shrink: 0;
            width: 14px;
            height: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .activity-step .step-icon svg {
            width: 12px;
            height: 12px;
            fill: none;
            stroke: currentColor;
            stroke-width: 1.5;
            stroke-linecap: round;
            stroke-linejoin: round;
        }

        .activity-step .step-icon.spinning svg {
            animation: spin 0.8s linear infinite;
            color: var(--vscode-textLink-foreground);
        }

        .activity-step .step-icon.done svg {
            color: var(--vscode-testing-iconPassed, #73c991);
        }

        .activity-step .step-text {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .activity-step .step-time {
            flex-shrink: 0;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.7;
            font-variant-numeric: tabular-nums;
        }

        .activity-feed-summary {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin: 2px 0 6px;
            cursor: pointer;
            user-select: none;
            padding: 2px 4px;
            border-radius: 3px;
        }

        .activity-feed-summary:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-foreground);
        }

        .activity-feed-summary svg {
            width: 10px;
            height: 10px;
            fill: none;
            stroke: currentColor;
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
            transition: transform 0.15s;
        }

        .activity-feed-summary.expanded-summary svg {
            transform: rotate(90deg);
        }

        .process-bar .elapsed-time {
            margin-left: auto;
            font-variant-numeric: tabular-nums;
            opacity: 0.7;
            font-size: 10px;
        }

        /* ── Tool call blocks ───────────────────────────── */
        .tool-calls-container {
            margin: 4px 0;
            padding: 0;
        }

        .tool-call-block {
            border: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border));
            border-radius: 4px;
            margin: 3px 0;
            overflow: hidden;
            font-size: 11px;
        }

        .tool-call-header {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 8px;
            background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.04));
            cursor: pointer;
            user-select: none;
        }

        .tool-call-header:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .tool-call-icon {
            flex-shrink: 0;
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--vscode-descriptionForeground);
        }

        .tool-call-icon svg {
            width: 14px;
            height: 14px;
            fill: none;
            stroke: currentColor;
            stroke-width: 1.5;
            stroke-linecap: round;
            stroke-linejoin: round;
        }

        .tool-call-icon.spinning svg {
            animation: spin 1s linear infinite;
            color: var(--vscode-textLink-foreground);
        }

        .tool-call-icon.tool-call-status-success {
            color: var(--vscode-testing-iconPassed, #73c991);
        }

        .tool-call-icon.tool-call-status-fail {
            color: var(--vscode-testing-iconFailed, #f14c4c);
        }

        .tool-call-name {
            font-weight: 600;
            font-family: var(--dc-editor-font);
            color: var(--vscode-textLink-foreground);
        }

        .tool-call-summary {
            color: var(--vscode-descriptionForeground);
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .tool-call-chevron {
            flex-shrink: 0;
            color: var(--vscode-descriptionForeground);
            width: 12px;
            height: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: transform 0.15s;
        }

        .tool-call-chevron svg {
            width: 10px;
            height: 10px;
            fill: none;
            stroke: currentColor;
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
        }

        .tool-call-block.expanded .tool-call-chevron {
            transform: rotate(90deg);
        }

        .tool-call-details {
            display: none;
            padding: 6px 8px;
            border-top: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border));
            font-family: var(--dc-editor-font);
            font-size: var(--dc-editor-font-size);
            white-space: pre-wrap;
            word-break: break-all;
            max-height: 200px;
            overflow-y: auto;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-editor-background);
        }

        .tool-call-block.expanded .tool-call-details {
            display: block;
        }

        /* (tool status colors are on .tool-call-icon above) */

        .subagent-block {
            border-left: 2px solid var(--vscode-textLink-foreground);
            margin: 4px 0;
            padding: 4px 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .subagent-block .subagent-label {
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
        }

        .tool-calls-toggle {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            margin: 4px 0;
            user-select: none;
            padding: 2px 4px;
            border-radius: 3px;
        }

        .tool-calls-toggle:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-foreground);
        }

        /* ── Attached files bar ─────────────────────────── */
        .attached-files-bar {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            padding: 4px 0;
            max-height: 80px;
            overflow-y: auto;
        }

        .file-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            background: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border));
            border-radius: 3px;
            padding: 2px 8px;
            font-size: 11px;
            font-family: var(--dc-editor-font);
            max-width: 200px;
        }

        .file-chip .name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .file-chip .remove {
            cursor: pointer;
            opacity: 0.4;
            font-size: 12px;
            line-height: 1;
        }

        .file-chip .remove:hover { opacity: 1; }

        /* ── Scrollbar — VS Code standard ───────────────── */
        ::-webkit-scrollbar { width: 10px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 0;
            border: 2px solid transparent;
            background-clip: padding-box;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
            background-clip: padding-box;
        }
        ::-webkit-scrollbar-thumb:active {
            background: var(--vscode-scrollbarSlider-activeBackground);
            background-clip: padding-box;
        }

        .hidden { display: none !important; }

        /* ── Settings Modal ─────────────────────────────── */
        .modal-overlay {
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            z-index: 1000;
        }

        .modal {
            background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            flex: 1;
            overflow: hidden;
            min-height: 0;
        }

        .modal-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border));
            flex-shrink: 0;
            background: var(--vscode-editor-background);
        }

        .modal-header h3 {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-foreground);
        }

        .modal-close {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            font-size: 16px;
            cursor: pointer;
            opacity: 0.5;
            padding: 2px 6px;
            border-radius: 3px;
        }

        .modal-close:hover {
            opacity: 1;
            background: var(--vscode-toolbar-hoverBackground);
        }

        .modal-body {
            display: flex;
            flex: 1;
            overflow: hidden;
            min-height: 0;
        }

        .modal-sidebar {
            display: flex;
            flex-direction: column;
            border-right: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border));
            width: 40px;
            flex-shrink: 0;
            padding: 4px 0;
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
            overflow: hidden;
        }

        .modal-tab {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            padding: 8px 0;
            text-align: center;
            cursor: pointer;
            font-size: 11px;
            font-family: var(--dc-font-family);
            border-left: 2px solid transparent;
            opacity: 0.5;
            transition: all 0.1s;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .modal-tab .btn-icon {
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .modal-tab .btn-icon svg {
            width: 16px !important;
            height: 16px !important;
        }

        /* Hide text labels in tabs — icon only in compact sidebar */
        .modal-tab .btn-icon {
            font-size: 0;
            gap: 0;
        }

        .modal-tab:hover {
            opacity: 1;
            background: var(--vscode-list-hoverBackground);
        }

        .modal-tab.active {
            opacity: 1;
            border-left-color: var(--vscode-focusBorder);
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
        }

        .modal-content {
            flex: 1;
            overflow-y: auto;
            min-width: 0;
            min-height: 0;
        }

        .mtab-content {
            display: none;
            height: 100%;
        }
        .mtab-content.active {
            display: flex;
            flex-direction: column;
        }

        .settings-panel {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
        }

        .account-panel {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
        }

        /* ── File Autocomplete Dropdown ─────────────────── */
        .input-wrapper { position: relative; }

        .file-dropdown {
            position: absolute;
            bottom: 100%;
            left: 0; right: 0;
            background: var(--vscode-editorSuggestWidget-background, var(--vscode-input-background));
            border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-focusBorder));
            border-radius: 3px;
            max-height: 180px;
            overflow-y: auto;
            z-index: 100;
            margin-bottom: 4px;
            box-shadow: 0 -2px 8px rgba(0,0,0,0.2);
        }

        .file-dropdown-item {
            padding: 4px 8px;
            font-size: 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--vscode-editorSuggestWidget-foreground, var(--vscode-foreground));
            font-family: var(--dc-editor-font);
        }

        .file-dropdown-item:hover,
        .file-dropdown-item.selected {
            background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground));
            color: var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)));
        }

        .file-dropdown-item .file-icon {
            opacity: 0.5;
            font-size: 11px;
            flex-shrink: 0;
        }

        .file-dropdown-item .file-path {
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .file-dropdown-hint {
            padding: 6px 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
        }

        /* ── Icon buttons — VS Code toolbar style ───────── */
        .icon-btn {
            background: transparent;
            color: var(--vscode-icon-foreground, var(--vscode-foreground));
            border: none;
            padding: 4px;
            border-radius: 3px;
            cursor: pointer;
            line-height: 0;
            transition: background 0.1s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
        }

        .icon-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            opacity: 1;
        }

        .icon-btn svg { width: 16px; height: 16px; }

        .send-btn {
            background: transparent;
            color: var(--vscode-icon-foreground, var(--vscode-foreground));
            border: none;
            padding: 4px;
            border-radius: 3px;
            cursor: pointer;
            line-height: 0;
            transition: background 0.1s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .send-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
        .send-btn:disabled { opacity: 0.3; cursor: not-allowed; }
        .send-btn svg { width: 16px; height: 16px; }

        .btn-icon {
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }

        .btn-icon svg { width: 12px; height: 12px; vertical-align: middle; }

        /* ── Chat history list ──────────────────────────── */
        .history-list { padding: 8px; }

        .history-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: var(--dc-font-size);
            margin-bottom: 1px;
            transition: background 0.1s;
        }

        .history-item:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .history-item .history-title {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .history-item .history-date {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-left: 8px;
            white-space: nowrap;
        }

        .history-item .history-delete {
            margin-left: 4px;
            opacity: 0;
            cursor: pointer;
            line-height: 0;
        }

        .history-item:hover .history-delete { opacity: 0.5; }
        .history-item .history-delete:hover { opacity: 1; color: var(--vscode-errorForeground); }

        .history-empty {
            text-align: center;
            padding: 24px 12px;
            color: var(--vscode-descriptionForeground);
            font-size: var(--dc-font-size);
        }

        /* ── Process status bar ─────────────────────────── */
        .process-bar {
            padding: 4px 16px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            align-items: center;
            gap: 8px;
            border-top: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border));
            background: var(--vscode-editor-background);
            flex-shrink: 0;
        }

        .process-bar .process-spinner {
            width: 12px;
            height: 12px;
            border: 1.5px solid var(--vscode-textLink-foreground, var(--vscode-foreground));
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            flex-shrink: 0;
        }

        @keyframes spin { to { transform: rotate(360deg); } }

        /* Stop button */
        .stop-btn {
            background: transparent;
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border));
            padding: 3px 10px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            font-family: var(--dc-font-family);
            display: inline-flex;
            align-items: center;
            gap: 4px;
            line-height: 1;
        }

        .stop-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
        .stop-btn svg { width: 12px; height: 12px; }

        /* Token ring indicator */
        .token-ring {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            cursor: default;
            padding: 2px 4px;
        }

        .token-ring svg { width: 14px; height: 14px; }
        .token-ring:hover { color: var(--vscode-foreground); }

        /* ── Author footer ──────────────────────────────── */
        .author-footer {
            padding: 3px 12px 5px;
            text-align: center;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.45;
            font-family: var(--dc-font-family);
            letter-spacing: 0.2px;
            flex-shrink: 0;
            transition: opacity 0.15s;
        }

        .author-footer:hover { opacity: 0.8; }

        .author-footer a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }

        .author-footer a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <!-- Main Chat View -->
    <div class="chat-container">
        <div class="chat-messages" id="chatMessages">
            <div class="welcome-card" id="welcomeCard">
                <svg class="welcome-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5.5 3L2 8l3.5 5"/><path d="M10.5 3L14 8l-3.5 5"/>
                    <path d="M9 2.5L6.5 8H8.5L7 13.5L10.5 7H8L9 2.5Z" fill="currentColor" stroke="none"/>
                </svg>
                <h2>DeepCode</h2>
                <p>Ask anything about your code.<br>Use <kbd>#</kbd> to reference files, <kbd>@web</kbd> to search the web.</p>
            </div>
        </div>
        <div id="processBar" class="process-bar hidden">
            <span class="process-spinner"></span>
            <span id="processText"></span>
            <span class="elapsed-time" id="elapsedTime"></span>
        </div>
        <div class="chat-input-area">
            <div id="attachedFilesBar" class="attached-files-bar hidden"></div>
            <div class="input-wrapper">
                <textarea class="chat-textarea" id="chatInput" placeholder="Ask anything... Use # for files, @web to search the web" rows="3"></textarea>
                <div id="fileDropdown" class="file-dropdown hidden"></div>
            </div>
            <div class="action-buttons">
                <button class="icon-btn" id="newChatBtn" title="New chat"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg></button>
                <button class="icon-btn" id="attachBtn" title="Attach files (or use #)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.75 5.5v5a3.25 3.25 0 0 1-6.5 0V4.75a2 2 0 1 1 4 0v5.5a.75.75 0 0 1-1.5 0v-5"/></svg></button>
                <button class="icon-btn" id="webSearchBtn" title="Search the web (or type @web <query>)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5c-1.5 1.5-2.5 3-2.5 5.5s1 4 2.5 5.5"/><path d="M8 2.5c1.5 1.5 2.5 3 2.5 5.5s-1 4-2.5 5.5"/><path d="M2.5 8h11"/></svg></button>
                <button class="icon-btn" id="clearBtn" title="Clear chat"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1m1.5 0l-.5 8.5a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 5 12.5L4.5 4"/></svg></button>
                <div style="flex:1"></div>
                <span class="token-ring" id="tokenRing" title="Context window usage">
                    <svg viewBox="0 0 16 16">
                        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.15"/>
                        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" id="tokenArc" stroke-dasharray="0 37.7" transform="rotate(-90 8 8)"/>
                    </svg>
                    <span id="tokenPct">0%</span>
                </span>
                <button class="icon-btn" id="settingsBtn" title="Settings"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.1 1.3a1.1 1.1 0 0 0-2.2 0l-.1.9a.9.9 0 0 1-.54.72.9.9 0 0 1-.88-.1l-.72-.54a1.1 1.1 0 0 0-1.55 1.56l.53.71a.9.9 0 0 1 .11.89.9.9 0 0 1-.72.53l-.9.1a1.1 1.1 0 0 0 0 2.2l.9.1a.9.9 0 0 1 .72.54.9.9 0 0 1-.1.88l-.54.72a1.1 1.1 0 1 0 1.56 1.55l.71-.53a.9.9 0 0 1 .89-.11.9.9 0 0 1 .53.72l.1.9a1.1 1.1 0 0 0 2.2 0l.1-.9a.9.9 0 0 1 .54-.72.9.9 0 0 1 .88.1l.72.54a1.1 1.1 0 0 0 1.55-1.56l-.53-.71a.9.9 0 0 1-.11-.89.9.9 0 0 1 .72-.53l.9-.1a1.1 1.1 0 0 0 0-2.2l-.9-.1a.9.9 0 0 1-.72-.54.9.9 0 0 1 .1-.88l.54-.72a1.1 1.1 0 1 0-1.56-1.55l-.71.53a.9.9 0 0 1-.89.11.9.9 0 0 1-.53-.72l-.1-.9zM8 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5zM6.5 8a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0z"/></svg></button>
                <button class="stop-btn hidden" id="stopBtn" title="Stop generation"><svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>Stop</button>
                <button class="send-btn" id="sendBtn" title="Send message"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.724 1.053a.5.5 0 0 1 .535-.065l12.5 6a.5.5 0 0 1 0 .9l-12.5 6a.5.5 0 0 1-.707-.545L2.81 8.5H7a.5.5 0 0 0 0-1H2.81L1.552 1.663a.5.5 0 0 1 .172-.61z"/></svg></button>
            </div>
        </div>
        <div class="author-footer">built by <a href="mailto:chaudhar1337@gmail.com">Muhammad Adeel</a></div>
    </div>

    <!-- Settings Modal -->
    <div class="modal-overlay hidden" id="settingsModal">
        <div class="modal">
            <div class="modal-header">
                <h3>Settings</h3>
                <button class="modal-close" id="modalCloseBtn">×</button>
            </div>
            <div class="modal-body">
                <div class="modal-sidebar">
                    <button class="modal-tab active" data-mtab="msettings" title="Settings"><span class="btn-icon"><svg viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px"><path d="M9.1 1.3a1.1 1.1 0 0 0-2.2 0l-.1.9a.9.9 0 0 1-.54.72.9.9 0 0 1-.88-.1l-.72-.54a1.1 1.1 0 0 0-1.55 1.56l.53.71a.9.9 0 0 1 .11.89.9.9 0 0 1-.72.53l-.9.1a1.1 1.1 0 0 0 0 2.2l.9.1a.9.9 0 0 1 .72.54.9.9 0 0 1-.1.88l-.54.72a1.1 1.1 0 1 0 1.56 1.55l.71-.53a.9.9 0 0 1 .89-.11.9.9 0 0 1 .53.72l.1.9a1.1 1.1 0 0 0 2.2 0l.1-.9a.9.9 0 0 1 .54-.72.9.9 0 0 1 .88.1l.72.54a1.1 1.1 0 0 0 1.55-1.56l-.53-.71a.9.9 0 0 1-.11-.89.9.9 0 0 1 .72-.53l.9-.1a1.1 1.1 0 0 0 0-2.2l-.9-.1a.9.9 0 0 1-.72-.54.9.9 0 0 1 .1-.88l.54-.72a1.1 1.1 0 1 0-1.56-1.55l-.71.53a.9.9 0 0 1-.89.11.9.9 0 0 1-.53-.72l-.1-.9zM8 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5zM6.5 8a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0z"/></svg></span></button>
                    <button class="modal-tab" data-mtab="maccount" title="Account"><span class="btn-icon"><svg viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px"><path d="M8 1a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 4a2 2 0 1 1 4 0 2 2 0 0 1-4 0zm-1.5 7A2.5 2.5 0 0 0 2 13.5a.5.5 0 0 1-1 0A3.5 3.5 0 0 1 4.5 10h7A3.5 3.5 0 0 1 15 13.5a.5.5 0 0 1-1 0 2.5 2.5 0 0 0-2.5-2.5h-7z"/></svg></span></button>
                    <button class="modal-tab" data-mtab="mhistory" title="History"><span class="btn-icon"><svg viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM2 8a6 6 0 1 1 12 0A6 6 0 0 1 2 8z"/><path d="M8 4v4.5l3 1.5-.4.9L7.5 9V4H8z"/></svg></span></button>
                </div>
                <div class="modal-content">
                    <div class="mtab-content active" id="mtab-msettings">
                        <div class="settings-panel">
                            <div class="settings-group">
                                <h3>Model Configuration</h3>
                                <div class="setting-item">
                                    <label>Model</label>
                                    <div class="description">The DeepSeek model to use</div>
                                    <select id="setting-model">
                                        <option value="deepseek-chat" selected>DeepSeek V3.2 (Fast)</option>
                                        <option value="deepseek-reasoner">DeepSeek V3.2 (Thinking)</option>
                                    </select>
                                </div>
                                <div class="setting-item">
                                    <label>Temperature: <span id="temp-value">0</span></label>
                                    <div class="description">0 = deterministic, higher = more creative</div>
                                    <input type="range" id="setting-temperature" min="0" max="2" step="0.1" value="0">
                                </div>
                                <div class="setting-item">
                                    <label>Max Tokens</label>
                                    <div class="description">Maximum response length (256 - 65536)</div>
                                    <input type="number" id="setting-maxTokens" value="8192" min="256" max="65536">
                                </div>
                                <div class="setting-item">
                                    <label>Top P: <span id="topp-value">0.95</span></label>
                                    <div class="description">Nucleus sampling parameter</div>
                                    <input type="range" id="setting-topP" min="0" max="1" step="0.05" value="0.95">
                                </div>
                                <div class="setting-item">
                                    <label>Frequency Penalty: <span id="freq-value">0</span></label>
                                    <div class="description">Penalize repeated tokens (-2 to 2)</div>
                                    <input type="range" id="setting-frequencyPenalty" min="-2" max="2" step="0.1" value="0">
                                </div>
                                <div class="setting-item">
                                    <label>Presence Penalty: <span id="pres-value">0</span></label>
                                    <div class="description">Penalize topic repetition (-2 to 2)</div>
                                    <input type="range" id="setting-presencePenalty" min="-2" max="2" step="0.1" value="0">
                                </div>
                            </div>
                            <div class="settings-group">
                                <h3>Behavior</h3>
                                <div class="setting-item">
                                    <div class="toggle-row">
                                        <div>
                                            <label>Stream Responses</label>
                                            <div class="description">Show tokens in real-time</div>
                                        </div>
                                        <label class="toggle">
                                            <input type="checkbox" id="setting-streamResponses" checked>
                                            <span class="toggle-slider"></span>
                                        </label>
                                    </div>
                                </div>
                                <div class="setting-item">
                                    <div class="toggle-row">
                                        <div>
                                            <label>Auto Save</label>
                                            <div class="description">Save files after AI edits</div>
                                        </div>
                                        <label class="toggle">
                                            <input type="checkbox" id="setting-autoSave">
                                            <span class="toggle-slider"></span>
                                        </label>
                                    </div>
                                </div>
                                <div class="setting-item">
                                    <label>Context Lines</label>
                                    <div class="description">Lines of surrounding context for edits</div>
                                    <input type="number" id="setting-contextLines" value="50" min="10" max="500">
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="mtab-content" id="mtab-maccount">
                        <div class="account-panel">
                            <div class="account-section">
                                <h3>API Connection</h3>
                                <div class="status-indicator" id="connectionStatus">
                                    <span class="status-dot disconnected" id="statusDot"></span>
                                    <span id="statusText">Not connected</span>
                                </div>
                                <div class="setting-item">
                                    <label>DeepSeek API Key</label>
                                    <div class="description">Stored securely in VS Code's secret storage</div>
                                    <div class="api-key-input-group">
                                        <input type="password" id="apiKeyInput" placeholder="sk-..." />
                                        <button id="saveApiKeyBtn">Save</button>
                                    </div>
                                </div>
                                <div class="action-buttons">
                                    <button class="secondary small" id="testKeyBtn">Test Key</button>
                                    <button class="danger small" id="removeKeyBtn">Remove Key</button>
                                </div>
                            </div>
                            <div class="account-section">
                                <h3>Usage & Balance</h3>
                                <div class="balance-info" id="balanceInfo">
                                    <div class="balance-row">
                                        <span class="balance-label">Available Balance</span>
                                        <span class="balance-value" id="availableBalance">--</span>
                                    </div>
                                    <div class="balance-row">
                                        <span class="balance-label">Used</span>
                                        <span class="balance-value" id="usedBalance">--</span>
                                    </div>
                                    <div style="margin-top:8px;">
                                        <button class="secondary small" id="refreshBalanceBtn">Refresh Balance</button>
                                    </div>
                                </div>
                            </div>
                            <div class="account-section">
                                <h3>Session Info</h3>
                                <div class="balance-info">
                                    <div class="balance-row">
                                        <span class="balance-label">Session Tokens Used</span>
                                        <span class="balance-value" id="sessionTokens">0</span>
                                    </div>
                                    <div class="balance-row">
                                        <span class="balance-label">Messages Sent</span>
                                        <span class="balance-value" id="messageCount">0</span>
                                    </div>
                                </div>
                            </div>
                            <div class="account-section">
                                <h3>Links</h3>
                                <div class="setting-item">
                                    <div class="description">
                                        <a href="https://platform.deepseek.com" style="color: var(--vscode-textLink-foreground);">DeepSeek Platform</a> · 
                                        <a href="https://api-docs.deepseek.com" style="color: var(--vscode-textLink-foreground);">API Docs</a> · 
                                        <a href="https://platform.deepseek.com/usage" style="color: var(--vscode-textLink-foreground);">Usage Dashboard</a>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="mtab-content" id="mtab-mhistory">
                        <div class="history-list" id="historyList">
                            <div class="history-empty">No chat history yet.<br>Your conversations will appear here.</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let isStreaming = false;
        let currentStreamEl = null;
        let currentStreamRaw = '';
        let sessionTokens = 0;
        let chatTokens = 0;
        let messageCount = 0;

        // --- Settings Modal ---
        function openSettings() {
            document.getElementById('settingsModal').classList.remove('hidden');
            vscode.postMessage({ type: 'getSettings' });
            vscode.postMessage({ type: 'getApiKeyStatus' });
        }

        function closeSettings() {
            document.getElementById('settingsModal').classList.add('hidden');
        }

        document.querySelectorAll('.modal-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.mtab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('mtab-' + tab.dataset.mtab).classList.add('active');
                if (tab.dataset.mtab === 'maccount') {
                    vscode.postMessage({ type: 'getApiKeyStatus' });
                }
                if (tab.dataset.mtab === 'mhistory') {
                    loadChatHistory();
                }
            });
        });

        // --- Wire up buttons ---
        document.getElementById('sendBtn').addEventListener('click', () => sendMessage());
        document.getElementById('stopBtn').addEventListener('click', () => stopGeneration());
        document.getElementById('newChatBtn').addEventListener('click', () => newChat());
        document.getElementById('attachBtn').addEventListener('click', () => attachFiles());
        document.getElementById('webSearchBtn').addEventListener('click', () => insertWebPrefix());
        document.getElementById('clearBtn').addEventListener('click', () => clearChat());
        document.getElementById('settingsBtn').addEventListener('click', () => openSettings());
        document.getElementById('modalCloseBtn').addEventListener('click', () => closeSettings());

        // --- Wire up settings controls ---
        document.getElementById('setting-model').addEventListener('change', function() { updateSetting('model', this.value); });
        document.getElementById('setting-temperature').addEventListener('input', function() {
            document.getElementById('temp-value').textContent = this.value;
            updateSetting('temperature', parseFloat(this.value));
        });
        document.getElementById('setting-maxTokens').addEventListener('change', function() { updateSetting('maxTokens', parseInt(this.value)); });
        document.getElementById('setting-topP').addEventListener('input', function() {
            document.getElementById('topp-value').textContent = this.value;
            updateSetting('topP', parseFloat(this.value));
        });
        document.getElementById('setting-frequencyPenalty').addEventListener('input', function() {
            document.getElementById('freq-value').textContent = this.value;
            updateSetting('frequencyPenalty', parseFloat(this.value));
        });
        document.getElementById('setting-presencePenalty').addEventListener('input', function() {
            document.getElementById('pres-value').textContent = this.value;
            updateSetting('presencePenalty', parseFloat(this.value));
        });
        document.getElementById('setting-streamResponses').addEventListener('change', function() { updateSetting('streamResponses', this.checked); });
        document.getElementById('setting-autoSave').addEventListener('change', function() { updateSetting('autoSave', this.checked); });
        document.getElementById('setting-contextLines').addEventListener('change', function() { updateSetting('contextLines', parseInt(this.value)); });

        // --- Wire up account buttons ---
        document.getElementById('saveApiKeyBtn').addEventListener('click', () => saveApiKey());
        document.getElementById('testKeyBtn').addEventListener('click', () => validateKey());
        document.getElementById('removeKeyBtn').addEventListener('click', () => clearApiKey());
        document.getElementById('refreshBalanceBtn').addEventListener('click', () => refreshBalance());

        // --- Chat ---
        const chatInput = document.getElementById('chatInput');
        let attachedFiles = []; // [{path, fullPath}]

        chatInput.addEventListener('keydown', (e) => {
            // Handle dropdown navigation
            const dropdown = document.getElementById('fileDropdown');
            if (!dropdown.classList.contains('hidden')) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    navigateDropdown(e.key === 'ArrowDown' ? 1 : -1);
                    return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                    const selected = dropdown.querySelector('.file-dropdown-item.selected');
                    if (selected) {
                        e.preventDefault();
                        selectDropdownFile(selected);
                        return;
                    }
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    hideFileDropdown();
                    return;
                }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // --- # Autocomplete ---
        let hashStart = -1;

        chatInput.addEventListener('input', () => {
            const val = chatInput.value;
            const cursor = chatInput.selectionStart;

            // Detect # trigger
            const before = val.substring(0, cursor);
            const hashIdx = before.lastIndexOf('#');

            if (hashIdx >= 0) {
                // Check there's no space between # and the beginning of the query segment
                const afterHash = before.substring(hashIdx + 1);
                // Allow alphanum, dots, slashes, dashes, underscores
                if (/^[\\w.\\-\\/]*$/.test(afterHash)) {
                    hashStart = hashIdx;
                    const query = afterHash;
                    vscode.postMessage({ type: 'searchFiles', query });
                    return;
                }
            }

            hideFileDropdown();
            hashStart = -1;
        });

        function showFileDropdown(files) {
            const dropdown = document.getElementById('fileDropdown');
            if (files.length === 0) {
                dropdown.innerHTML = '<div class="file-dropdown-hint">No files found</div>';
                dropdown.classList.remove('hidden');
                return;
            }
            dropdown.innerHTML = files.map((f, i) =>
                '<div class="file-dropdown-item' + (i === 0 ? ' selected' : '') + '" data-path="' + f.path + '" data-fullpath="' + f.fullPath + '" data-isfolder="' + (f.isFolder ? '1' : '') + '">'
                + '<span class="file-icon">' + (f.isFolder ? '📁' : '📄') + '</span>'
                + '<span class="file-path">' + f.path + '</span>'
                + '</div>'
            ).join('');
            // Wire up click handlers
            dropdown.querySelectorAll('.file-dropdown-item').forEach(item => {
                item.addEventListener('click', () => selectDropdownFile(item));
            });
            dropdown.classList.remove('hidden');
        }

        function hideFileDropdown() {
            document.getElementById('fileDropdown').classList.add('hidden');
        }

        function navigateDropdown(direction) {
            const dropdown = document.getElementById('fileDropdown');
            const items = dropdown.querySelectorAll('.file-dropdown-item');
            if (items.length === 0) return;
            let idx = -1;
            items.forEach((item, i) => { if (item.classList.contains('selected')) idx = i; });
            items.forEach(item => item.classList.remove('selected'));
            idx += direction;
            if (idx < 0) idx = items.length - 1;
            if (idx >= items.length) idx = 0;
            items[idx].classList.add('selected');
            items[idx].scrollIntoView({ block: 'nearest' });
        }

        function selectDropdownFile(el) {
            const path = el.dataset.path;
            const fullPath = el.dataset.fullpath;
            const isFolder = el.dataset.isfolder === '1';

            // Replace the #query text with #name
            const val = chatInput.value;
            const cursor = chatInput.selectionStart;
            const before = val.substring(0, hashStart);
            const after = val.substring(cursor);
            const name = path.split('/').filter(Boolean).pop() || path;
            chatInput.value = before + '#' + name + (isFolder ? '/ ' : ' ') + after;
            chatInput.selectionStart = chatInput.selectionEnd = before.length + name.length + (isFolder ? 3 : 2);
            chatInput.focus();

            if (isFolder) {
                // For folders, ask backend to expand into individual files
                vscode.postMessage({ type: 'expandFolder', folderPath: fullPath });
            } else {
                // Add file to attached files
                const exists = attachedFiles.some(f => f.fullPath === fullPath);
                if (!exists) {
                    attachedFiles.push({ path, fullPath });
                    renderAttachedFiles();
                }
            }

            hideFileDropdown();
            hashStart = -1;
        }

        function getAttachedPaths() {
            return attachedFiles.map(f => f.fullPath);
        }

        function sendMessage() {
            const msg = chatInput.value.trim();
            if (!msg || isStreaming) return;
            const fileCount = attachedFiles.length;
            const label = fileCount > 0 ? msg + ' [' + fileCount + ' file(s)]' : msg;
            addMessage('user', label);
            // Store message in current chat
            currentChatMessages.push({ role: 'user', content: label });
            vscode.postMessage({ type: 'chat', message: msg, attachedFiles: getAttachedPaths() });
            chatInput.value = '';
            chatInput.style.height = 'auto';
            clearAttachedFiles();
        }

        function clearChat() {
            // Save current chat before clearing if it has messages
            saveCurrentChat();
            const messages = document.getElementById('chatMessages');
            messages.innerHTML = '';
            vscode.postMessage({ type: 'clearHistory' });
        }

        // --- Chat History ---
        let currentChatId = generateId();
        let currentChatMessages = [];

        function generateId() {
            return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
        }

        function newChat() {
            // Save current chat if it has content
            saveCurrentChat();
            // Reset
            currentChatId = generateId();
            currentChatMessages = [];
            chatTokens = 0;
            updateTokenRing(0);
            const messages = document.getElementById('chatMessages');
            messages.innerHTML = '<div class=\"welcome-card\" id=\"welcomeCard\"><svg class=\"welcome-icon\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M5.5 3L2 8l3.5 5\"/><path d=\"M10.5 3L14 8l-3.5 5\"/><path d=\"M9 2.5L6.5 8H8.5L7 13.5L10.5 7H8L9 2.5Z\" fill=\"currentColor\" stroke=\"none\"/></svg><h2>DeepCode</h2><p>Ask anything about your code.<br>Use <kbd>#</kbd> to reference files, <kbd>@web</kbd> to search the web.</p></div>';
            vscode.postMessage({ type: 'clearHistory' });
            chatInput.value = '';
            clearAttachedFiles();
        }

        function saveCurrentChat() {
            if (currentChatMessages.length === 0) return;
            const title = currentChatMessages[0].content.substring(0, 60);
            const chat = {
                id: currentChatId,
                title: title,
                date: new Date().toISOString(),
                messages: currentChatMessages,
            };
            vscode.postMessage({ type: 'saveChat', chat });
        }

        function loadChatHistory() {
            vscode.postMessage({ type: 'loadChats' });
        }

        function renderChatList(chats) {
            const list = document.getElementById('historyList');
            if (!chats || chats.length === 0) {
                list.innerHTML = '<div class=\"history-empty\">No chat history yet.<br>Your conversations will appear here.</div>';
                return;
            }
            list.innerHTML = chats.map(c => {
                const d = new Date(c.date);
                const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                return '<div class=\"history-item\" data-chatid=\"' + c.id + '\">'
                    + '<span class=\"history-title\">' + escapeHtml(c.title) + '</span>'
                    + '<span class=\"history-date\">' + dateStr + '</span>'
                    + '<span class=\"history-delete\" data-deleteid=\"' + c.id + '\"><svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" style=\"width:12px;height:12px\"><path d=\"M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1m1.5 0l-.5 8.5a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 5 12.5L4.5 4\"/></svg></span>'
                    + '</div>';
            }).join('');
            // Wire up clicks
            list.querySelectorAll('.history-item').forEach(el => {
                el.addEventListener('click', (e) => {
                    // Don't load if clicking delete
                    if (e.target.closest('.history-delete')) return;
                    const chatId = el.dataset.chatid;
                    const chat = chats.find(c => c.id === chatId);
                    if (chat) restoreChat(chat);
                });
            });
            list.querySelectorAll('.history-delete').forEach(el => {
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const id = el.dataset.deleteid;
                    vscode.postMessage({ type: 'deleteChat', id });
                });
            });
        }

        function restoreChat(chat) {
            // Save current first
            saveCurrentChat();
            // Restore
            currentChatId = chat.id;
            currentChatMessages = chat.messages.slice();
            const messagesEl = document.getElementById('chatMessages');
            messagesEl.innerHTML = '';
            for (const msg of chat.messages) {
                addMessage(msg.role, msg.content);
            }
            closeSettings();
        }

        function escapeHtml(str) {
            return str.replace(/&/g, '&amp;').replace(/\x3c/g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
        }

        function addMessage(role, content) {
            const welcome = document.getElementById('welcomeCard');
            if (welcome) welcome.remove();

            const messages = document.getElementById('chatMessages');
            const div = document.createElement('div');
            div.className = 'message ' + role;

            if (role === 'assistant' || role === 'error') {
                div.innerHTML = formatContent(content);
            } else {
                div.textContent = content;
            }

            messages.appendChild(div);
            messages.scrollTop = messages.scrollHeight;
            return div;
        }

        function formatContent(text) {
            if (!text) return '';
            // Escape HTML first
            let s = text.replace(/&/g, '&amp;').replace(/\x3c/g, '&lt;').replace(/>/g, '&gt;');
            // Code blocks (fenced) — with syntax highlighting
            s = s.replace(/\`\`\`(\\w*)?\\n?([\\s\\S]*?)\`\`\`/g, function(m, lang, code) {
                const langLabel = lang ? '<span class="code-lang-label">' + lang + '</span>' : '';
                const highlighted = highlightCode(code.trim(), lang || '');
                return '<div class="code-block-wrapper">' + langLabel + '<pre><code>' + highlighted + '</code></pre></div>';
            });
            // Inline code
            s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
            // Bold
            s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
            // Italic
            s = s.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
            return s;
        }

        // ── Syntax Highlighting ────────────────────────────
        function highlightCode(code, lang) {
            // Already HTML-escaped
            lang = (lang || '').toLowerCase();
            // Map aliases
            var langMap = {
                js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
                py: 'python', rb: 'ruby', rs: 'rust', go: 'go', sh: 'bash',
                bash: 'bash', zsh: 'bash', shell: 'bash', yml: 'yaml', yaml: 'yaml',
                md: 'markdown', json: 'json', html: 'html', xml: 'html',
                css: 'css', scss: 'css', less: 'css', sql: 'sql',
                c: 'c', cpp: 'c', h: 'c', java: 'java', cs: 'java', swift: 'java',
                kt: 'java', kotlin: 'java', php: 'php',
            };
            lang = langMap[lang] || lang;

            var rules = getLanguageRules(lang);
            if (!rules || rules.length === 0) return code;

            return applyHighlighting(code, rules);
        }

        function getLanguageRules(lang) {
            // Each rule: [regex, tokenClass]
            // Order matters — first match wins per position

            var commentLine = [/\\/\\/[^\\n]*/g, 'tok-comment'];
            var commentBlock = [/\\/\\*[\\s\\S]*?\\*\\//g, 'tok-comment'];
            var commentHash = [/#[^\\n]*/g, 'tok-comment'];
            var commentDash = [/--[^\\n]*/g, 'tok-comment'];
            var strDouble = [/&quot;(?:[^&]|&(?!quot;))*?&quot;/g, 'tok-string'];
            var strSingle = [/&#39;(?:[^&]|&(?!#39;))*?&#39;/g, 'tok-string'];
            var strBacktick = [/\`(?:[^\`])*?\`/g, 'tok-string'];
            var strTriDouble = [/&quot;&quot;&quot;[\\s\\S]*?&quot;&quot;&quot;/g, 'tok-string'];
            var strTriSingle = [/&#39;&#39;&#39;[\\s\\S]*?&#39;&#39;&#39;/g, 'tok-string'];
            var numbers = [/\\b\\d+\\.?\\d*(?:e[+-]?\\d+)?\\b/gi, 'tok-number'];
            var hexNumbers = [/\\b0x[\\da-f]+\\b/gi, 'tok-number'];

            var jsKeywords = [/\\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|from|default|try|catch|finally|throw|async|await|yield|of|in|typeof|instanceof|void|delete|super|static|get|set|constructor)\\b/g, 'tok-keyword'];
            var jsTypes = [/\\b(?:string|number|boolean|object|any|void|null|undefined|never|unknown|Array|Map|Set|Promise|Record|Partial|Required|Readonly|Pick|Omit|Exclude|Extract)\\b/g, 'tok-type'];
            var jsBuiltins = [/\\b(?:console|window|document|Math|JSON|Object|Array|String|Number|Boolean|RegExp|Date|Error|Promise|setTimeout|setInterval|parseInt|parseFloat|isNaN|isFinite|encodeURIComponent|decodeURIComponent|require|module|exports|process|Buffer|global)\\b/g, 'tok-builtin'];
            var jsFuncCall = [/\\b([a-zA-Z_$][\\w$]*)\\s*(?=\\()/g, 'tok-function'];

            var pyKeywords = [/\\b(?:def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|try|except|finally|raise|with|yield|lambda|and|or|not|in|is|True|False|None|async|await|global|nonlocal|assert|del)\\b/g, 'tok-keyword'];
            var pyTypes = [/\\b(?:int|float|str|bool|list|dict|tuple|set|bytes|type|object|None)\\b/g, 'tok-type'];
            var pyBuiltins = [/\\b(?:print|len|range|enumerate|zip|map|filter|sorted|reversed|isinstance|issubclass|hasattr|getattr|setattr|super|property|staticmethod|classmethod|open|input|format|abs|max|min|sum|round|chr|ord|hex|bin|oct|id|hash|repr|eval|exec|compile|dir|vars|locals|globals|type|iter|next)\\b/g, 'tok-builtin'];
            var pyDecorator = [/@[a-zA-Z_][\\w.]*/g, 'tok-keyword'];
            var pyFuncCall = [/\\b([a-zA-Z_][\\w]*)\\s*(?=\\()/g, 'tok-function'];

            var htmlTags = [/&lt;\\/?(\\w+)/g, 'tok-tag'];
            var htmlAttrName = [/\\s([a-zA-Z\\-]+)(?==)/g, 'tok-attr-name'];

            var cssKeywords = [/\\b(?:import|media|keyframes|font-face|supports|charset)\\b/g, 'tok-keyword'];
            var cssProp = [/([a-z\\-]+)\\s*(?=:)/g, 'tok-property'];
            var cssVal = [/:\\s*([^;{}]+)/g, 'tok-attr-value'];
            var cssSelector = [/^\\s*([.#]?[a-zA-Z][\\w\\-*.#>+~, ]+)\\s*\\{/gm, 'tok-tag'];

            var jsonKey = [/&quot;([^&]*?)&quot;\\s*(?=:)/g, 'tok-property'];
            var jsonStr = [/:\\s*&quot;([^&]*?)&quot;/g, 'tok-string'];
            var jsonBool = [/\\b(?:true|false|null)\\b/g, 'tok-keyword'];

            var sqlKeywords = [/\\b(?:SELECT|FROM|WHERE|INSERT|INTO|UPDATE|SET|DELETE|CREATE|DROP|ALTER|TABLE|INDEX|VIEW|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|IN|IS|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|COUNT|SUM|AVG|MIN|MAX|BETWEEN|LIKE|EXISTS|CASE|WHEN|THEN|ELSE|END|BEGIN|COMMIT|ROLLBACK|GRANT|REVOKE|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|DEFAULT|VALUES|TRUNCATE|CASCADE)\\b/gi, 'tok-keyword'];

            var bashKeywords = [/\\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|local|export|source|echo|exit|set|unset|readonly|declare|typeset|shift|trap|eval|exec|test|cd|ls|mv|cp|rm|mkdir|chmod|chown|grep|sed|awk|cat|head|tail|sort|uniq|wc|find|xargs|curl|wget|tar|git|npm|yarn|pip|docker|sudo)\\b/g, 'tok-keyword'];
            var bashVar = [/\\$[a-zA-Z_][\\w]*/g, 'tok-property'];
            var bashVar2 = [/\\$\\{[^}]+\\}/g, 'tok-property'];

            var rustKeywords = [/\\b(?:fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|crate|self|super|match|if|else|for|while|loop|break|continue|return|where|as|in|ref|move|async|await|unsafe|extern|type|dyn|static|macro_rules)\\b/g, 'tok-keyword'];
            var rustTypes = [/\\b(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc|Cell|RefCell|HashMap|HashSet|BTreeMap|BTreeSet)\\b/g, 'tok-type'];

            var goKeywords = [/\\b(?:func|var|const|type|struct|interface|map|chan|package|import|return|if|else|for|range|switch|case|default|break|continue|go|defer|select|fallthrough|goto)\\b/g, 'tok-keyword'];
            var goTypes = [/\\b(?:int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|complex64|complex128|string|bool|byte|rune|error|any)\\b/g, 'tok-type'];
            var goBuiltins = [/\\b(?:make|len|cap|append|copy|delete|new|close|panic|recover|print|println|nil|true|false|iota)\\b/g, 'tok-builtin'];

            switch (lang) {
                case 'javascript':
                case 'typescript':
                    return [commentBlock, commentLine, strBacktick, strDouble, strSingle, hexNumbers, numbers, jsTypes, jsKeywords, jsBuiltins, jsFuncCall];
                case 'python':
                    return [strTriDouble, strTriSingle, commentHash, strDouble, strSingle, hexNumbers, numbers, pyDecorator, pyTypes, pyKeywords, pyBuiltins, pyFuncCall];
                case 'html':
                    return [commentBlock, strDouble, strSingle, htmlTags, htmlAttrName];
                case 'css':
                    return [commentBlock, strDouble, strSingle, numbers, cssKeywords, cssSelector, cssProp, cssVal];
                case 'json':
                    return [jsonKey, jsonStr, hexNumbers, numbers, jsonBool];
                case 'sql':
                    return [commentDash, commentBlock, strSingle, numbers, sqlKeywords];
                case 'bash':
                    return [commentHash, strDouble, strSingle, numbers, bashVar2, bashVar, bashKeywords];
                case 'rust':
                    return [commentBlock, commentLine, strDouble, strSingle, hexNumbers, numbers, rustTypes, rustKeywords, jsFuncCall];
                case 'go':
                    return [commentBlock, commentLine, strBacktick, strDouble, strSingle, hexNumbers, numbers, goTypes, goKeywords, goBuiltins, jsFuncCall];
                case 'java':
                    return [commentBlock, commentLine, strDouble, strSingle, hexNumbers, numbers, jsKeywords, jsFuncCall];
                case 'c':
                    return [commentBlock, commentLine, strDouble, strSingle, hexNumbers, numbers, jsKeywords, jsFuncCall];
                case 'php':
                    return [commentBlock, commentLine, commentHash, strDouble, strSingle, hexNumbers, numbers, jsKeywords, jsFuncCall, bashVar];
                default:
                    // Generic highlighting for unrecognized languages
                    return [commentBlock, commentLine, commentHash, strDouble, strSingle, hexNumbers, numbers, jsKeywords, jsFuncCall];
            }
        }

        function applyHighlighting(code, rules) {
            // Build a token map: for each character position, store the token span
            var tokens = []; // [{start, end, cls}]

            for (var r = 0; r < rules.length; r++) {
                var regex = rules[r][0];
                var cls = rules[r][1];
                // Reset regex
                regex.lastIndex = 0;
                var match;
                while ((match = regex.exec(code)) !== null) {
                    var start = match.index;
                    var end = match.index + match[0].length;
                    // Check if this range overlaps with any existing token
                    var overlaps = false;
                    for (var t = 0; t < tokens.length; t++) {
                        if (start < tokens[t].end && end > tokens[t].start) {
                            overlaps = true;
                            break;
                        }
                    }
                    if (!overlaps) {
                        tokens.push({ start: start, end: end, cls: cls });
                    }
                }
            }

            if (tokens.length === 0) return code;

            // Sort by start position
            tokens.sort(function(a, b) { return a.start - b.start; });

            // Build the highlighted string
            var result = '';
            var pos = 0;
            for (var i = 0; i < tokens.length; i++) {
                var tok = tokens[i];
                if (tok.start > pos) {
                    result += code.substring(pos, tok.start);
                }
                result += '<span class="' + tok.cls + '">' + code.substring(tok.start, tok.end) + '</span>';
                pos = tok.end;
            }
            if (pos < code.length) {
                result += code.substring(pos);
            }

            return result;
        }

        // ── Diff Rendering ─────────────────────────────────
        function renderDiff(oldText, newText, lang) {
            if (!oldText && newText) {
                // Pure addition
                var addLines = newText.split('\\n');
                var html = '';
                for (var i = 0; i < addLines.length; i++) {
                    var content = highlightCode(escapeHtml(addLines[i]), lang || '');
                    html += '<div class="diff-line diff-added">'
                        + '<span class="diff-line-num">' + (i + 1) + '</span>'
                        + '<span class="diff-line-sign">+</span>'
                        + '<span class="diff-line-content">' + content + '</span>'
                        + '</div>';
                }
                return html;
            }

            var oldLines = (oldText || '').split('\\n');
            var newLines = (newText || '').split('\\n');

            // Compute simple LCS-based diff
            var diff = computeDiff(oldLines, newLines);
            var html = '';

            for (var d = 0; d < diff.length; d++) {
                var entry = diff[d];
                var lineContent = highlightCode(escapeHtml(entry.text), lang || '');
                if (entry.type === 'remove') {
                    html += '<div class="diff-line diff-removed">'
                        + '<span class="diff-line-num">' + entry.oldNum + '</span>'
                        + '<span class="diff-line-sign">−</span>'
                        + '<span class="diff-line-content">' + lineContent + '</span>'
                        + '</div>';
                } else if (entry.type === 'add') {
                    html += '<div class="diff-line diff-added">'
                        + '<span class="diff-line-num">' + entry.newNum + '</span>'
                        + '<span class="diff-line-sign">+</span>'
                        + '<span class="diff-line-content">' + lineContent + '</span>'
                        + '</div>';
                } else {
                    html += '<div class="diff-line diff-context">'
                        + '<span class="diff-line-num">' + entry.oldNum + '</span>'
                        + '<span class="diff-line-sign"> </span>'
                        + '<span class="diff-line-content">' + lineContent + '</span>'
                        + '</div>';
                }
            }

            return html;
        }

        function computeDiff(oldLines, newLines) {
            // Myers-like O(ND) diff — simplified for webview
            // Returns array of {type: 'context'|'add'|'remove', text, oldNum?, newNum?}
            var m = oldLines.length;
            var n = newLines.length;

            // For very large diffs, fall back to simple line-by-line
            if (m + n > 2000) {
                return simpleDiff(oldLines, newLines);
            }

            // Build LCS table
            var lcs = [];
            for (var i = 0; i <= m; i++) {
                lcs[i] = [];
                for (var j = 0; j <= n; j++) {
                    if (i === 0 || j === 0) {
                        lcs[i][j] = 0;
                    } else if (oldLines[i - 1] === newLines[j - 1]) {
                        lcs[i][j] = lcs[i - 1][j - 1] + 1;
                    } else {
                        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
                    }
                }
            }

            // Backtrack to produce diff
            var result = [];
            var i = m, j = n;
            while (i > 0 || j > 0) {
                if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
                    result.unshift({ type: 'context', text: oldLines[i - 1], oldNum: i, newNum: j });
                    i--; j--;
                } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
                    result.unshift({ type: 'add', text: newLines[j - 1], newNum: j });
                    j--;
                } else {
                    result.unshift({ type: 'remove', text: oldLines[i - 1], oldNum: i });
                    i--;
                }
            }

            return result;
        }

        function simpleDiff(oldLines, newLines) {
            var result = [];
            var maxLen = Math.max(oldLines.length, newLines.length);
            for (var i = 0; i < maxLen; i++) {
                if (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) {
                    result.push({ type: 'context', text: oldLines[i], oldNum: i + 1, newNum: i + 1 });
                } else {
                    if (i < oldLines.length) {
                        result.push({ type: 'remove', text: oldLines[i], oldNum: i + 1 });
                    }
                    if (i < newLines.length) {
                        result.push({ type: 'add', text: newLines[i], newNum: i + 1 });
                    }
                }
            }
            return result;
        }

        // ── SVG Tool Icons ─────────────────────────────────
        // All icons are 16x16 stroke-based SVGs using currentColor
        function getToolSvg(name) {
            var svgs = {
                // read_file — open document with lines
                read_file: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5.5L13 5v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><polyline points="9 1.5 9 5.5 13 5.5"/><line x1="5.5" y1="8" x2="10.5" y2="8"/><line x1="5.5" y1="10.5" x2="10.5" y2="10.5"/></svg>',
                // write_file — pencil on page
                write_file: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5.5L13 5v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><polyline points="9 1.5 9 5.5 13 5.5"/><path d="M6 12.5l-1.5.5.5-1.5L9.5 7l1 1L6 12.5z"/></svg>',
                // edit_file — wrench
                edit_file: '<svg viewBox="0 0 16 16"><path d="M10.5 2.5l3 3-8.5 8.5H2v-3l8.5-8.5z"/><line x1="8.5" y1="4.5" x2="11.5" y2="7.5"/></svg>',
                // multi_edit_files — stacked docs with pencil
                multi_edit_files: '<svg viewBox="0 0 16 16"><path d="M5 3.5h5l3 3V13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><polyline points="10 3.5 10 6.5 13 6.5"/><path d="M3 11.5V2.5a1 1 0 0 1 1-1h5"/><path d="M7 12l-1 .5.25-1L9.5 8.25l.75.75L7 12z"/></svg>',
                // grep_search — magnifying glass
                grep_search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><line x1="10.2" y1="10.2" x2="14" y2="14"/></svg>',
                // search_files — folder with lens
                search_files: '<svg viewBox="0 0 16 16"><path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8.5z"/><circle cx="8.5" cy="8.5" r="2.5"/><line x1="10.3" y1="10.3" x2="12" y2="12"/></svg>',
                // list_directory — folder tree
                list_directory: '<svg viewBox="0 0 16 16"><path d="M1.5 3a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3z"/></svg>',
                // run_command — terminal prompt
                run_command: '<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1.5"/><polyline points="4 7 6.5 9 4 11"/><line x1="8" y1="11" x2="12" y2="11"/></svg>',
                // get_diagnostics — warning triangle
                get_diagnostics: '<svg viewBox="0 0 16 16"><path d="M8 1.5L1 14h14L8 1.5z"/><line x1="8" y1="6" x2="8" y2="10"/><circle cx="8" cy="12" r="0.5" fill="currentColor" stroke="none"/></svg>',
                // web_search — globe
                web_search: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="3" ry="6.5"/><line x1="1.5" y1="8" x2="14.5" y2="8"/><path d="M2.5 4.5h11M2.5 11.5h11"/></svg>',
                // fetch_webpage — download/arrow into box
                fetch_webpage: '<svg viewBox="0 0 16 16"><polyline points="4 8 8 12 12 8"/><line x1="8" y1="2" x2="8" y2="12"/><path d="M2 11v2.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V11"/></svg>',
                // run_subagent — branching nodes
                run_subagent: '<svg viewBox="0 0 16 16"><circle cx="8" cy="3" r="2"/><circle cx="3.5" cy="12.5" r="1.5"/><circle cx="12.5" cy="12.5" r="1.5"/><line x1="8" y1="5" x2="3.5" y2="11"/><line x1="8" y1="5" x2="12.5" y2="11"/></svg>',
            };
            return svgs[name] || '<svg viewBox="0 0 16 16"><polygon points="8 1 10 6 15 6.5 11 10 12.5 15 8 12 3.5 15 5 10 1 6.5 6 6"/></svg>';
        }

        // --- File Attachments ---
        function attachFiles() {
            vscode.postMessage({ type: 'pickFiles' });
        }

        function insertWebPrefix() {
            const input = document.getElementById('chatInput');
            if (!input.value.startsWith('@web ')) {
                input.value = '@web ' + input.value;
            }
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        }

        function clearAttachedFiles() {
            attachedFiles = [];
            renderAttachedFiles();
        }

        function removeAttachedFile(index) {
            attachedFiles.splice(index, 1);
            renderAttachedFiles();
        }

        function renderAttachedFiles() {
            const bar = document.getElementById('attachedFilesBar');
            if (attachedFiles.length === 0) {
                bar.classList.add('hidden');
                bar.innerHTML = '';
                return;
            }
            bar.classList.remove('hidden');
            bar.innerHTML = attachedFiles.map((f, i) => {
                const name = f.path.split('/').pop() || f.path;
                return '<span class="file-chip"><span class="name" title="' + f.path + '">' + name + '</span><span class="remove" data-idx="' + i + '">×</span></span>';
            }).join('');
            bar.querySelectorAll('.remove').forEach(el => {
                el.addEventListener('click', () => {
                    removeAttachedFile(parseInt(el.dataset.idx));
                });
            });
        }

        // --- Settings ---
        function updateSetting(key, value) {
            vscode.postMessage({ type: 'updateSetting', key, value });
        }

        // --- Account ---
        function saveApiKey() {
            const key = document.getElementById('apiKeyInput').value.trim();
            if (!key) return;
            vscode.postMessage({ type: 'setApiKey', apiKey: key });
            document.getElementById('apiKeyInput').value = '';
        }

        function clearApiKey() {
            vscode.postMessage({ type: 'clearApiKey' });
        }

        function validateKey() {
            const key = document.getElementById('apiKeyInput').value.trim();
            if (key) {
                vscode.postMessage({ type: 'validateApiKey', apiKey: key });
            } else {
                vscode.postMessage({ type: 'getBalance' });
            }
        }

        function refreshBalance() {
            vscode.postMessage({ type: 'getBalance' });
        }

        // --- Process Bar ---
        var processStartTime = null;
        var elapsedInterval = null;

        function showProcessBar(text) {
            const bar = document.getElementById('processBar');
            document.getElementById('processText').textContent = text;
            bar.classList.remove('hidden');
            if (!processStartTime) {
                processStartTime = Date.now();
                updateElapsed();
                elapsedInterval = setInterval(updateElapsed, 1000);
            }
        }

        function hideProcessBar() {
            document.getElementById('processBar').classList.add('hidden');
            if (elapsedInterval) {
                clearInterval(elapsedInterval);
                elapsedInterval = null;
            }
            processStartTime = null;
            document.getElementById('elapsedTime').textContent = '';
        }

        function updateElapsed() {
            if (!processStartTime) return;
            var secs = Math.floor((Date.now() - processStartTime) / 1000);
            var m = Math.floor(secs / 60);
            var s = secs % 60;
            document.getElementById('elapsedTime').textContent = (m > 0 ? m + 'm ' : '') + s + 's';
        }

        // --- Token Ring ---
        function updateTokenRing(usedTokens) {
            const maxTokens = 128000;
            const pct = Math.min(usedTokens / maxTokens, 1);
            const circumference = 2 * Math.PI * 6;
            const dashLen = pct * circumference;
            const arc = document.getElementById('tokenArc');
            if (arc) {
                arc.setAttribute('stroke-dasharray', dashLen + ' ' + circumference);
            }
            const pctEl = document.getElementById('tokenPct');
            if (pctEl) pctEl.textContent = Math.round(pct * 100) + '%';
            const ring = document.getElementById('tokenRing');
            if (ring) {
                ring.title = usedTokens.toLocaleString() + ' / ' + maxTokens.toLocaleString() + ' tokens (' + Math.round(pct * 100) + '%)';
                ring.style.opacity = pct > 0.8 ? '0.9' : '0.5';
                if (arc) arc.setAttribute('stroke', pct > 0.8 ? 'var(--vscode-editorWarning-foreground)' : 'currentColor');
            }
        }

        // --- Stop Generation ---
        function stopGeneration() {
            vscode.postMessage({ type: 'stopGeneration' });
            hideProcessBar();
            document.getElementById('stopBtn').classList.add('hidden');
            document.getElementById('sendBtn').classList.remove('hidden');
            document.getElementById('sendBtn').disabled = false;
            isStreaming = false;
            const typing = document.getElementById('typingIndicator');
            if (typing) typing.remove();
            const sl = document.getElementById('agentStatusLine');
            if (sl) sl.remove();
            var afStop = document.getElementById('activityFeed');
            if (afStop) afStop.remove();
            if (currentStreamEl) {
                var afSumStop = currentStreamEl.querySelector('.activity-feed-summary');
                if (afSumStop) afSumStop.remove();
            }
            if (currentStreamEl && !currentStreamRaw) {
                currentStreamEl.remove();
            }
            currentStreamEl = null;
            currentStreamRaw = '';
            addMessage('system', 'Stopped.');
        }

        // --- Message Handler ---
        window.addEventListener('message', event => {
            const data = event.data;
            switch (data.type) {
                case 'streamStart': {
                    isStreaming = true;
                    currentStreamRaw = '';
                    document.getElementById('sendBtn').classList.add('hidden');
                    document.getElementById('stopBtn').classList.remove('hidden');
                    currentStreamEl = addMessage('assistant', '');
                    // Create inline activity feed
                    var feed = document.createElement('div');
                    feed.className = 'activity-feed';
                    feed.id = 'activityFeed';
                    currentStreamEl.appendChild(feed);
                    const typing = document.createElement('div');
                    typing.className = 'typing-indicator';
                    typing.id = 'typingIndicator';
                    typing.innerHTML = '<span></span><span></span><span></span>';
                    currentStreamEl.appendChild(typing);
                    messageCount++;
                    document.getElementById('messageCount').textContent = messageCount;
                    break;
                }
                case 'streamToken': {
                    if (currentStreamEl) {
                        const typing = document.getElementById('typingIndicator');
                        if (typing) typing.remove();
                        // Collapse activity feed into summary when response starts
                        var afTokenFeed = document.getElementById('activityFeed');
                        if (afTokenFeed && !afTokenFeed.classList.contains('collapsed')) {
                            var stepCount = afTokenFeed.querySelectorAll('.activity-step').length;
                            if (stepCount > 0) {
                                afTokenFeed.classList.add('collapsed');
                                var elapsed = processStartTime ? Math.floor((Date.now() - processStartTime) / 1000) : 0;
                                var summaryDiv = document.createElement('div');
                                summaryDiv.className = 'activity-feed-summary';
                                summaryDiv.innerHTML = '<svg viewBox="0 0 16 16"><polyline points="6 4 10 8 6 12"/></svg>'
                                    + '<span>' + stepCount + ' step' + (stepCount !== 1 ? 's' : '') + ' completed'
                                    + (elapsed > 0 ? ' in ' + (elapsed >= 60 ? Math.floor(elapsed/60) + 'm ' : '') + (elapsed % 60) + 's' : '')
                                    + '</span>';
                                summaryDiv.addEventListener('click', function() {
                                    this.classList.toggle('expanded-summary');
                                    afTokenFeed.classList.toggle('collapsed');
                                });
                                currentStreamEl.insertBefore(summaryDiv, currentStreamEl.firstChild);
                            } else {
                                afTokenFeed.remove();
                            }
                        }
                        currentStreamRaw += data.token;
                        // Preserve activity feed / summary + tool calls when reformatting
                        var preservedEls = [];
                        if (currentStreamEl) {
                            var afEl = currentStreamEl.querySelector('.activity-feed');
                            var sumEl = currentStreamEl.querySelector('.activity-feed-summary');
                            var tcEl = currentStreamEl.querySelector('.tool-calls-container');
                            if (afEl) preservedEls.push(afEl);
                            if (sumEl) preservedEls.push(sumEl);
                            if (tcEl) preservedEls.push(tcEl);
                        }
                        currentStreamEl.innerHTML = formatContent(currentStreamRaw);
                        for (var pi = preservedEls.length - 1; pi >= 0; pi--) {
                            currentStreamEl.insertBefore(preservedEls[pi], currentStreamEl.firstChild);
                        }
                        const messages = document.getElementById('chatMessages');
                        messages.scrollTop = messages.scrollHeight;
                    }
                    break;
                }
                case 'streamEnd': {
                    isStreaming = false;
                    document.getElementById('sendBtn').classList.remove('hidden');
                    document.getElementById('sendBtn').disabled = false;
                    document.getElementById('stopBtn').classList.add('hidden');
                    // Finalize activity feed before hiding process bar
                    var afEnd = document.getElementById('activityFeed');
                    if (afEnd) {
                        // Mark last step as done
                        var lastStep = afEnd.querySelector('.activity-step.current');
                        if (lastStep) {
                            lastStep.classList.remove('current');
                            var lsIcon = lastStep.querySelector('.step-icon');
                            if (lsIcon) {
                                lsIcon.classList.remove('spinning');
                                lsIcon.classList.add('done');
                                lsIcon.innerHTML = '<svg viewBox="0 0 16 16"><polyline points="3.5 8.5 6.5 11.5 12.5 5.5"/></svg>';
                            }
                        }
                        // Collapse if not already
                        if (!afEnd.classList.contains('collapsed')) {
                            var endStepCount = afEnd.querySelectorAll('.activity-step').length;
                            if (endStepCount > 0 && currentStreamEl) {
                                afEnd.classList.add('collapsed');
                                var endElapsed = processStartTime ? Math.floor((Date.now() - processStartTime) / 1000) : 0;
                                var endSummary = document.createElement('div');
                                endSummary.className = 'activity-feed-summary';
                                endSummary.innerHTML = '<svg viewBox="0 0 16 16"><polyline points="6 4 10 8 6 12"/></svg>'
                                    + '<span>' + endStepCount + ' step' + (endStepCount !== 1 ? 's' : '') + ' completed'
                                    + (endElapsed > 0 ? ' in ' + (endElapsed >= 60 ? Math.floor(endElapsed/60) + 'm ' : '') + (endElapsed % 60) + 's' : '')
                                    + '</span>';
                                endSummary.addEventListener('click', function() {
                                    this.classList.toggle('expanded-summary');
                                    afEnd.classList.toggle('collapsed');
                                });
                                currentStreamEl.insertBefore(endSummary, currentStreamEl.firstChild);
                            } else if (endStepCount === 0) {
                                afEnd.remove();
                            }
                        }
                        // Remove id so next stream gets a fresh feed
                        afEnd.removeAttribute('id');
                    }
                    hideProcessBar();
                    const typing2 = document.getElementById('typingIndicator');
                    if (typing2) typing2.remove();
                    const sl = document.getElementById('agentStatusLine');
                    if (sl) sl.remove();
                    if (data.usage && data.usage.total_tokens) {
                        chatTokens += data.usage.total_tokens;
                        sessionTokens += data.usage.total_tokens;
                        document.getElementById('sessionTokens').textContent = sessionTokens.toLocaleString();
                        updateTokenRing(chatTokens);
                    }
                    if (data.agentsUsed && data.agentsUsed.length > 0 && currentStreamEl) {
                        const badge = document.createElement('div');
                        badge.className = 'agent-badges';
                        badge.innerHTML = data.agentsUsed.map(a => '<span class="agent-badge">' + a + '</span>').join('');
                        currentStreamEl.prepend(badge);
                    }
                    if (currentStreamEl) {
                        currentChatMessages.push({ role: 'assistant', content: currentStreamRaw || '' });
                        saveCurrentChat();
                    }
                    currentStreamEl = null;
                    currentStreamRaw = '';
                    break;
                }
                case 'error': {
                    isStreaming = false;
                    document.getElementById('sendBtn').classList.remove('hidden');
                    document.getElementById('sendBtn').disabled = false;
                    document.getElementById('stopBtn').classList.add('hidden');
                    hideProcessBar();
                    const errSl = document.getElementById('agentStatusLine');
                    if (errSl) errSl.remove();
                    if (currentStreamEl) {
                        currentStreamEl.remove();
                        currentStreamEl = null;
                    }
                    addMessage('error', data.message);
                    break;
                }
                case 'editStart': {
                    isStreaming = true;
                    document.getElementById('sendBtn').classList.add('hidden');
                    document.getElementById('stopBtn').classList.remove('hidden');
                    showProcessBar('Routing to specialist agents...');
                    break;
                }
                case 'editComplete': {
                    isStreaming = false;
                    document.getElementById('sendBtn').classList.remove('hidden');
                    document.getElementById('sendBtn').disabled = false;
                    document.getElementById('stopBtn').classList.add('hidden');
                    hideProcessBar();
                    if (data.success) {
                        let msg = data.explanation;
                        if (data.agentsUsed) {
                            msg += ' [' + data.agentsUsed.join(', ') + ']';
                        }
                        if (data.totalTokens) {
                            chatTokens += data.totalTokens;
                            sessionTokens += data.totalTokens;
                            document.getElementById('sessionTokens').textContent = sessionTokens.toLocaleString();
                            updateTokenRing(chatTokens);
                        }
                        addMessage('system', msg);
                        currentChatMessages.push({ role: 'system', content: msg });
                        saveCurrentChat();
                    } else {
                        addMessage('error', 'Failed to apply edits.');
                    }
                    break;
                }
                case 'agentStatus': {
                    showProcessBar(data.status);
                    // Skip adding generic/duplicate statuses to the activity feed
                    var statusText = data.status || '';
                    var isGeneric = statusText === 'Working on it...';
                    // Add step to inline activity feed
                    var afeed = document.getElementById('activityFeed');
                    if (afeed && !afeed.classList.contains('collapsed') && !isGeneric) {
                        // Mark previous step as done
                        var prevStep = afeed.querySelector('.activity-step.current');
                        if (prevStep) {
                            prevStep.classList.remove('current');
                            var prevIcon = prevStep.querySelector('.step-icon');
                            if (prevIcon) {
                                prevIcon.classList.remove('spinning');
                                prevIcon.classList.add('done');
                                prevIcon.innerHTML = '<svg viewBox="0 0 16 16"><polyline points="3.5 8.5 6.5 11.5 12.5 5.5"/></svg>';
                            }
                            // Add elapsed to completed step
                            var prevTime = prevStep.querySelector('.step-time');
                            if (prevTime && processStartTime) {
                                var sNow = Math.floor((Date.now() - processStartTime) / 1000);
                                prevTime.textContent = (sNow >= 60 ? Math.floor(sNow/60) + 'm ' : '') + (sNow % 60) + 's';
                            }
                        }
                        // Add new step
                        var step = document.createElement('div');
                        step.className = 'activity-step current';
                        step.innerHTML = ''
                            + '<span class="step-icon spinning"><svg viewBox="0 0 16 16"><path d="M8 1.5A6.5 6.5 0 1 0 14.5 8" stroke-width="1.5"/></svg></span>'
                            + '<span class="step-text">' + escapeHtml(data.status) + '</span>'
                            + '<span class="step-time"></span>';
                        afeed.appendChild(step);
                        var messages = document.getElementById('chatMessages');
                        messages.scrollTop = messages.scrollHeight;
                    }
                    break;
                }
                case 'editProposal': {
                    // Show inline edit approval UI in the chat panel
                    isStreaming = false;
                    document.getElementById('sendBtn').classList.remove('hidden');
                    document.getElementById('sendBtn').disabled = false;
                    document.getElementById('stopBtn').classList.add('hidden');
                    hideProcessBar();

                    const welcome = document.getElementById('welcomeCard');
                    if (welcome) welcome.remove();

                    const messages = document.getElementById('chatMessages');
                    const proposalDiv = document.createElement('div');
                    proposalDiv.className = 'edit-proposal';

                    let diffHtml = '';
                    const editLang = data.language || '';
                    if (data.edits && data.edits.length > 0) {
                        diffHtml = '<div class="edit-proposal-diff">';
                        diffHtml += '<div class="diff-header">' + data.editCount + ' edit' + (data.editCount !== 1 ? 's' : '') + ' proposed</div>';
                        for (const e of data.edits) {
                            diffHtml += renderDiff(e.oldText, e.newText, editLang);
                            // Add a separator between edits if multiple
                            if (data.edits.length > 1 && e !== data.edits[data.edits.length - 1]) {
                                diffHtml += '<div class="diff-line" style="border-top:1px dashed var(--vscode-editorGroup-border,transparent);height:1px;"></div>';
                            }
                        }
                        diffHtml += '</div>';
                    }

                    const agentBadges = (data.agentsUsed || []).map(function(a) {
                        return '<span class="agent-badge">' + a + '</span>';
                    }).join('');

                    proposalDiv.innerHTML = ''
                        + '<div class="edit-proposal-header">'
                        +   agentBadges
                        +   '<span class="edit-proposal-file">' + escapeHtml(data.fileName) + '</span>'
                        + '</div>'
                        + '<div class="edit-proposal-explanation">'
                        +   escapeHtml(data.explanation)
                        +   ' (' + data.editCount + ' edit' + (data.editCount !== 1 ? 's' : '') + ')'
                        + '</div>'
                        + diffHtml
                        + '<div class="edit-proposal-actions">'
                        +   '<button class="btn-apply" id="btnApplyEdit">Apply</button>'
                        +   '<button class="btn-apply-all" id="btnApplyAll">Allow all edits this session</button>'
                        +   '<button class="btn-reject" id="btnRejectEdit">Reject</button>'
                        + '</div>';

                    messages.appendChild(proposalDiv);
                    messages.scrollTop = messages.scrollHeight;

                    document.getElementById('btnApplyEdit').addEventListener('click', function() {
                        vscode.postMessage({ type: 'approveEdit' });
                        proposalDiv.querySelector('.edit-proposal-actions').innerHTML = '<span style="color:var(--vscode-textLink-foreground);font-size:11px;">Applying...</span>';
                    });
                    document.getElementById('btnApplyAll').addEventListener('click', function() {
                        vscode.postMessage({ type: 'approveAllEdits' });
                        proposalDiv.querySelector('.edit-proposal-actions').innerHTML = '<span style="color:var(--vscode-textLink-foreground);font-size:11px;">Auto-approve enabled. Applying...</span>';
                    });
                    document.getElementById('btnRejectEdit').addEventListener('click', function() {
                        vscode.postMessage({ type: 'rejectEdit' });
                        proposalDiv.querySelector('.edit-proposal-actions').innerHTML = '<span style="color:var(--vscode-descriptionForeground);font-size:11px;">Rejected</span>';
                    });
                    break;
                }
                case 'editCancelled': {
                    isStreaming = false;
                    document.getElementById('sendBtn').classList.remove('hidden');
                    document.getElementById('sendBtn').disabled = false;
                    document.getElementById('stopBtn').classList.add('hidden');
                    hideProcessBar();
                    addMessage('system', 'Edit cancelled.');
                    break;
                }
                case 'generationStopped': {
                    isStreaming = false;
                    document.getElementById('sendBtn').classList.remove('hidden');
                    document.getElementById('sendBtn').disabled = false;
                    document.getElementById('stopBtn').classList.add('hidden');
                    hideProcessBar();
                    const gsTyping = document.getElementById('typingIndicator');
                    if (gsTyping) gsTyping.remove();
                    const gsSl = document.getElementById('agentStatusLine');
                    if (gsSl) gsSl.remove();
                    var afGS = document.getElementById('activityFeed');
                    if (afGS) afGS.remove();
                    if (currentStreamEl) {
                        var afSumGS = currentStreamEl.querySelector('.activity-feed-summary');
                        if (afSumGS) afSumGS.remove();
                    }
                    if (currentStreamEl && !currentStreamRaw) {
                        currentStreamEl.remove();
                    }
                    currentStreamEl = null;
                    currentStreamRaw = '';
                    addMessage('system', 'Stopped.');
                    break;
                }
                case 'apiKeyStatus': {
                    const dot = document.getElementById('statusDot');
                    const text = document.getElementById('statusText');
                    if (data.hasKey) {
                        dot.className = 'status-dot connected';
                        text.textContent = 'API key configured';
                    } else {
                        dot.className = 'status-dot disconnected';
                        text.textContent = 'No API key set';
                    }
                    break;
                }
                case 'apiKeyValidation': {
                    if (data.valid) {
                        addMessage('system', '✅ API key is valid!');
                    } else {
                        addMessage('error', '❌ API key is invalid.');
                    }
                    break;
                }
                case 'settings': {
                    const s = data.settings;
                    document.getElementById('setting-model').value = s.model;
                    document.getElementById('setting-temperature').value = s.temperature;
                    document.getElementById('temp-value').textContent = s.temperature;
                    document.getElementById('setting-maxTokens').value = s.maxTokens;
                    document.getElementById('setting-topP').value = s.topP;
                    document.getElementById('topp-value').textContent = s.topP;
                    document.getElementById('setting-frequencyPenalty').value = s.frequencyPenalty;
                    document.getElementById('freq-value').textContent = s.frequencyPenalty;
                    document.getElementById('setting-presencePenalty').value = s.presencePenalty;
                    document.getElementById('pres-value').textContent = s.presencePenalty;
                    document.getElementById('setting-streamResponses').checked = s.stream;
                    break;
                }
                case 'balance': {
                    if (data.balance) {
                        document.getElementById('availableBalance').textContent = '$' + data.balance.available;
                        document.getElementById('usedBalance').textContent = '$' + data.balance.used;
                    } else {
                        document.getElementById('availableBalance').textContent = data.error || 'Unavailable';
                    }
                    break;
                }
                case 'historyCleared': {
                    break;
                }
                case 'webSearchResults': {
                    hideProcessBar();
                    if (data.error) {
                        addMessage('system', 'Web search failed: ' + data.error);
                    } else {
                        addMessage('system', 'Web search for "' + escapeHtml(data.query) + '":\\n' + escapeHtml(data.results));
                    }
                    break;
                }
                case 'filesAttached': {
                    if (data.files && data.files.length > 0) {
                        const existingPaths = new Set(attachedFiles.map(f => f.fullPath));
                        for (const f of data.files) {
                            if (!existingPaths.has(f.fullPath)) {
                                attachedFiles.push(f);
                            }
                        }
                        renderAttachedFiles();
                    }
                    break;
                }
                case 'fileSearchResults': {
                    if (hashStart >= 0) {
                        showFileDropdown(data.files || []);
                    }
                    break;
                }
                case 'chatList': {
                    renderChatList(data.chats || []);
                    break;
                }
                case 'toolCall': {
                    // A tool was called during the agent loop
                    if (currentStreamEl) {
                        let container = currentStreamEl.querySelector('.tool-calls-container');
                        if (!container) {
                            container = document.createElement('div');
                            container.className = 'tool-calls-container';
                            currentStreamEl.appendChild(container);
                        }

                        const block = document.createElement('div');
                        block.className = 'tool-call-block';
                        block.id = 'tc-' + (data.callId || Date.now());
                        block.dataset.toolName = data.name;

                        const summary = data.args && data.args.path ? data.args.path
                            : data.args && data.args.query ? data.args.query
                            : data.args && data.args.pattern ? data.args.pattern
                            : data.args && data.args.command ? data.args.command.substring(0, 60)
                            : data.args && data.args.task ? data.args.task.substring(0, 60)
                            : '';

                        var spinnerSvg = '<svg viewBox="0 0 16 16"><path d="M8 1.5A6.5 6.5 0 1 0 14.5 8" stroke-width="1.5"/></svg>';
                        var chevronSvg = '<svg viewBox="0 0 16 16"><polyline points="6 4 10 8 6 12"/></svg>';

                        block.innerHTML = ''
                            + '<div class="tool-call-header">'
                            +   '<span class="tool-call-icon spinning">' + spinnerSvg + '</span>'
                            +   '<span class="tool-call-name">' + escapeHtml(data.name) + '</span>'
                            +   '<span class="tool-call-summary">' + escapeHtml(summary) + '</span>'
                            +   '<span class="tool-call-chevron">' + chevronSvg + '</span>'
                            + '</div>'
                            + '<div class="tool-call-details">Running...</div>';

                        block.querySelector('.tool-call-header').addEventListener('click', function() {
                            this.parentElement.classList.toggle('expanded');
                        });

                        container.appendChild(block);
                        const messages = document.getElementById('chatMessages');
                        messages.scrollTop = messages.scrollHeight;
                    }
                    break;
                }
                case 'toolResult': {
                    const block = document.getElementById('tc-' + data.callId);
                    if (block) {
                        const icon = block.querySelector('.tool-call-icon');
                        icon.classList.remove('spinning');
                        if (data.success) {
                            icon.innerHTML = getToolSvg(block.dataset.toolName || data.name);
                            icon.className = 'tool-call-icon tool-call-status-success';
                        } else {
                            icon.innerHTML = '<svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
                            icon.className = 'tool-call-icon tool-call-status-fail';
                        }
                        const details = block.querySelector('.tool-call-details');
                        if (details) {
                            const output = (data.output || '').substring(0, 2000);
                            details.textContent = output + (data.output && data.output.length > 2000 ? '\\n... (truncated)' : '');
                        }
                    }
                    break;
                }
            }
        });

        // Initial load
        vscode.postMessage({ type: 'getApiKeyStatus' });
        vscode.postMessage({ type: 'getSettings' });
    </script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
