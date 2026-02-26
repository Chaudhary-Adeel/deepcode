import * as vscode from 'vscode';
import { DeepSeekService } from './deepseekService';
import { FileEditorService } from './fileEditorService';
import { SidebarProvider } from './sidebarProvider';
import { SubAgentService } from './subAgentService';
import { DirtyTracker } from './dirtyTracker';
import { IndexEngine } from './indexEngine';
import { SymbolGraph } from './symbolGraph';
import { CodeSearch } from './codeSearch';

let sidebarProvider: SidebarProvider;
let statusBarItem: vscode.StatusBarItem;

// Singleton references for cross-module access
let indexEngineInstance: IndexEngine | undefined;
let symbolGraphInstance: SymbolGraph | undefined;
let codeSearchInstance: CodeSearch | undefined;

/** Get the global IndexEngine instance (undefined if no workspace) */
export function getIndexEngine(): IndexEngine | undefined { return indexEngineInstance; }
/** Get the global SymbolGraph instance (undefined if no workspace) */
export function getSymbolGraph(): SymbolGraph | undefined { return symbolGraphInstance; }
/** Get the global CodeSearch instance (undefined if no workspace) */
export function getCodeSearch(): CodeSearch | undefined { return codeSearchInstance; }

export function activate(context: vscode.ExtensionContext) {
    console.log('DeepCode extension is now active!');

    const deepseekService = new DeepSeekService();
    const fileEditorService = new FileEditorService();
    const subAgentService = new SubAgentService();

    // ── Status Bar Item ──────────────────────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(symbol-misc) DeepCode: ready';
    statusBarItem.tooltip = 'Click to re-index dirty files';
    statusBarItem.command = 'deepcode.rebuildIndex';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Initialize Dirty Tracker + Index Engine + Symbol Graph + Embeddings
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        const dirtyTracker = new DirtyTracker(workspaceRoot);
        context.subscriptions.push(dirtyTracker);

        const indexEngine = new IndexEngine(workspaceRoot, context.extensionPath, dirtyTracker);
        context.subscriptions.push(indexEngine);
        indexEngineInstance = indexEngine;

        const symbolGraph = new SymbolGraph(indexEngine);
        symbolGraphInstance = symbolGraph;

        const codeSearch = new CodeSearch(workspaceRoot);
        context.subscriptions.push(codeSearch);
        codeSearchInstance = codeSearch;

        // Track indexing progress in status bar
        indexEngine.onDidProgress(({ indexed, total }) => {
            const pct = Math.round((indexed / total) * 100);
            statusBarItem.text = `$(sync~spin) DeepCode: indexing ${pct}%`;
        });

        // Reset status bar when indexing finishes
        indexEngine.onDidComplete(() => {
            const dirtyCount = dirtyTracker.getDirtyCount();
            statusBarItem.text = dirtyCount > 0
                ? `$(symbol-misc) DeepCode: ready (${dirtyCount} dirty)`
                : '$(symbol-misc) DeepCode: ready';
        });

        // Initialize pipeline: dirty tracker → index engine → code search (fire-and-forget)
        dirtyTracker.initialize().then(() => {
            indexEngine.initialize().then(() => {
                // Load symbol graph from cached entries
                const cachedMap = indexEngine.getAllCached();
                symbolGraph.loadFromCache(cachedMap);
                // Load code search from cached entries
                codeSearch.initialize().then(() => {
                    codeSearch.loadFromEntries(Array.from(cachedMap.values()));
                }).catch(() => {});
                // Update status bar
                const dirtyCount = dirtyTracker.getDirtyCount();
                statusBarItem.text = dirtyCount > 0
                    ? `$(symbol-misc) DeepCode: ready (${dirtyCount} dirty)`
                    : '$(symbol-misc) DeepCode: ready';
            }).catch(err => {
                console.error('DeepCode: IndexEngine init failed:', err);
                statusBarItem.text = '$(warning) DeepCode: index error';
            });
        });

        // Rebuild symbol graph + code search whenever a file is indexed
        indexEngine.onDidIndex(entry => {
            symbolGraph.updateFromEntry(entry);
            codeSearch.updateFromEntry(entry);
        });

        // Update status bar when dirty count changes
        dirtyTracker.onDidChange(() => {
            const count = dirtyTracker.getDirtyCount();
            statusBarItem.text = count > 0
                ? `$(symbol-misc) DeepCode: ready (${count} dirty)`
                : '$(symbol-misc) DeepCode: ready';
        });
    }

    // Register Sidebar Webview
    sidebarProvider = new SidebarProvider(
        context.extensionUri,
        context,
        deepseekService,
        fileEditorService
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SidebarProvider.viewType,
            sidebarProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Command: Set API Key
    context.subscriptions.push(
        vscode.commands.registerCommand('deepcode.setApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your DeepSeek API Key',
                placeHolder: 'sk-...',
                password: true,
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'API key cannot be empty';
                    }
                    return null;
                },
            });

            if (key) {
                await deepseekService.setApiKey(context, key.trim());
                vscode.window.showInformationMessage('DeepCode: API key saved securely.');
                sidebarProvider.postMessage({ type: 'apiKeyStatus', hasKey: true });
            }
        })
    );

    // Command: Clear API Key
    context.subscriptions.push(
        vscode.commands.registerCommand('deepcode.clearApiKey', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Are you sure you want to remove your DeepSeek API key?',
                'Yes',
                'No'
            );
            if (confirm === 'Yes') {
                await deepseekService.clearApiKey(context);
                vscode.window.showInformationMessage('DeepCode: API key removed.');
                sidebarProvider.postMessage({ type: 'apiKeyStatus', hasKey: false });
            }
        })
    );

    // Command: Edit Current File with AI
    context.subscriptions.push(
        vscode.commands.registerCommand('deepcode.editFile', async () => {
            const apiKey = await deepseekService.getApiKey(context);
            if (!apiKey) {
                const action = await vscode.window.showErrorMessage(
                    'DeepCode: No API key configured.',
                    'Set API Key'
                );
                if (action === 'Set API Key') {
                    vscode.commands.executeCommand('deepcode.setApiKey');
                }
                return;
            }

            const editorContent = fileEditorService.getActiveEditorContent();
            if (!editorContent) {
                vscode.window.showErrorMessage('DeepCode: No file is currently open.');
                return;
            }

            const instruction = await vscode.window.showInputBox({
                prompt: 'What would you like to change?',
                placeHolder: 'e.g., Add error handling, optimize this function, fix the bug...',
                ignoreFocusOut: true,
            });

            if (!instruction) { return; }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'DeepCode: Agents reviewing code...',
                    cancellable: false,
                },
                async (progress) => {
                    try {
                        const cfg = deepseekService.getConfig();
                        const result = await subAgentService.orchestrateEdit(
                            apiKey,
                            cfg.model,
                            editorContent.content,
                            editorContent.fileName,
                            instruction,
                            editorContent.selection,
                            cfg.temperature,
                            cfg.topP,
                            (status) => {
                                progress.report({ message: status });
                            },
                        );

                        const editResult = result.editResult || fileEditorService.parseEditResponse(result.content);

                        const action = await vscode.window.showInformationMessage(
                            `DeepCode [${result.agentsUsed.join(', ')}]: ${editResult.explanation}`,
                            'Apply',
                            'Cancel'
                        );

                        if (action === 'Apply') {
                            const editor = vscode.window.activeTextEditor;
                            if (editor) {
                                await fileEditorService.applyEdits(editor.document, editResult);
                            }
                        }
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`DeepCode: ${error.message}`);
                    }
                }
            );
        })
    );

    // Command: Explain Selected Code
    context.subscriptions.push(
        vscode.commands.registerCommand('deepcode.explainCode', async () => {
            const apiKey = await deepseekService.getApiKey(context);
            if (!apiKey) {
                vscode.window.showErrorMessage('DeepCode: No API key configured. Use "DeepCode: Set API Key" command.');
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty) {
                vscode.window.showErrorMessage('DeepCode: Please select some code first.');
                return;
            }

            const selectedText = editor.document.getText(editor.selection);
            const language = editor.document.languageId;

            sidebarProvider.postMessage({ type: 'streamStart' });

            try {
                const cfg = deepseekService.getConfig();
                const result = await subAgentService.orchestrateChat(
                    apiKey,
                    cfg.model,
                    `Explain this ${language} code in detail:\n\`\`\`${language}\n${selectedText}\n\`\`\``,
                    '',
                    cfg.temperature,
                    cfg.topP,
                    (status) => {
                        sidebarProvider.postMessage({ type: 'agentStatus', status });
                    },
                );

                // Emit synthesized content to sidebar
                const content = result.content;
                const chunkSize = 20;
                for (let i = 0; i < content.length; i += chunkSize) {
                    sidebarProvider.postMessage({ type: 'streamToken', token: content.substring(i, i + chunkSize) });
                }

                sidebarProvider.postMessage({
                    type: 'streamEnd',
                    usage: { total_tokens: result.totalTokens, prompt_tokens: 0, completion_tokens: 0 },
                    agentsUsed: result.agentsUsed,
                });
            } catch (error: any) {
                sidebarProvider.postMessage({ type: 'error', message: error.message });
            }

            // Focus the sidebar
            vscode.commands.executeCommand('deepcode.chatView.focus');
        })
    );

    // Command: Refactor Selected Code
    context.subscriptions.push(
        vscode.commands.registerCommand('deepcode.refactorCode', async () => {
            const apiKey = await deepseekService.getApiKey(context);
            if (!apiKey) {
                vscode.window.showErrorMessage('DeepCode: No API key configured.');
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty) {
                vscode.window.showErrorMessage('DeepCode: Please select some code first.');
                return;
            }

            const editorContent = fileEditorService.getActiveEditorContent();
            if (!editorContent || !editorContent.selection) { return; }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'DeepCode: Agents refactoring code...',
                    cancellable: false,
                },
                async (progress) => {
                    try {
                        const cfg = deepseekService.getConfig();
                        const result = await subAgentService.orchestrateEdit(
                            apiKey,
                            cfg.model,
                            editorContent.content,
                            editorContent.fileName,
                            'Refactor the selected code to improve readability, performance, and follow best practices. Keep the same functionality.',
                            editorContent.selection,
                            cfg.temperature,
                            cfg.topP,
                            (status) => {
                                progress.report({ message: status });
                            },
                        );

                        const editResult = result.editResult || fileEditorService.parseEditResponse(result.content);

                        const action = await vscode.window.showInformationMessage(
                            `DeepCode Refactor [${result.agentsUsed.join(', ')}]: ${editResult.explanation}`,
                            'Apply',
                            'Cancel'
                        );

                        if (action === 'Apply') {
                            await fileEditorService.applyEdits(editor.document, editResult);
                        }
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`DeepCode: ${error.message}`);
                    }
                }
            );
        })
    );

    // Command: Open Settings
    context.subscriptions.push(
        vscode.commands.registerCommand('deepcode.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'deepcode');
        })
    );

    // Command: Rebuild Symbol Index
    context.subscriptions.push(
        vscode.commands.registerCommand('deepcode.rebuildIndex', async () => {
            if (!indexEngineInstance) {
                vscode.window.showWarningMessage('DeepCode: No workspace open — cannot rebuild index.');
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'DeepCode: Rebuilding symbol index...',
                    cancellable: true,
                },
                async (_progress, token) => {
                    statusBarItem.text = '$(sync~spin) DeepCode: rebuilding...';
                    await indexEngineInstance!.rebuildAll(token);
                    if (symbolGraphInstance) {
                        symbolGraphInstance.loadFromCache(indexEngineInstance!.getAllCached());
                    }
                    statusBarItem.text = '$(symbol-misc) DeepCode: ready';
                    vscode.window.showInformationMessage('DeepCode: Symbol index rebuilt successfully.');
                }
            );
        })
    );

    // Command: Fix Selected Code with AI
    context.subscriptions.push(
        vscode.commands.registerCommand('deepcode.fixCode', async () => {
            const apiKey = await deepseekService.getApiKey(context);
            if (!apiKey) {
                vscode.window.showErrorMessage('DeepCode: No API key configured.');
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty) {
                vscode.window.showErrorMessage('DeepCode: Please select the code with the issue.');
                return;
            }

            const editorContent = fileEditorService.getActiveEditorContent();
            if (!editorContent || !editorContent.selection) { return; }

            // Get diagnostics for the selected range
            const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
                .filter(d => editor.selection.contains(d.range))
                .map(d => `${d.severity === 0 ? 'Error' : 'Warning'}: ${d.message} (line ${d.range.start.line + 1})`)
                .join('\n');

            const instruction = diagnostics
                ? `Fix the following issues in the selected code:\n${diagnostics}`
                : 'Fix any bugs, errors, or issues in the selected code.';

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'DeepCode: Fixing code...',
                    cancellable: false,
                },
                async (progress) => {
                    try {
                        const cfg = deepseekService.getConfig();
                        const result = await subAgentService.orchestrateEdit(
                            apiKey,
                            cfg.model,
                            editorContent.content,
                            editorContent.fileName,
                            instruction,
                            editorContent.selection,
                            cfg.temperature,
                            cfg.topP,
                            (status) => { progress.report({ message: status }); },
                        );

                        const editResult = result.editResult || fileEditorService.parseEditResponse(result.content);
                        const action = await vscode.window.showInformationMessage(
                            `DeepCode Fix [${result.agentsUsed.join(', ')}]: ${editResult.explanation}`,
                            'Apply',
                            'Cancel'
                        );

                        if (action === 'Apply') {
                            await fileEditorService.applyEdits(editor.document, editResult);
                        }
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`DeepCode: ${error.message}`);
                    }
                }
            );
        })
    );

    // Check for API key on startup and prompt if not set
    (async () => {
        const apiKey = await deepseekService.getApiKey(context);
        if (!apiKey) {
            const action = await vscode.window.showInformationMessage(
                'DeepCode: Welcome! Set up your DeepSeek API key to get started.',
                'Set API Key',
                'Later'
            );
            if (action === 'Set API Key') {
                vscode.commands.executeCommand('deepcode.setApiKey');
            }
        }
    })();
}

export function deactivate() {
    statusBarItem?.dispose();
    console.log('DeepCode extension deactivated.');
}
