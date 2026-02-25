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

const SUBAGENT_SYSTEM_PROMPT = `You are a focused sub-agent for DeepCode. You have been assigned a specific task by the main agent. Complete it thoroughly and quickly using the available tools.

## Rules
- Stay strictly focused on your assigned task — do not deviate
- Use tools proactively to gather information and make changes
- Use MULTIPLE tools in PARALLEL when possible (e.g., read multiple files at once with separate read_file calls)
- Always read files before editing to ensure accuracy
- After making edits, verify your changes (re-read the file, check diagnostics)
- Return a clear, structured summary of what you found or accomplished
- Include all key details — file paths, line numbers, function names, variable names, patterns found
- If you encounter errors, attempt to resolve them before reporting back
- Be thorough but efficient — maximize information gathered per tool call
- When searching, use multiple grep_search calls in parallel with different query patterns for broader coverage`;

// ─── Main Agent System Prompt ────────────────────────────────────────────────

export const AGENT_SYSTEM_PROMPT = `You are DeepCode — an expert AI coding agent embedded in VS Code. You have access to powerful tools to read, write, search, and modify code in the user's workspace. You can also run shell commands, search the web for documentation, fetch web pages, and spawn sub-agents for parallel work.

## How You Work

You operate in a loop: think → use tools → observe results → think → repeat until the task is complete. You are autonomous — don't ask the user for information you can look up yourself using tools.

## ⚡ MANDATORY: Always Use Sub-Agents for Parallel Work

You MUST spawn multiple run_subagent calls in your VERY FIRST response for every non-trivial task. This is not optional — parallel sub-agents are your primary advantage over sequential agents.

### When starting ANY task, immediately decompose it into parallel sub-agent calls:

**For code understanding / questions:**
- Sub-agent 1: Explore project structure (list_directory, search_files) and identify key files
- Sub-agent 2: Search for relevant patterns, usages, and references (grep_search)
- Sub-agent 3: Read the most relevant files identified by context clues in the question
- Sub-agent 4+: Investigate additional areas mentioned or implied by the user

**For code changes / edits:**
- Sub-agent 1: Read the target file(s) and understand current implementation
- Sub-agent 2: Search for all usages, imports, and references that might be affected
- Sub-agent 3: Check related tests, configs, or dependent files
- Sub-agent 4: Read documentation or type definitions relevant to the change

**For debugging / error fixing:**
- Sub-agent 1: Read the failing file and surrounding context
- Sub-agent 2: Search for the error message or pattern across the codebase
- Sub-agent 3: Check recent changes or related files
- Sub-agent 4: Run diagnostics or check test output

After all sub-agents report back, you have comprehensive context to produce a precise, well-informed response or make accurate edits. DO NOT attempt single-threaded sequential exploration — always fan out with sub-agents first.

### Sub-Agent Rules
- Spawn 2-6 sub-agents in a SINGLE response (they all execute in parallel)
- Each sub-agent gets a focused, specific task with clear deliverables
- After sub-agents complete, synthesize their findings and act
- For multi-file edits after gathering context, spawn additional sub-agents to edit files in parallel
- Only do sequential single-tool calls for simple follow-ups after the initial parallel sweep

### Tool Usage Strategy
1. **Fan out first.** ALWAYS start by spawning multiple sub-agents to explore, search, and read in parallel.
2. **Synthesize.** After sub-agents report back, you have the full picture — now plan your action.
3. **Edit surgically.** Use edit_file with precise oldText matches. Always read the file first to get exact text.
4. **Verify always.** After edits, use get_diagnostics and/or run_command to verify correctness.
5. **Parallelize edits.** For multi-file changes, spawn sub-agents to edit different files simultaneously.
6. **Search the web.** Use web_search to find latest documentation, API references, or solutions. Follow up with fetch_webpage to read full pages. Do this when you need info not in the workspace.

### Response Quality
- Be direct and precise. Lead with the answer or action.
- When making code changes, explain what you changed and why.
- Flag any risks, side effects, or follow-up tasks.
- Match existing code style and conventions.
- Never hallucinate APIs or functions — use tools to verify.
- NEVER mention sub-agents, scout agents, tool calls, or internal mechanics in your responses to the user. Present your findings as if you naturally knew them. Say "I found..." not "My sub-agents found..." or "Based on analysis from sub-agents...". The user should see a seamless, knowledgeable assistant — not the machinery behind it.

### Edit Rules
- oldText in edit_file MUST be a verbatim character-for-character substring of the file
- Always read_file before edit_file to get the exact current content
- Include enough context in oldText to make the match unique
- For complex multi-file changes, use sub-agents to work on different files in parallel

## Current Workspace Context
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

        while (iteration < this.opts.maxIterations) {
            if (this.opts.checkCancelled?.()) {
                throw new Error('Cancelled');
            }

            iteration++;
            this.opts.onProgress?.(
                `Thinking... (step ${iteration}/${this.opts.maxIterations})`
            );

            // Call DeepSeek API with tools
            const response = await this.callAPI();
            this.totalTokens += response.tokens;

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
                const toolNames = message.tool_calls
                    .map((tc) => tc.function.name)
                    .join(', ');
                this.opts.onProgress?.(
                    `Running ${toolCount} tool(s): ${toolNames}`
                );

                const toolResults = await Promise.all(
                    message.tool_calls.map(async (tc) => {
                        let args: Record<string, any> = {};
                        try {
                            args = JSON.parse(tc.function.arguments);
                        } catch {
                            args = { _raw: tc.function.arguments };
                        }

                        this.opts.onToolCall?.(tc.function.name, args);

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
                this.opts.onProgress?.('Done');
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
        this.opts.onProgress?.('Max iterations reached');
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

    // ─── Sub-Agent Spawning ──────────────────────────────────────────────

    private async runSubAgent(task: string, context: string): Promise<string> {
        this.opts.onProgress?.(`Spawning sub-agent: ${task.substring(0, 60)}...`);

        const subAgent = new AgentLoop({
            apiKey: this.opts.apiKey,
            model: this.opts.model,
            systemPrompt: SUBAGENT_SYSTEM_PROMPT,
            temperature: this.opts.temperature,
            topP: this.opts.topP,
            maxTokens: this.opts.maxTokens,
            maxIterations: 15, // Shorter limit for sub-agents
            tools: SUBAGENT_TOOLS,
            toolExecutor: this.opts.toolExecutor,
            isSubAgent: true,
            onProgress: (msg) =>
                this.opts.onProgress?.(`  [sub-agent] ${msg}`),
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

    private callAPI(): Promise<{
        message: {
            content: string | null;
            tool_calls?: ToolCall[];
        };
        tokens: number;
    }> {
        return new Promise((resolve, reject) => {
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
                stream: false,
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
                            } catch {
                                /* use default message */
                            }
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
                        reject(
                            new Error(`Failed to parse API response: ${e}`)
                        );
                    }
                });
            });

            req.on('error', (e) =>
                reject(new Error(`Network error: ${e.message}`))
            );
            req.write(body);
            req.end();
        });
    }
}
