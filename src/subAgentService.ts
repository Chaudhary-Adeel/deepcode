import * as vscode from 'vscode';
import {
    AgentLoop,
    AGENT_SYSTEM_PROMPT,
    AgentLoopResult,
    AgentMessage,
} from './agentLoop';
import {
    ToolExecutor,
    ToolCallResult,
    AGENT_TOOLS,
    SUBAGENT_TOOLS,
} from './tools';
import { ContextManager } from './contextManager';
import { MemoryService } from './memoryService';

/**
 * Sub-Agent Service for DeepCode — v3 (Agentic Tool-Use Architecture)
 *
 * Architecture:
 *   Full agentic loop with tool use for both chat and edit flows.
 *   Uses AgentLoop + ToolExecutor to iteratively think, act, and observe.
 *
 *   For edits:
 *     1. Agent reads the file with read_file
 *     2. Agent plans and applies edits with edit_file
 *     3. Agent verifies with get_diagnostics
 *     4. Service extracts applied edits for caller approval workflow
 *
 *   For chat:
 *     1. Agent explores codebase with tools (read_file, grep_search, etc.)
 *     2. Agent reasons and responds with full context
 *     3. Agent can spawn sub-agents for parallel investigation
 */

// ─── Types (backward compatible) ────────────────────────────────────────────

export type AgentRole = 'frontend' | 'backend' | 'patterns' | 'logic';

export interface AgentResult {
    role: AgentRole;
    content: string;
    tokens: number;
}

export interface OrchestratedResponse {
    content: string;
    agentResults: AgentResult[];
    totalTokens: number;
    agentsUsed: AgentRole[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 25;
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Scout sub-agent definitions used for pre-flight parallel context gathering.
 * Before the main agent loop, we spawn multiple scouts simultaneously to
 * build a comprehensive picture of the codebase so the main agent starts
 * with excellent context.
 */
interface ScoutTask {
    id: string;
    label: string;
    buildPrompt: (userMessage: string, workspaceContext: string) => string;
}

const SCOUT_TASKS: ScoutTask[] = [
    {
        id: 'structure',
        label: 'Exploring project structure',
        buildPrompt: (msg, ctx) =>
            `The user asked: "${msg.substring(0, 500)}"

Workspace context:
${ctx}

Your task: Explore the project structure to understand the codebase layout. Use list_directory (recursive) on the root, then identify the most important files and directories relevant to the user's request. Read package.json, any config files, and key entry points. Return a structured summary of the project architecture, tech stack, and which files/directories are most relevant to the user's question.`,
    },
    {
        id: 'search',
        label: 'Searching for relevant patterns',
        buildPrompt: (msg, _ctx) =>
            `The user asked: "${msg.substring(0, 500)}"

Your task: Search the codebase for patterns, keywords, and references related to the user's request. Use grep_search with multiple relevant queries (function names, class names, variable names, error messages, or concepts mentioned in the request). Also use search_files to find files with relevant names. Return a comprehensive list of all relevant matches with file paths, line numbers, and context.`,
    },
    {
        id: 'context',
        label: 'Reading key files for context',
        buildPrompt: (msg, ctx) =>
            `The user asked: "${msg.substring(0, 500)}"

Workspace context:
${ctx}

Your task: Based on the user's request, identify and read the most important files that would help answer or fulfill the request. Read up to 5 key files using read_file. Focus on files that are directly referenced, likely entry points, or contain the code areas the user is asking about. Return the key findings from each file — important functions, classes, patterns, dependencies, and anything relevant to the user's request.`,
    },
];

// ─── Service Implementation ─────────────────────────────────────────────────

export class SubAgentService {

    /**
     * Handle a chat message using the full agentic tool-use loop.
     * The agent can read files, search the codebase, run commands, and
     * spawn sub-agents before producing its final response.
     *
     * Maintains backward compatibility with OrchestratedResponse.
     */
    async orchestrateChat(
        apiKey: string,
        model: string,
        userMessage: string,
        context: string,
        temperature: number,
        topP: number,
        onStatus?: (status: string) => void,
        checkCancelled?: () => boolean,
    ): Promise<OrchestratedResponse> {
        onStatus?.('Building workspace context...');
        if (checkCancelled?.()) { throw new Error('Cancelled'); }

        const toolExecutor = new ToolExecutor();
        const contextManager = new ContextManager();
        const memoryService = new MemoryService();

        // Build workspace context and populate system prompt
        const workspaceContext = await contextManager.buildWorkspaceContext();
        const memoryContext = await memoryService.getMemoryContext();
        let enrichedContext = workspaceContext;
        if (memoryContext) {
            enrichedContext = `${memoryContext}\n\n${workspaceContext}`;
        }
        const systemPrompt = AGENT_SYSTEM_PROMPT.replace(
            '{WORKSPACE_CONTEXT}',
            enrichedContext
        );

        // Prepend additional context (editor state, attached files, etc.)
        let fullUserMessage = userMessage;
        if (context) {
            const compressed = contextManager.compressContext(context, 12000);
            fullUserMessage = `${compressed}\n\n---\n\n${userMessage}`;
        }

        onStatus?.('Starting agent...');

        const agentLoop = new AgentLoop({
            apiKey,
            model,
            systemPrompt,
            temperature,
            topP,
            maxTokens: DEFAULT_MAX_TOKENS,
            maxIterations: MAX_ITERATIONS,
            tools: AGENT_TOOLS,
            toolExecutor,
            onProgress: onStatus,
            checkCancelled,
        });

        const result = await agentLoop.run(fullUserMessage);

        return this.mapToOrchestratedResponse(result);
    }

    /**
     * Handle an edit request using the full agentic loop.
     * The agent reads the target file, plans surgical edits, applies them
     * via the edit_file tool, and verifies correctness.
     *
     * After the loop completes:
     *   - If the agent used edit_file: reverts the file to original content
     *     and returns the edits as JSON so the caller's approval workflow
     *     (parseEditResponse → user approve → applyEdits) works unchanged.
     *   - If the agent used write_file: same revert + return a whole-file edit.
     *   - If the agent only gave text instructions: returns the raw content
     *     so the caller can attempt JSON extraction as a fallback.
     *
     * Maintains backward compatibility with OrchestratedResponse.
     */
    async orchestrateEdit(
        apiKey: string,
        model: string,
        fileContent: string,
        fileName: string,
        instruction: string,
        selectedText: string | undefined,
        temperature: number,
        topP: number,
        onStatus?: (status: string) => void,
        checkCancelled?: () => boolean,
    ): Promise<OrchestratedResponse> {
        onStatus?.('Building workspace context...');
        if (checkCancelled?.()) { throw new Error('Cancelled'); }

        const toolExecutor = new ToolExecutor();
        const contextManager = new ContextManager();

        const workspaceContext = await contextManager.buildWorkspaceContext();
        const systemPrompt = AGENT_SYSTEM_PROMPT.replace(
            '{WORKSPACE_CONTEXT}',
            workspaceContext
        );

        // Build an edit-specific user message with file content and instruction
        const userMessage = this.buildEditUserMessage(
            fileContent,
            fileName,
            instruction,
            selectedText
        );

        onStatus?.('Analyzing code and planning edits...');

        const agentLoop = new AgentLoop({
            apiKey,
            model,
            systemPrompt,
            temperature: Math.min(temperature, 0.1), // Keep edits deterministic
            topP,
            maxTokens: DEFAULT_MAX_TOKENS,
            maxIterations: MAX_ITERATIONS,
            tools: AGENT_TOOLS,
            toolExecutor,
            onProgress: onStatus,
            checkCancelled,
        });

        const result = await agentLoop.run(userMessage);

        // ── Post-loop: extract edits and revert file for approval workflow ──

        const relativePath = this.getRelativePath(fileName);

        // Case 1: Agent used edit_file on the target file
        const extractedEdits = this.extractEditsFromToolCalls(result, relativePath);
        if (extractedEdits.length > 0) {
            // Revert the file so the caller can apply edits through its own
            // approval + applyEdits workflow.
            await this.revertFile(fileName, fileContent);

            const explanation = result.content
                ? this.truncate(result.content, 500)
                : `Applied ${extractedEdits.length} edit(s) to ${relativePath || fileName}`;

            const jsonResponse = JSON.stringify({
                edits: extractedEdits,
                explanation,
            });

            return {
                content: jsonResponse,
                agentResults: [{
                    role: 'logic' as AgentRole,
                    content: jsonResponse,
                    tokens: result.totalTokens,
                }],
                totalTokens: result.totalTokens,
                agentsUsed: this.inferAgentsUsed(result),
            };
        }

        // Case 2: Agent used write_file on the target file
        const writeCall = result.toolCalls.find(
            tc => tc.name === 'write_file' &&
                  this.pathsMatch(tc.args.path, relativePath)
        );

        if (writeCall) {
            await this.revertFile(fileName, fileContent);

            const newContent = writeCall.args.content || '';
            const explanation = result.content
                ? this.truncate(result.content, 500)
                : 'File rewritten by agent';

            const jsonResponse = JSON.stringify({
                edits: [{ oldText: fileContent, newText: newContent }],
                explanation,
            });

            return {
                content: jsonResponse,
                agentResults: [{
                    role: 'logic' as AgentRole,
                    content: jsonResponse,
                    tokens: result.totalTokens,
                }],
                totalTokens: result.totalTokens,
                agentsUsed: this.inferAgentsUsed(result),
            };
        }

        // Case 3: Agent didn't use file tools — return raw content.
        // The caller will attempt parseEditResponse as a fallback.
        return this.mapToOrchestratedResponse(result);
    }

    /**
     * Raw agentic loop with full tool and callback visibility.
     *
     * This is the "power user" method — the sidebar can call it directly
     * for the full agent experience: real-time tool call reporting,
     * sub-agent results, conversation history continuity, attached files.
     */
    async runAgentLoop(
        apiKey: string,
        model: string,
        userMessage: string,
        context: string,
        temperature: number,
        topP: number,
        attachedFiles?: string[],
        conversationHistory?: AgentMessage[],
        onStatus?: (status: string) => void,
        onToolCall?: (toolName: string, args: Record<string, any>) => void,
        onToolResult?: (toolName: string, result: ToolCallResult) => void,
        checkCancelled?: () => boolean,
    ): Promise<AgentLoopResult> {
        const toolExecutor = new ToolExecutor();
        const contextManager = new ContextManager();
        const memoryService = new MemoryService();

        // Build workspace context
        const workspaceContext = await contextManager.buildWorkspaceContext();

        // Load progressive memory for project understanding
        onStatus?.('Loading project memory...');
        const memoryContext = await memoryService.getMemoryContext();

        // Inject memory into system prompt
        let enrichedContext = workspaceContext;
        if (memoryContext) {
            enrichedContext = `${memoryContext}\n\n${workspaceContext}`;
        }

        const systemPrompt = AGENT_SYSTEM_PROMPT.replace(
            '{WORKSPACE_CONTEXT}',
            enrichedContext
        );

        // Build full user message with context and attached files
        let fullUserMessage = userMessage;
        if (context) {
            const compressed = contextManager.compressContext(context, 12000);
            fullUserMessage = `${compressed}\n\n---\n\n${userMessage}`;
        }

        if (attachedFiles && attachedFiles.length > 0) {
            const fileContents = await contextManager.readMultipleFiles(attachedFiles);
            let attachedContext = '\n\n--- Attached Files ---';
            for (const fc of fileContents) {
                const ext = fc.path.split('.').pop() || '';
                attachedContext += `\n\nFile: ${fc.path}\n\`\`\`${ext}\n${fc.content}\n\`\`\``;
            }
            fullUserMessage += attachedContext;
        }

        // ── Pre-flight: Spawn Scout Sub-Agents in Parallel ──────────────
        // Before the main agent loop, dispatch multiple scouts simultaneously
        // to explore the codebase from different angles. This gives the main
        // agent comprehensive context from step 1.

        let scoutContext = '';
        const isSimpleFollowUp = conversationHistory && conversationHistory.length > 2;
        const isTrivial = userMessage.split(/\s+/).length < 8 && !userMessage.includes('file') && !userMessage.includes('code');

        if (!isSimpleFollowUp && !isTrivial) {
            onStatus?.('Deploying scout agents for parallel context gathering...');

            const scoutResults = await this.runScoutAgents(
                apiKey,
                model,
                userMessage,
                workspaceContext,
                temperature,
                topP,
                onStatus,
                onToolCall,
                onToolResult,
                checkCancelled,
            );

            if (scoutResults.length > 0) {
                scoutContext = '\n\n## Pre-gathered Context from Scout Agents\n\n';
                for (const sr of scoutResults) {
                    scoutContext += `### Scout: ${sr.label}\n${sr.content}\n\n`;
                }
            }
        }

        // Prepend scout findings to the user message so the main agent
        // starts with excellent context
        if (scoutContext) {
            fullUserMessage = `${scoutContext}\n---\n\n${fullUserMessage}`;
        }

        onStatus?.('Starting main agent with full context...');

        const agentLoop = new AgentLoop({
            apiKey,
            model,
            systemPrompt,
            temperature,
            topP,
            maxTokens: DEFAULT_MAX_TOKENS,
            maxIterations: MAX_ITERATIONS,
            tools: AGENT_TOOLS,
            toolExecutor,
            onProgress: onStatus,
            onToolCall,
            onToolResult,
            checkCancelled,
        });

        const result = await agentLoop.run(fullUserMessage, conversationHistory);

        // ── Post-flight: Update Progressive Memory ──────────────────────
        // Store what we learned from this interaction so future runs start
        // with better context and use fewer tokens.
        try {
            onStatus?.('Updating project memory...');
            await memoryService.updateFromInteraction(
                userMessage,
                result.content,
                result.toolCalls,
                result.subAgentResults,
            );
        } catch {
            // Non-critical — don't fail the response if memory update fails
        }

        return result;
    }

    /**
     * Run parallel scout sub-agents to gather codebase context before the
     * main agent loop starts. Each scout investigates a different aspect
     * (structure, search, key files) simultaneously.
     */
    private async runScoutAgents(
        apiKey: string,
        model: string,
        userMessage: string,
        workspaceContext: string,
        temperature: number,
        topP: number,
        onStatus?: (status: string) => void,
        onToolCall?: (toolName: string, args: Record<string, any>) => void,
        onToolResult?: (toolName: string, result: ToolCallResult) => void,
        checkCancelled?: () => boolean,
    ): Promise<Array<{ id: string; label: string; content: string; tokens: number }>> {
        const scoutPromises = SCOUT_TASKS.map(async (scout) => {
            onStatus?.(`Scout: ${scout.label}...`);

            // Report the scout as a tool call for UI visibility
            onToolCall?.('run_subagent', { task: `[Scout] ${scout.label}` });

            const toolExecutor = new ToolExecutor();
            const subAgent = new AgentLoop({
                apiKey,
                model,
                systemPrompt: `You are a scout sub-agent for DeepCode. Your job is to quickly gather specific information from the codebase. Be fast, thorough, and return structured findings.

Rules:
- Use multiple tools in parallel when possible
- Focus on breadth of coverage — gather as much relevant info as you can
- Return findings in a clear, structured format with file paths and line numbers
- Don't make edits — you are read-only reconnaissance
- Be concise but complete — the main agent will use your findings to act`,
                temperature,
                topP,
                maxTokens: DEFAULT_MAX_TOKENS,
                maxIterations: 10, // Scouts are fast and focused
                tools: SUBAGENT_TOOLS,
                toolExecutor,
                isSubAgent: true,
                onProgress: (msg) => onStatus?.(`  [${scout.id}] ${msg}`),
                onToolCall,
                onToolResult,
                checkCancelled,
            });

            try {
                const prompt = scout.buildPrompt(userMessage, workspaceContext);
                const result = await subAgent.run(prompt);

                // Report completion
                onToolResult?.('run_subagent', {
                    success: true,
                    output: `Scout "${scout.label}" completed (${result.iterations} steps, ${result.toolCalls.length} tools used)`,
                });

                return {
                    id: scout.id,
                    label: scout.label,
                    content: result.content,
                    tokens: result.totalTokens,
                };
            } catch (error: any) {
                onToolResult?.('run_subagent', {
                    success: false,
                    output: `Scout "${scout.label}" failed: ${error.message}`,
                });

                return {
                    id: scout.id,
                    label: scout.label,
                    content: `(Scout failed: ${error.message})`,
                    tokens: 0,
                };
            }
        });

        // Execute ALL scouts in parallel — this is the key speedup
        return Promise.all(scoutPromises);
    }

    // ─── Private Helpers ─────────────────────────────────────────────────

    /**
     * Build the user prompt for edit requests.
     * Includes the file content, instruction, and selected text so the agent
     * has full context before it starts reading/editing with tools.
     */
    private buildEditUserMessage(
        fileContent: string,
        fileName: string,
        instruction: string,
        selectedText?: string,
    ): string {
        const relativePath = this.getRelativePath(fileName);
        const displayPath = relativePath || fileName;
        const ext = fileName.split('.').pop() || '';
        const lineCount = fileContent.split('\n').length;

        let message = `I need you to edit the file \`${displayPath}\` (${lineCount} lines, .${ext}).\n\n`;
        message += `## Instruction\n${instruction}\n\n`;

        if (selectedText) {
            const selStart = fileContent.indexOf(selectedText);
            if (selStart !== -1) {
                const linesBefore = fileContent.substring(0, selStart).split('\n').length;
                const selLines = selectedText.split('\n').length;
                message += `## Selected Code (lines ${linesBefore}-${linesBefore + selLines - 1})\n`;
            } else {
                message += `## Selected Code\n`;
            }
            message += `\`\`\`${ext}\n${selectedText}\n\`\`\`\n\n`;
        }

        message += `## Current File Content\n`;
        if (lineCount > 100) {
            const numbered = fileContent.split('\n')
                .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
                .join('\n');
            message += `\`\`\`${ext}\n${numbered}\n\`\`\`\n`;
        } else {
            message += `\`\`\`${ext}\n${fileContent}\n\`\`\`\n`;
        }

        message += `\nUse the read_file tool first to get the exact current content of \`${displayPath}\`, `;
        message += `then use edit_file with precise oldText/newText pairs to make the changes. `;
        message += `After editing, use get_diagnostics to verify the changes don't introduce errors.`;

        return message;
    }

    /**
     * Extract individual {oldText, newText} edits from edit_file tool calls
     * that targeted a specific file path.
     */
    private extractEditsFromToolCalls(
        result: AgentLoopResult,
        targetPath: string,
    ): Array<{ oldText: string; newText: string }> {
        const edits: Array<{ oldText: string; newText: string }> = [];

        for (const tc of result.toolCalls) {
            if (tc.name !== 'edit_file') { continue; }
            if (!this.pathsMatch(tc.args.path, targetPath)) { continue; }

            const tcEdits = tc.args.edits;
            if (Array.isArray(tcEdits)) {
                for (const edit of tcEdits) {
                    if (edit.oldText !== undefined && edit.newText !== undefined) {
                        edits.push({
                            oldText: String(edit.oldText),
                            newText: String(edit.newText),
                        });
                    }
                }
            }
        }

        return edits;
    }

    /**
     * Revert a file to its original content.
     * Uses the VS Code editor API when possible (preserves undo stack),
     * falls back to direct file system write.
     */
    private async revertFile(
        filePath: string,
        originalContent: string,
    ): Promise<void> {
        try {
            const uri = vscode.Uri.file(filePath);

            // Try to revert through the editor API for undo support
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, {
                preview: false,
                preserveFocus: true,
            });

            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length),
            );

            await editor.edit((editBuilder) => {
                editBuilder.replace(fullRange, originalContent);
            });
        } catch {
            // Fallback: write directly to disk
            try {
                const uri = vscode.Uri.file(filePath);
                await vscode.workspace.fs.writeFile(
                    uri,
                    Buffer.from(originalContent, 'utf-8')
                );
            } catch {
                // Best-effort — if we can't revert, the caller's applyEdits
                // will fail gracefully on oldText mismatch.
            }
        }
    }

    // ─── Web Search ──────────────────────────────────────────────────────

    /**
     * Search the web using DuckDuckGo's Instant Answer API.
     * Returns a formatted string of results suitable for use as AI context.
     */
    async webSearch(query: string): Promise<string> {
        return new Promise((resolve) => {
            let settled = false;
            const done = (result: string) => {
                if (!settled) { settled = true; resolve(result); }
            };

            const encodedQuery = encodeURIComponent(query);
            const reqOpts: https.RequestOptions = {
                hostname: 'api.duckduckgo.com',
                port: 443,
                path: `/?q=${encodedQuery}&format=json&no_html=1&no_redirect=1&skip_disambig=1`,
                method: 'GET',
                headers: {
                    'User-Agent': 'DeepCode-VSCode-Extension/1.0',
                    'Accept': 'application/json',
                },
            };

            const req = https.request(reqOpts, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const parts: string[] = [];

                        if (json.Answer) {
                            parts.push(`Answer: ${json.Answer}`);
                        }
                        if (json.AbstractText) {
                            parts.push(`Summary: ${json.AbstractText}`);
                            if (json.AbstractURL) {
                                parts.push(`Source: ${json.AbstractURL}`);
                            }
                        }
                        if (json.RelatedTopics && Array.isArray(json.RelatedTopics)) {
                            const topics = json.RelatedTopics
                                .filter((t: any) => t.Text)
                                .slice(0, 5)
                                .map((t: any) => `  • ${t.Text}`);
                            if (topics.length > 0) {
                                parts.push('Related:', ...topics);
                            }
                        }

                        done(parts.length > 0
                            ? parts.join('\n')
                            : `No instant results found for: "${query}"`);
                    } catch {
                        done(`Could not parse search results for: "${query}"`);
                    }
                });
            });

            req.setTimeout(5000, () => {
                done(`Search timed out for: "${query}"`);
                req.destroy();
            });

            req.on('error', () => done(`Search unavailable for: "${query}"`));
            req.end();
        });
    }

    // ─── LLM Call ────────────────────────────────────────────────────────

    /**
     * Convert an absolute file path to workspace-relative.
     */
    private getRelativePath(absolutePath: string): string {
        const workspaceRoot =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        if (workspaceRoot && absolutePath.startsWith(workspaceRoot)) {
            return absolutePath.slice(workspaceRoot.length + 1);
        }
        return absolutePath;
    }

    /**
     * Map an AgentLoopResult to the backward-compatible OrchestratedResponse.
     */
    private mapToOrchestratedResponse(
        result: AgentLoopResult,
    ): OrchestratedResponse {
        return {
            content: result.content,
            agentResults: [{
                role: 'logic' as AgentRole,
                content: result.content,
                tokens: result.totalTokens,
            }],
            totalTokens: result.totalTokens,
            agentsUsed: this.inferAgentsUsed(result),
        };
    }

    /**
     * Infer which "agent roles" were used based on the tool calls made
     * during the agentic loop. Maps tool names to legacy role categories
     * for backward compatibility with the UI.
     */
    private inferAgentsUsed(result: AgentLoopResult): AgentRole[] {
        const roles: Set<AgentRole> = new Set(['logic']);

        for (const tc of result.toolCalls) {
            switch (tc.name) {
                case 'edit_file':
                case 'write_file':
                    roles.add('patterns');
                    break;
                case 'grep_search':
                case 'search_files':
                case 'read_file':
                    roles.add('backend');
                    break;
                case 'run_command':
                case 'get_diagnostics':
                    roles.add('frontend');
                    break;
            }
        }

        if (result.subAgentResults.length > 0) {
            roles.add('frontend');
        }

        return Array.from(roles);
    }

    /**
     * Truncate a string, appending "..." if it exceeds maxLength.
     */
    private truncate(text: string, maxLength: number): string {
        if (text.length <= maxLength) { return text; }
        return text.substring(0, maxLength - 3) + '...';
    }
}
