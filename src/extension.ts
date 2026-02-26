import * as vscode from 'vscode';
import { DeepSeekService } from './deepseekService';
import { FileEditorService } from './fileEditorService';
import { SidebarProvider } from './sidebarProvider';
import { SubAgentService } from './subAgentService';

let sidebarProvider: SidebarProvider;

export function activate(context: vscode.ExtensionContext) {
    console.log('DeepCode extension is now active!');

    const deepseekService = new DeepSeekService();
    const fileEditorService = new FileEditorService();
    const subAgentService = new SubAgentService();

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
    console.log('DeepCode extension deactivated.');
}
