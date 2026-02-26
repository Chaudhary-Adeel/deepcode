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

        // Helper: attempt to parse and validate the expected edit JSON structure
        const tryParseEdits = (str: string): EditResult | null => {
            try {
                const parsed = JSON.parse(str);
                if (parsed.edits && Array.isArray(parsed.edits)) {
                    return {
                        edits: parsed.edits.map((e: any) => ({
                            oldText: String(e.oldText || ''),
                            newText: String(e.newText || ''),
                        })),
                        explanation: String(parsed.explanation || 'No explanation provided'),
                    };
                }
            } catch { /* not valid */ }
            return null;
        };

        // Strategy 2b: Direct parse
        const direct = tryParseEdits(jsonStr);
        if (direct) { return direct; }

        // Strategy 3: Repair JSON with unescaped newlines/tabs inside string values.
        // Walk character-by-character so we only escape control chars INSIDE
        // quoted strings, leaving the structural JSON whitespace intact.
        try {
            const repaired = this.repairJsonStrings(jsonStr);
            const start = repaired.indexOf('{');
            const end = repaired.lastIndexOf('}');
            if (start !== -1 && end > start) {
                const candidate = repaired.substring(start, end + 1);
                const parsed = tryParseEdits(candidate);
                if (parsed) { return parsed; }
            }
        } catch { /* repair didn't help */ }

        // Strategy 4: Fix trailing commas then retry repair
        try {
            const cleaned = jsonStr
                .replace(/,\s*}/g, '}')
                .replace(/,\s*]/g, ']');
            const repaired = this.repairJsonStrings(cleaned);
            const start = repaired.indexOf('{');
            const end = repaired.lastIndexOf('}');
            if (start !== -1 && end > start) {
                const parsed = tryParseEdits(repaired.substring(start, end + 1));
                if (parsed) { return parsed; }
            }
        } catch { /* still didn't help */ }

        // Strategy 5: Regex extraction — pull oldText/newText values directly
        try {
            const edits: FileEdit[] = [];
            // Match "oldText" : "..." , "newText" : "..." allowing for escaped quotes
            const editPattern = /"oldText"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"newText"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
            let m;
            while ((m = editPattern.exec(jsonStr)) !== null) {
                edits.push({
                    oldText: m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
                    newText: m[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
                });
            }
            if (edits.length > 0) {
                const explMatch = jsonStr.match(/"explanation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                return {
                    edits,
                    explanation: explMatch
                        ? explMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
                        : 'No explanation provided',
                };
            }
        } catch { /* regex extraction failed */ }

        throw new Error(`Failed to parse edit response: not valid JSON. Raw: ${response.substring(0, 200)}`);
    }

    /**
     * Repair a JSON string by escaping control characters (newlines, tabs, etc.)
     * that appear inside quoted string values, while leaving structural
     * JSON whitespace intact.
     */
    private repairJsonStrings(input: string): string {
        const out: string[] = [];
        let inString = false;
        let escaped = false;

        for (let i = 0; i < input.length; i++) {
            const ch = input[i];

            if (escaped) {
                out.push(ch);
                escaped = false;
                continue;
            }

            if (ch === '\\' && inString) {
                escaped = true;
                out.push(ch);
                continue;
            }

            if (ch === '"') {
                inString = !inString;
                out.push(ch);
                continue;
            }

            if (inString) {
                // Escape control characters that break JSON string values
                if (ch === '\n') { out.push('\\n'); continue; }
                if (ch === '\r') { out.push('\\r'); continue; }
                if (ch === '\t') { out.push('\\t'); continue; }
                // Escape other control characters (U+0000–U+001F)
                const code = ch.charCodeAt(0);
                if (code < 0x20) {
                    out.push('\\u' + code.toString(16).padStart(4, '0'));
                    continue;
                }
            }

            out.push(ch);
        }

        return out.join('');
    }

    /**
     * Apply edits to a document with diff preview
     */
    async applyEdits(document: vscode.TextDocument, editResult: EditResult): Promise<boolean> {
        // Read current file content from disk (fresh, not stale)
        let content: string;
        try {
            const bytes = await vscode.workspace.fs.readFile(document.uri);
            content = Buffer.from(bytes).toString('utf-8');
        } catch {
            content = document.getText();
        }

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
                        `Could not find text to replace: "${edit.oldText.substring(0, 80)}..."`
                    );
                }
            }
        }

        if (appliedCount === 0) {
            vscode.window.showErrorMessage(
                `DeepCode: No edits could be applied. The file may have changed since the edit was proposed.`
            );
            return false;
        }

        // Apply using WorkspaceEdit — does NOT require opening the file
        const wsEdit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(content.length)
        );
        wsEdit.replace(document.uri, fullRange, newContent);
        const success = await vscode.workspace.applyEdit(wsEdit);

        if (success) {
            // Always auto-save after applying edits
            try {
                const doc = await vscode.workspace.openTextDocument(document.uri);
                await doc.save();
            } catch {
                // Non-critical — edit was applied, save failed
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
     * Search workspace file contents for a text pattern, returning matches with context lines.
     */
    async searchWorkspaceContent(
        query: string,
        maxResults: number = 10,
    ): Promise<Array<{ file: string; line: number; preview: string }>> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || !query.trim()) { return []; }

        const results: Array<{ file: string; line: number; preview: string }> = [];
        const queryLower = query.toLowerCase();

        try {
            const files = await vscode.workspace.findFiles(
                '**/*.{ts,js,tsx,jsx,py,java,cs,go,rs,rb,php,cpp,c,h,mjs,cjs}',
                '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/__pycache__/**}',
                100,
            );

            for (const fileUri of files) {
                if (results.length >= maxResults) { break; }
                try {
                    const bytes = await vscode.workspace.fs.readFile(fileUri);
                    const text = Buffer.from(bytes).toString('utf-8');
                    if (text.includes('\0')) { continue; } // skip binary
                    const lines = text.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].toLowerCase().includes(queryLower)) {
                            const start = Math.max(0, i - 1);
                            const end = Math.min(lines.length - 1, i + 2);
                            results.push({
                                file: fileUri.fsPath,
                                line: i + 1,
                                preview: lines.slice(start, end + 1).join('\n'),
                            });
                            if (results.length >= maxResults) { break; }
                        }
                    }
                } catch { /* skip unreadable */ }
            }
        } catch { /* workspace not available */ }

        return results;
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
