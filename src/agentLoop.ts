/**
 * Agent Loop for DeepCode
 *
 * Implements a full agentic loop that iteratively calls DeepSeek with
 * tool definitions, executes tool calls (in parallel when multiple),
 * and loops until the model produces a final text response.
 *
 * Features:
 *   - Automatic tool execution with parallel dispatch
 *   - Sub-agent spawning for focused parallel tasks
 *   - Progress reporting to the UI
 *   - Cancellation support
 *   - Max iteration guard against infinite loops
 *   - Conversation history support for multi-turn interactions
 */

import * as https from 'https';
import {
    ToolDefinition,
    ToolExecutor,
    ToolCallResult,
    AGENT_TOOLS,
    SUBAGENT_TOOLS,
} from './tools';

// ─── Types ───────────────────────────────────────────────────────────────────

const DEEPSEEK_API_BASE = 'api.deepseek.com';

export interface AgentMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface AgentLoopOptions {
    apiKey: string;
    model: string;
    systemPrompt: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    maxIterations: number;
    tools: ToolDefinition[];
    toolExecutor: ToolExecutor;
    onProgress?: (message: string) => void;
    onToolCall?: (toolName: string, args: Record<string, any>) => void;
    onToolResult?: (toolName: string, result: ToolCallResult) => void;
    checkCancelled?: () => boolean;
    /** Stream tokens for the final response in real-time */
    onToken?: (token: string) => void;
    /** Depth guard — prevents sub-agents from spawning more sub-agents */
    isSubAgent?: boolean;
}

export interface AgentLoopResult {
    content: string;
    totalTokens: number;
    toolCalls: Array<{
        name: string;
        args: Record<string, any>;
        result: string;
        success: boolean;
    }>;
    iterations: number;
    subAgentResults: Array<{
        task: string;
        content: string;
        tokens: number;
    }>;
}

// ─── Sub-Agent System Prompt ─────────────────────────────────────────────────

const SUBAGENT_SYSTEM_PROMPT = `You are a focused sub-agent. Complete your assigned task quickly using tools.

Rules:
- Stay focused on your task
- Use multiple tools in parallel when possible
- Read files before editing
- Return a structured summary with file paths and key findings
- Be fast and efficient — minimize tool calls`;

// ─── Main Agent System Prompt ────────────────────────────────────────────────

export const AGENT_SYSTEM_PROMPT = `You are DeepCode — an expert AI coding agent in VS Code with tools to read, write, search, and modify code.

You think → use tools → observe → repeat until done. Be autonomous — use tools instead of asking the user.

## Speed Rules
- For SIMPLE questions (explanations, summaries, concepts): answer DIRECTLY from context without using tools. If you already have enough context, just respond immediately.
- For questions about attached/open files: the content is already in the prompt — read it and answer. Do NOT re-read files you already have.
- Only use tools when you genuinely need information not already provided.
- Use read_file, grep_search, list_directory directly — only use run_subagent for truly complex multi-file tasks.
- Prefer multiple tool calls in ONE response over spawning sub-agents.
- Keep tool usage minimal — 1-3 calls for most tasks.

## Tool Strategy
1. Check if you can answer from provided context FIRST.
2. If not, use the fewest tools needed to get the answer.
3. For understanding code: use get_file_skeleton FIRST to see structure, then read_file only for specific sections you need.
4. For finding code: use semantic_search for natural language queries, search_symbol for known names, grep_search for exact text.
5. For edits: read_file → edit_file → get_diagnostics. That's it.
6. For multi-file edits: use multi_edit_files to edit several files in one call.
7. For truly complex multi-file tasks: use run_subagent to parallelize.
8. Use web_search only when workspace info is insufficient.

## Response Quality
- Be direct. Lead with the answer.
- For code changes, explain what and why briefly.
- Match existing code style.
- NEVER mention sub-agents, scouts, tools, or internal mechanics. Present findings naturally.

## Edit Rules
- oldText must be verbatim from the file
- Always read_file before edit_file
- Include enough context for a unique match
- After edits, diagnostics are automatically reported — if errors appear, fix them immediately in the next step
- Be progressive: apply edits, check the auto-diagnostics, fix any issues, repeat until clean
- For changes spanning multiple files, prefer multi_edit_files over separate edit_file calls

## Error Recovery
- If a tool call fails, read the error message carefully and retry with corrected arguments.
- NEVER give up after a single tool failure — adjust and try again.
- If edit_file fails to find oldText, re-read the file to get the exact current content, then retry.
- If write_file fails, check that you provided both path and content arguments.

## Workspace
{WORKSPACE_CONTEXT}`;

// ─── Agent Loop Implementation ───────────────────────────────────────────────

export class AgentLoop {
    private messages: AgentMessage[] = [];
    private toolCallLog: Array<{
        name: string;
        args: Record<string, any>;
        result: string;
        success: boolean;
    }> = [];
    private subAgentResults: Array<{
        task: string;
        content: string;
        tokens: number;
    }> = [];
    private totalTokens = 0;

    constructor(private opts: AgentLoopOptions) {}

    /**
     * Run the agent loop with a user message.
     * Optionally accepts prior conversation history for multi-turn.
     */
    async run(
        userMessage: string,
        conversationHistory?: AgentMessage[]
    ): Promise<AgentLoopResult> {
        // Initialize messages
        this.messages = [
            { role: 'system', content: this.opts.systemPrompt },
        ];

        // Inject conversation history if provided
        if (conversationHistory && conversationHistory.length > 0) {
            this.messages.push(...conversationHistory);
        }

        this.messages.push({ role: 'user', content: userMessage });

        let iteration = 0;
        let consecutiveApiErrors = 0;

        while (iteration < this.opts.maxIterations) {
            if (this.opts.checkCancelled?.()) {
                throw new Error('Cancelled');
            }

            iteration++;
            if (iteration === 1) {
                this.opts.onProgress?.('Analyzing your request...');
            } else {
                this.opts.onProgress?.('Working on it...');
            }

            let response;
            try {
                // Call DeepSeek API — stream tokens after first iteration
                // (first call likely returns tool calls; subsequent calls more likely to answer)
                const shouldStream = iteration > 1 && !!this.opts.onToken;
                response = await this.callAPI(shouldStream);
                this.totalTokens += response.tokens;
                consecutiveApiErrors = 0;
            } catch (apiError: any) {
                consecutiveApiErrors++;
                const errMsg = apiError?.message || String(apiError);
                if (consecutiveApiErrors >= 3) {
                    // Too many API failures — bail out
                    return {
                        content: `I encountered repeated API errors and couldn't complete the task. Last error: ${errMsg}`,
                        totalTokens: this.totalTokens,
                        toolCalls: this.toolCallLog,
                        iterations: iteration,
                        subAgentResults: this.subAgentResults,
                    };
                }
                this.opts.onProgress?.(`API error (retrying): ${errMsg}`);
                // Wait briefly before retrying
                await new Promise(r => setTimeout(r, 1000 * consecutiveApiErrors));
                continue;
            }

            const message = response.message;

            // Check if the model wants to use tools
            if (message.tool_calls && message.tool_calls.length > 0) {
                // Add the assistant message with tool_calls to history
                this.messages.push({
                    role: 'assistant',
                    content: message.content,
                    tool_calls: message.tool_calls,
                });

                // Execute all tool calls in parallel
                const toolCount = message.tool_calls.length;
                this.opts.onProgress?.(this.describeToolActions(message.tool_calls));

                const toolResults = await Promise.all(
                    message.tool_calls.map(async (tc) => {
                        let args: Record<string, any> = {};
                        try {
                            args = JSON.parse(tc.function.arguments);
                        } catch {
                            args = { _raw: tc.function.arguments };
                        }

                        this.opts.onToolCall?.(tc.function.name, args);

                        try {
                            // Sub-agent handling
                            if (
                                tc.function.name === 'run_subagent' &&
                                !this.opts.isSubAgent
                            ) {
                                const subResult = await this.runSubAgent(
                                    args.task || '',
                                    args.context || ''
                                );
                                const result: ToolCallResult = {
                                    success: true,
                                    output: subResult,
                                };
                                this.opts.onToolResult?.(tc.function.name, result);
                                return { id: tc.id, name: tc.function.name, args, result };
                            }

                            // Standard tool execution
                            const result = await this.opts.toolExecutor.execute(
                                tc.function.name,
                                args
                            );
                            this.opts.onToolResult?.(tc.function.name, result);

                            this.toolCallLog.push({
                                name: tc.function.name,
                                args,
                                result: result.output,
                                success: result.success,
                            });

                            return { id: tc.id, name: tc.function.name, args, result };
                        } catch (toolError: any) {
                            // Catch ALL errors so Promise.all never rejects
                            const errorMsg = toolError?.message || String(toolError) || 'Unknown error';
                            const result: ToolCallResult = {
                                success: false,
                                output: `Tool "${tc.function.name}" failed with error: ${errorMsg}. Please review the arguments and try again.`,
                            };
                            this.opts.onToolResult?.(tc.function.name, result);
                            this.toolCallLog.push({
                                name: tc.function.name,
                                args,
                                result: result.output,
                                success: false,
                            });
                            return { id: tc.id, name: tc.function.name, args, result };
                        }
                    })
                );

                // Add tool results to message history
                for (const { id, result } of toolResults) {
                    this.messages.push({
                        role: 'tool',
                        content: result.output,
                        tool_call_id: id,
                    });
                }
            } else {
                // No tool calls — model returned a final text response
                return {
                    content: message.content || '',
                    totalTokens: this.totalTokens,
                    toolCalls: this.toolCallLog,
                    iterations: iteration,
                    subAgentResults: this.subAgentResults,
                };
            }
        }

        // Exceeded max iterations
        this.opts.onProgress?.('Wrapping up...');
        return {
            content:
                'I reached the maximum number of tool-use iterations for this task. ' +
                'Here is what I accomplished so far — you may want to continue the conversation for remaining work.',
            totalTokens: this.totalTokens,
            toolCalls: this.toolCallLog,
            iterations: iteration,
            subAgentResults: this.subAgentResults,
        };
    }

    // ─── Natural Language Descriptions ───────────────────────────────────

    /**
     * Generate a natural, user-friendly description of what tools are being used.
     */
    private describeToolActions(toolCalls: ToolCall[]): string {
        if (toolCalls.length === 1) {
            return this.describeOneTool(toolCalls[0]);
        }

        // Group by type for a clean summary
        const names = toolCalls.map(tc => tc.function.name);
        const uniqueNames = [...new Set(names)];

        if (uniqueNames.length === 1) {
            const name = uniqueNames[0];
            if (name === 'read_file') { return `Reading ${toolCalls.length} files...`; }
            if (name === 'grep_search') { return 'Searching across the codebase...'; }
            if (name === 'run_subagent') { return 'Investigating multiple areas in parallel...'; }
        }

        // Mixed tools — describe the dominant action
        const hasSearch = names.some(n => n === 'grep_search' || n === 'search_files');
        const hasRead = names.some(n => n === 'read_file');
        const hasEdit = names.some(n => n === 'edit_file' || n === 'write_file' || n === 'multi_edit_files');
        const hasSubAgent = names.some(n => n === 'run_subagent');

        if (hasSubAgent) { return 'Investigating multiple areas in parallel...'; }
        if (hasEdit) { return 'Applying changes...'; }
        if (hasSearch && hasRead) { return 'Searching and reading relevant files...'; }
        if (hasSearch) { return 'Searching the codebase...'; }
        if (hasRead) { return `Reading ${names.filter(n => n === 'read_file').length} files...`; }

        return 'Working on it...';
    }

    private describeOneTool(tc: ToolCall): string {
        let args: Record<string, any> = {};
        try { args = JSON.parse(tc.function.arguments); } catch { /* */ }

        switch (tc.function.name) {
            case 'read_file': {
                const file = args.path || '';
                return `Reading ${file}...`;
            }
            case 'write_file': {
                const file = args.path || '';
                return `Writing ${file}...`;
            }
            case 'edit_file': {
                const file = args.path || '';
                return `Editing ${file}...`;
            }
            case 'multi_edit_files': {
                const count = (args.files || []).length;
                return `Editing ${count} file(s)...`;
            }
            case 'list_directory': {
                const dir = args.path || 'project';
                return `Exploring ${dir === '.' || dir === '' ? 'project structure' : dir}...`;
            }
            case 'search_files':
                return `Searching for files matching "${args.pattern || ''}"...`;
            case 'grep_search':
                return `Searching for "${(args.query || '').substring(0, 50)}"...`;
            case 'run_command': {
                const cmd = (args.command || '').substring(0, 40);
                return `Running: ${cmd}...`;
            }
            case 'get_diagnostics':
                return 'Checking for errors...';
            case 'web_search':
                return `Searching the web for "${(args.query || '').substring(0, 50)}"...`;
            case 'fetch_webpage':
                return 'Reading documentation...';
            case 'run_subagent': {
                const task = (args.task || '').substring(0, 60);
                return `Working on: ${task}...`;
            }
            default:
                return 'Working on it...';
        }
    }

    // ─── Sub-Agent Spawning ──────────────────────────────────────────────

    private async runSubAgent(task: string, context: string): Promise<string> {
        const shortTask = task.length > 60 ? task.substring(0, 60) + '...' : task;
        this.opts.onProgress?.(`Working on: ${shortTask}`);

        const subAgent = new AgentLoop({
            apiKey: this.opts.apiKey,
            model: this.opts.model,
            systemPrompt: SUBAGENT_SYSTEM_PROMPT,
            temperature: this.opts.temperature,
            topP: this.opts.topP,
            maxTokens: this.opts.maxTokens,
            maxIterations: 5, // Sub-agents must be fast
            tools: SUBAGENT_TOOLS,
            toolExecutor: this.opts.toolExecutor,
            isSubAgent: true,
            onProgress: (msg) =>
                this.opts.onProgress?.(msg),
            onToolCall: this.opts.onToolCall,
            onToolResult: this.opts.onToolResult,
            checkCancelled: this.opts.checkCancelled,
        });

        const userMsg = context
            ? `Context:\n${context}\n\nTask: ${task}`
            : `Task: ${task}`;

        try {
            const result = await subAgent.run(userMsg);

            // Track sub-agent results
            this.subAgentResults.push({
                task,
                content: result.content,
                tokens: result.totalTokens,
            });

            // Accumulate sub-agent tokens
            this.totalTokens += result.totalTokens;

            return (
                `Sub-agent completed (${result.iterations} steps, ${result.toolCalls.length} tool calls):\n\n` +
                result.content
            );
        } catch (error: any) {
            return `Sub-agent failed: ${error.message}`;
        }
    }

    // ─── DeepSeek API Call ───────────────────────────────────────────────

    private callAPI(streamTokens: boolean = false): Promise<{
        message: {
            content: string | null;
            tool_calls?: ToolCall[];
        };
        tokens: number;
    }> {
        return new Promise((resolve, reject) => {
            const useStream = streamTokens && !!this.opts.onToken;

            // Build the request body
            const bodyObj: Record<string, any> = {
                model: this.opts.model,
                messages: this.messages.map((m) => {
                    const msg: Record<string, any> = {
                        role: m.role,
                        content: m.content,
                    };
                    if (m.tool_calls) {
                        msg.tool_calls = m.tool_calls;
                    }
                    if (m.tool_call_id) {
                        msg.tool_call_id = m.tool_call_id;
                    }
                    return msg;
                }),
                temperature: this.opts.temperature,
                max_tokens: this.opts.maxTokens,
                top_p: this.opts.topP,
                stream: useStream,
            };

            // Only include tools if available
            if (this.opts.tools.length > 0) {
                bodyObj.tools = this.opts.tools;
                bodyObj.tool_choice = 'auto';
            }

            const body = JSON.stringify(bodyObj);

            const reqOpts: https.RequestOptions = {
                hostname: DEEPSEEK_API_BASE,
                port: 443,
                path: '/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.opts.apiKey}`,
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(reqOpts, (res) => {
                if (useStream) {
                    // ── SSE streaming mode ──
                    let contentAccum = '';
                    let toolCallsAccum: ToolCall[] = [];
                    let totalTokens = 0;
                    let buffer = '';

                    res.on('data', (chunk: Buffer) => {
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || ''; // keep incomplete line

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed.startsWith('data: ')) { continue; }
                            const payload = trimmed.slice(6);
                            if (payload === '[DONE]') { continue; }

                            try {
                                const json = JSON.parse(payload);
                                const delta = json.choices?.[0]?.delta;
                                if (!delta) { continue; }

                                // Content tokens
                                if (delta.content) {
                                    contentAccum += delta.content;
                                    this.opts.onToken?.(delta.content);
                                }

                                // Tool call deltas
                                if (delta.tool_calls) {
                                    for (const tc of delta.tool_calls) {
                                        const idx = tc.index ?? 0;
                                        if (!toolCallsAccum[idx]) {
                                            toolCallsAccum[idx] = {
                                                id: tc.id || '',
                                                type: 'function',
                                                function: { name: '', arguments: '' },
                                            };
                                        }
                                        if (tc.id) { toolCallsAccum[idx].id = tc.id; }
                                        if (tc.function?.name) { toolCallsAccum[idx].function.name += tc.function.name; }
                                        if (tc.function?.arguments) { toolCallsAccum[idx].function.arguments += tc.function.arguments; }
                                    }
                                }

                                // Usage in final chunk
                                if (json.usage) {
                                    totalTokens = json.usage.total_tokens || 0;
                                }
                            } catch { /* skip malformed SSE */ }
                        }
                    });

                    res.on('end', () => {
                        const hasToolCalls = toolCallsAccum.length > 0 && toolCallsAccum.some(tc => tc.function.name);
                        resolve({
                            message: {
                                content: contentAccum || null,
                                tool_calls: hasToolCalls ? toolCallsAccum : undefined,
                            },
                            tokens: totalTokens,
                        });
                    });

                    res.on('error', (e) => reject(new Error(`Stream error: ${e.message}`)));
                } else {
                    // ── Non-streaming mode ──
                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    res.on('end', () => {
                        try {
                            if (res.statusCode !== 200) {
                                let errMsg = `API error: ${res.statusCode}`;
                                try {
                                    const err = JSON.parse(data);
                                    errMsg = err.error?.message || errMsg;
                                } catch { /* use default */ }
                                reject(new Error(errMsg));
                                return;
                            }

                            const json = JSON.parse(data);
                            const choice = json.choices?.[0];
                            if (!choice) {
                                reject(new Error('No choices in API response'));
                                return;
                            }

                            resolve({
                                message: {
                                    content: choice.message?.content || null,
                                    tool_calls: choice.message?.tool_calls,
                                },
                                tokens: json.usage?.total_tokens || 0,
                            });
                        } catch (e) {
                            reject(new Error(`Failed to parse API response: ${e}`));
                        }
                    });
                }
            });

            req.on('error', (e) =>
                reject(new Error(`Network error: ${e.message}`))
            );
            req.write(body);
            req.end();
        });
    }
}
