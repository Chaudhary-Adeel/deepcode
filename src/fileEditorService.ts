import * as vscode from 'vscode';

export interface FileEdit {
    oldText: string;
    newText: string;
}

export interface EditResult {
    edits: FileEdit[];
    explanation: string;
}

export class FileEditorService {

    /**
     * Parse the AI response JSON into structured edits.
     * Tries multiple strategies to extract valid JSON from the response.
     */
    parseEditResponse(response: string): EditResult {
        let jsonStr = response.trim();

        // Strategy 1: Remove markdown code block wrappers (```json ... ``` or ``` ... ```)
        const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonBlockMatch) {
            jsonStr = jsonBlockMatch[1].trim();
        }

        // Strategy 2: Try to find a JSON object starting with { and ending with }
        if (!jsonStr.startsWith('{')) {
            const braceStart = jsonStr.indexOf('{');
            const braceEnd = jsonStr.lastIndexOf('}');
            if (braceStart !== -1 && braceEnd > braceStart) {
                jsonStr = jsonStr.substring(braceStart, braceEnd + 1);
            }
        }

        try {
            const parsed = JSON.parse(jsonStr);
            if (!parsed.edits || !Array.isArray(parsed.edits)) {
                throw new Error('Response missing "edits" array');
            }
            return {
                edits: parsed.edits.map((e: any) => ({
                    oldText: String(e.oldText || ''),
                    newText: String(e.newText || ''),
                })),
                explanation: String(parsed.explanation || 'No explanation provided'),
            };
        } catch (firstError) {
            // Strategy 3: Try to fix common JSON issues (trailing commas, unescaped newlines)
            try {
                const cleaned = jsonStr
                    .replace(/,\s*}/g, '}')     // trailing comma before }
                    .replace(/,\s*]/g, ']')     // trailing comma before ]
                    .replace(/\n/g, '\\n')       // unescaped newlines in strings
                    .replace(/\t/g, '\\t');       // unescaped tabs
                
                // Re-extract JSON object boundaries after cleaning
                const start = cleaned.indexOf('{');
                const end = cleaned.lastIndexOf('}');
                if (start !== -1 && end > start) {
                    const parsed = JSON.parse(cleaned.substring(start, end + 1));
                    if (parsed.edits && Array.isArray(parsed.edits)) {
                        return {
                            edits: parsed.edits.map((e: any) => ({
                                oldText: String(e.oldText || ''),
                                newText: String(e.newText || ''),
                            })),
                            explanation: String(parsed.explanation || 'No explanation provided'),
                        };
                    }
                }
            } catch { /* cleaning didn't help */ }

            throw new Error(`Failed to parse edit response: ${firstError}. Raw: ${response.substring(0, 200)}`);
        }
    }

    /**
     * Apply edits to a document with diff preview
     */
    async applyEdits(document: vscode.TextDocument, editResult: EditResult): Promise<boolean> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== document) {
            vscode.window.showErrorMessage('No active editor for the target file.');
            return false;
        }

        const content = document.getText();
        let newContent = content;
        let appliedCount = 0;

        for (const edit of editResult.edits) {
            if (!edit.oldText && edit.newText) {
                // Append mode
                newContent += '\n' + edit.newText;
                appliedCount++;
            } else if (newContent.includes(edit.oldText)) {
                newContent = newContent.replace(edit.oldText, edit.newText);
                appliedCount++;
            } else {
                // Try fuzzy match (ignore whitespace differences)
                const fuzzyOld = edit.oldText.replace(/\s+/g, '\\s+');
                const regex = new RegExp(fuzzyOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\s\+/g, '\\s+'));
                const match = newContent.match(regex);
                if (match) {
                    newContent = newContent.replace(match[0], edit.newText);
                    appliedCount++;
                } else {
                    vscode.window.showWarningMessage(
                        `Could not find text to replace: "${edit.oldText.substring(0, 50)}..."`
                    );
                }
            }
        }

        if (appliedCount === 0) {
            vscode.window.showErrorMessage('No edits could be applied.');
            return false;
        }

        // Apply the full edit
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(content.length)
        );

        const success = await editor.edit((editBuilder) => {
            editBuilder.replace(fullRange, newContent);
        });

        if (success) {
            // Auto-save if configured
            const autoSave = vscode.workspace.getConfiguration('deepcode').get<boolean>('autoSave', false);
            if (autoSave) {
                await document.save();
            }
            vscode.window.showInformationMessage(
                `DeepCode: Applied ${appliedCount}/${editResult.edits.length} edit(s). ${editResult.explanation}`
            );
        }

        return success;
    }

    /**
     * Get file content with line numbers for context
     */
    getFileContentWithLineNumbers(document: vscode.TextDocument): string {
        const lines = document.getText().split('\n');
        return lines.map((line, i) => `${i + 1} | ${line}`).join('\n');
    }

    /**
     * Get the content of the active editor's selection or full file
     */
    getActiveEditorContent(): { content: string; fileName: string; selection?: string; language: string } | null {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return null; }

        const document = editor.document;
        const selection = editor.selection;
        const selectedText = !selection.isEmpty ? document.getText(selection) : undefined;

        return {
            content: document.getText(),
            fileName: document.fileName,
            selection: selectedText,
            language: document.languageId,
        };
    }

    /**
     * Get workspace file tree for context
     */
    async getWorkspaceTree(maxDepth: number = 3): Promise<string> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return 'No workspace open'; }

        const root = workspaceFolders[0].uri;
        const tree: string[] = [];
        await this.buildTree(root, '', maxDepth, tree);
        return tree.join('\n');
    }

    private async buildTree(
        uri: vscode.Uri,
        prefix: string,
        depth: number,
        result: string[]
    ): Promise<void> {
        if (depth <= 0) { return; }

        try {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            const filtered = entries.filter(([name]) => 
                !name.startsWith('.') && 
                name !== 'node_modules' && 
                name !== 'out' && 
                name !== 'dist' &&
                name !== '__pycache__'
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
            // Permission denied or other error
        }
    }

    /**
     * Read a file from workspace by relative path
     */
    async readWorkspaceFile(relativePath: string): Promise<string | null> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return null; }

        try {
            const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, relativePath);
            const content = await vscode.workspace.fs.readFile(fileUri);
            return Buffer.from(content).toString('utf-8');
        } catch {
            return null;
        }
    }

    /**
     * Create or overwrite a file in the workspace
     */
    async writeWorkspaceFile(relativePath: string, content: string): Promise<boolean> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return false; }

        try {
            const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, relativePath);
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Open a file in the editor
     */
    async openFile(relativePath: string): Promise<vscode.TextEditor | null> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return null; }

        try {
            const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, relativePath);
            const document = await vscode.workspace.openTextDocument(fileUri);
            return await vscode.window.showTextDocument(document);
        } catch {
            return null;
        }
    }
}
