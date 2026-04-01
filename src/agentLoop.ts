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

import { ApiClient, createApiClient, StreamEvent, ChatCompletionOptions, ChatCompletionResult } from './apiClient';
import {
    ToolDefinition,
    ToolExecutor,
    ToolCallResult,
    AGENT_TOOLS,
    SUBAGENT_TOOLS,
    getToolOutputBudget,
} from './tools';
import { microcompact, shouldAutocompact, buildAutocompactPrompt, applyAutocompact } from './contextCompact';
import { getAgentDefinition } from './agents/agentDefinitions';
import { StreamingToolExecutor } from './streamingToolExecutor';

// ─── Types ───────────────────────────────────────────────────────────────────

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
    /** Optional fallback model to use when the primary model fails */
    fallbackModel?: string;
    systemPrompt: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    /**
     * Safety ceiling for iterations. NOT a target — just a last-resort guard.
     * The loop normally ends when the model stops calling tools.
     * Loop detection will kick in much earlier if the agent is stuck.
     */
    maxIterations: number;
    tools: ToolDefinition[];
    toolExecutor: ToolExecutor;
    onProgress?: (message: string) => void;
    onToolCall?: (toolName: string, args: Record<string, any>) => void;
    onToolResult?: (toolName: string, result: ToolCallResult) => void;
    /** Called with the LLM's inline reasoning text when it precedes a tool call */
    onLLMReason?: (reasoning: string) => void;
    /** Called when a file is successfully written/edited, carrying diff stats for the UI */
    onFileChanged?: (file: { relPath: string; originalContent: string; added: number; removed: number }) => void;
    checkCancelled?: () => boolean;
    /** Stream tokens for the final response in real-time */
    onToken?: (token: string) => void;
    /** Called when a model fallback occurs (primary model failed, using fallback) */
    onModelFallback?: (primaryModel: string, fallbackModel: string) => void;
    /** Depth guard — prevents sub-agents from spawning more sub-agents */
    isSubAgent?: boolean;
    /** Called when a background sub-agent completes */
    onBackgroundComplete?: (name: string, result: string) => void;
}

/** Fingerprint a tool call for loop detection */
function toolCallFingerprint(name: string, args: Record<string, any>): string {
    // Normalize args: sort keys, truncate long values
    const normalized: Record<string, any> = {};
    for (const key of Object.keys(args).sort()) {
        const val = args[key];
        normalized[key] = typeof val === 'string' && val.length > 200
            ? val.substring(0, 200)
            : val;
    }
    return `${name}:${JSON.stringify(normalized)}`;
}

/** Max times the same tool call (name+args) can repeat before we consider it a loop */
const MAX_IDENTICAL_TOOL_CALLS = 3;

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

// ─── Loop State Types ────────────────────────────────────────────────────────

export type LoopTransition =
    | { reason: 'next_turn' }
    | { reason: 'max_output_recovery'; attempt: number }
    | { reason: 'loop_break' }
    | { reason: 'api_retry'; attempt: number }
    | { reason: 'prompt_too_long_recovery'; attempt: number };

export interface LoopState {
    messages: AgentMessage[];
    toolCallLog: Array<{
        name: string;
        args: Record<string, any>;
        result: string;
        success: boolean;
    }>;
    subAgentResults: Array<{
        task: string;
        content: string;
        tokens: number;
    }>;
    totalTokens: number;
    turnCount: number;
    maxOutputRecoveryCount: number;
    transition: LoopTransition | undefined;
    toolCallCounts: Map<string, number>;
    compactedAtTurn: number;
    backgroundAgents: Map<string, Promise<{ output: string; subResult: { task: string; content: string; tokens: number } }>>;
    promptTooLongCount: number;
    toolFailureCounts: Map<string, number>;
    blockedTools: Set<string>;
}

function createInitialState(systemPrompt: string, userMessage: string, conversationHistory?: AgentMessage[]): LoopState {
    const messages: AgentMessage[] = [
        { role: 'system', content: systemPrompt },
    ];
    if (conversationHistory && conversationHistory.length > 0) {
        messages.push(...conversationHistory);
    }
    messages.push({ role: 'user', content: userMessage });

    return {
        messages,
        toolCallLog: [],
        subAgentResults: [],
        totalTokens: 0,
        turnCount: 0,
        maxOutputRecoveryCount: 0,
        transition: undefined,
        toolCallCounts: new Map(),
        compactedAtTurn: 0,
        backgroundAgents: new Map(),
        promptTooLongCount: 0,
        toolFailureCounts: new Map(),
        blockedTools: new Set(),
    };
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

## Speed Rules — READ THIS FIRST
- If file content is ALREADY in the prompt, NEVER call read_file on it again. Use the content you have.
- For SIMPLE questions: answer DIRECTLY without using any tools.
- For SIMPLE edits (1-3 changes): call edit_file IMMEDIATELY with the content already provided. Do NOT explore, search, or read first.
- Keep tool usage minimal — 1-3 calls for simple tasks, more only for genuinely complex multi-file work.
- Prefer multiple tool calls in ONE response over spawning sub-agents.

## Tool Strategy
1. Check if you can answer or act from provided context FIRST. If file content is in the prompt, you already have it.
2. If not, use the fewest tools needed.
3. For understanding code: use get_file_skeleton FIRST, then read_file for specific sections.
4. For finding code: use semantic_search for natural language, search_symbol for names, grep_search for exact text.
5. For edits when file content is provided: edit_file directly. Do NOT read_file first — you already have the content.
6. For edits when file content is NOT provided: read_file → edit_file. That's it.
7. Diagnostics run automatically after edit_file — do NOT call get_diagnostics manually unless fixing reported errors.
8. For multi-file edits: use multi_edit_files to edit several files in one call.
9. For truly complex multi-file tasks: use run_subagent to parallelize.
10. Use web_search only when workspace info is insufficient.

## Response Quality
- Be direct. Lead with the answer.
- For code changes, explain what and why briefly.
- Match existing code style.
- NEVER mention sub-agents, scouts, tools, or internal mechanics. Present findings naturally.

## Edit Rules
- oldText must be verbatim from the file (copy exact text including whitespace)
- If the file content is already in the prompt, use it directly — do NOT read_file again
- Only read_file before edit_file when you DON'T already have the file content
- Include enough surrounding context in oldText for a unique match
- Diagnostics run automatically after each edit_file — if errors appear, fix them in the next step
- For changes spanning multiple files, prefer multi_edit_files over separate edit_file calls
- For simple edits: just call edit_file and respond. Do not over-think it.

## Error Recovery
- If a tool call fails, read the error message carefully and retry with corrected arguments.
- NEVER give up after a single tool failure — adjust and try again.
- If edit_file fails to find oldText, re-read the file to get the exact current content, then retry.
- If write_file fails, check that you provided both path and content arguments.

## Workspace
{WORKSPACE_CONTEXT}`;

// ─── Agent Loop Implementation ───────────────────────────────────────────────

export class AgentLoop {
    private readonly apiClient: ApiClient;

    constructor(private opts: AgentLoopOptions) {
        this.apiClient = createApiClient({
            apiKey: opts.apiKey,
            model: opts.model,
            fallbackModel: opts.fallbackModel,
            timeout: 90_000,
        });
    }

    /**
     * Run the agent loop with a user message.
     * Optionally accepts prior conversation history for multi-turn.
     */
    async run(
        userMessage: string,
        conversationHistory?: AgentMessage[]
    ): Promise<AgentLoopResult> {
        let state = createInitialState(this.opts.systemPrompt, userMessage, conversationHistory);

        let consecutiveApiErrors = 0;
        let cancelRequested = false;

        while (state.turnCount < this.opts.maxIterations) {
            if (this.opts.checkCancelled?.()) {
                cancelRequested = true;
            }

            // On cancel, allow current iteration to finish gracefully
            if (cancelRequested && state.turnCount > 0) {
                // Generate a summary of completed work instead of throwing
                this.opts.onProgress?.('Cancellation requested, summarizing completed work...');
                state.messages = [...state.messages, {
                    role: 'user' as const,
                    content: '[SYSTEM: The user cancelled the request. Respond NOW with a brief summary of what you accomplished so far. Do NOT call any tools.]',
                }];
                const savedTools = this.opts.tools;
                this.opts.tools = [];
                try {
                    const summaryResp = await this.callAPI(state.messages, !!this.opts.onToken);
                    this.opts.tools = savedTools;
                    state = { ...state, totalTokens: state.totalTokens + summaryResp.tokens };
                    return {
                        content: summaryResp.message.content || 'Task was cancelled.',
                        totalTokens: state.totalTokens,
                        toolCalls: state.toolCallLog,
                        iterations: state.turnCount,
                        subAgentResults: state.subAgentResults,
                    };
                } catch {
                    this.opts.tools = savedTools;
                }
                return {
                    content: 'Task was cancelled. ' +
                        `Completed ${state.toolCallLog.length} tool call(s) across ${state.turnCount} steps before cancellation.`,
                    totalTokens: state.totalTokens,
                    toolCalls: state.toolCallLog,
                    iterations: state.turnCount,
                    subAgentResults: state.subAgentResults,
                };
            }

            // Check for completed background agents
            for (const [name, promise] of state.backgroundAgents) {
                const resolved = await Promise.race([
                    promise.then(r => ({ done: true as const, result: r })),
                    Promise.resolve({ done: false as const }),
                ]);
                if (resolved.done) {
                    state.backgroundAgents.delete(name);
                    state = {
                        ...state,
                        messages: [...state.messages, {
                            role: 'user' as const,
                            content: `[Background agent '${name}' completed: ${resolved.result.output}]`,
                        }],
                        subAgentResults: [...state.subAgentResults, resolved.result.subResult],
                        totalTokens: state.totalTokens + resolved.result.subResult.tokens,
                    };
                }
            }

            state = { ...state, turnCount: state.turnCount + 1 };

            if (state.turnCount === 1) {
                this.opts.onProgress?.('Analyzing your request...');
            } else {
                const toolsSoFar = state.toolCallLog.length;
                const lastTool = toolsSoFar > 0 ? state.toolCallLog[toolsSoFar - 1] : null;
                if (lastTool && !lastTool.success) {
                    this.opts.onProgress?.(`Recovering from ${lastTool.name} issue, retrying...`);
                }
            }

            let response;
            let streamingExecutor: StreamingToolExecutor | undefined;
            try {
                const shouldStream = state.turnCount > 1 && !!this.opts.onToken;

                // Create streaming tool executor to start tool execution during API stream
                if (shouldStream) {
                    streamingExecutor = new StreamingToolExecutor(this.opts.toolExecutor);
                }

                // ── Context compression pipeline ──
                let compressedMessages = microcompact(state.messages);

                if (shouldAutocompact(compressedMessages)) {
                    this.opts.onProgress?.('Compressing conversation context...');
                    try {
                        const summaryPrompt = buildAutocompactPrompt(compressedMessages);
                        const summaryResult = await this.apiClient.chatCompletion({
                            messages: [
                                { role: 'system', content: 'You are a conversation summarizer. Be concise but preserve all technical details.' },
                                { role: 'user', content: summaryPrompt },
                            ],
                            temperature: 0,
                            maxTokens: 2000,
                        });
                        if (summaryResult.content) {
                            compressedMessages = applyAutocompact(
                                compressedMessages,
                                summaryResult.content,
                                state.turnCount,
                            );
                            state = { ...state, compactedAtTurn: state.turnCount };
                        }
                    } catch {
                        // Autocompact failed — continue with microcompacted messages
                    }
                }

                response = await this.callAPI(compressedMessages, shouldStream, streamingExecutor);
                state = { ...state, totalTokens: state.totalTokens + response.tokens };
                consecutiveApiErrors = 0;
            } catch (apiError: any) {
                streamingExecutor?.discard();
                const errMsg = apiError?.message || String(apiError);
                const statusCode = apiError?.status || apiError?.statusCode || apiError?.response?.status;

                // Detect prompt-too-long errors
                const isPromptTooLong = statusCode === 413 ||
                    /too long|context_length_exceeded|maximum context length/i.test(errMsg);

                if (isPromptTooLong && state.promptTooLongCount < 2) {
                    const attempt = state.promptTooLongCount + 1;
                    this.opts.onProgress?.(`Prompt too long, compacting context (attempt ${attempt}/2)...`);

                    if (state.promptTooLongCount < 1) {
                        // First occurrence: autocompact
                        try {
                            const summaryPrompt = buildAutocompactPrompt(state.messages);
                            const summaryResult = await this.apiClient.chatCompletion({
                                messages: [
                                    { role: 'system', content: 'You are a conversation summarizer. Be concise but preserve all technical details.' },
                                    { role: 'user', content: summaryPrompt },
                                ],
                                temperature: 0,
                                maxTokens: 2000,
                            });
                            if (summaryResult.content) {
                                const compacted = applyAutocompact(
                                    state.messages,
                                    summaryResult.content,
                                    state.turnCount,
                                );
                                state = {
                                    ...state,
                                    messages: compacted,
                                    compactedAtTurn: state.turnCount,
                                    promptTooLongCount: attempt,
                                    transition: { reason: 'prompt_too_long_recovery', attempt },
                                };
                            } else {
                                state = {
                                    ...state,
                                    promptTooLongCount: attempt,
                                    transition: { reason: 'prompt_too_long_recovery', attempt },
                                };
                            }
                        } catch {
                            // If autocompact fails, still increment and try aggressive next time
                            state = {
                                ...state,
                                promptTooLongCount: attempt,
                                transition: { reason: 'prompt_too_long_recovery', attempt },
                            };
                        }
                    } else {
                        // Second occurrence: aggressive compact — keep system prompt + last 5 messages
                        const systemMsg = state.messages[0];
                        const recentMessages = state.messages.slice(-5);
                        state = {
                            ...state,
                            messages: [systemMsg, ...recentMessages],
                            promptTooLongCount: attempt,
                            transition: { reason: 'prompt_too_long_recovery', attempt },
                        };
                    }
                    continue;
                }

                consecutiveApiErrors++;
                if (consecutiveApiErrors >= 3) {
                    return {
                        content: `I encountered repeated API errors and couldn't complete the task. Last error: ${errMsg}`,
                        totalTokens: state.totalTokens,
                        toolCalls: state.toolCallLog,
                        iterations: state.turnCount,
                        subAgentResults: state.subAgentResults,
                    };
                }
                this.opts.onProgress?.(`API error (retrying): ${errMsg}`);
                await new Promise(r => setTimeout(r, 1000 * consecutiveApiErrors));
                state = { ...state, transition: { reason: 'api_retry', attempt: consecutiveApiErrors } };
                continue;
            }

            const message = response.message;

            // Check for truncation (max_output_tokens hit)
            const finishReason = response.finishReason;
            if (finishReason === 'length' && state.maxOutputRecoveryCount < 3) {
                state = {
                    ...state,
                    maxOutputRecoveryCount: state.maxOutputRecoveryCount + 1,
                    transition: { reason: 'max_output_recovery', attempt: state.maxOutputRecoveryCount + 1 },
                };
                state.messages = [...state.messages, {
                    role: 'assistant' as const,
                    content: message.content,
                    tool_calls: message.tool_calls,
                }];
                state.messages = [...state.messages, {
                    role: 'user' as const,
                    content: '[SYSTEM: Output limit hit. Resume directly — no recap. Break remaining work into smaller pieces.]',
                }];
                this.opts.onProgress?.(`Output truncated, recovering (attempt ${state.maxOutputRecoveryCount}/3)...`);
                continue;
            }

            // Check if the model wants to use tools
            if (message.tool_calls && message.tool_calls.length > 0) {
                // Surface the LLM's inline reasoning (if any) before executing tools
                if (message.content && message.content.trim()) {
                    const reasoning = message.content.trim().replace(/\s+/g, ' ');
                    this.opts.onLLMReason?.(reasoning.length > 200 ? reasoning.substring(0, 200) + '…' : reasoning);
                }

                // Add the assistant message with tool_calls to history
                state.messages = [...state.messages, {
                    role: 'assistant',
                    content: message.content,
                    tool_calls: message.tool_calls,
                }];

                // ── Loop detection: check if the agent is repeating itself ──
                let loopDetected = false;
                for (const tc of message.tool_calls) {
                    let args: Record<string, any> = {};
                    try { args = JSON.parse(tc.function.arguments); } catch { /* */ }
                    const fp = toolCallFingerprint(tc.function.name, args);
                    const count = (state.toolCallCounts.get(fp) || 0) + 1;
                    state.toolCallCounts.set(fp, count);
                    if (count >= MAX_IDENTICAL_TOOL_CALLS) {
                        loopDetected = true;
                    }
                }

                if (loopDetected) {
                    this.opts.onProgress?.('Detected repeating actions, wrapping up...');
                    state.messages = [...state.messages, {
                        role: 'user',
                        content: '[SYSTEM: You are repeating the same tool calls. STOP using tools and respond with what you have accomplished so far.]',
                    }];
                    const savedTools = this.opts.tools;
                    this.opts.tools = [];
                    try {
                        const forceResp = await this.callAPI(state.messages, !!this.opts.onToken);
                        state = { ...state, totalTokens: state.totalTokens + forceResp.tokens, transition: { reason: 'loop_break' } };
                        this.opts.tools = savedTools;
                        if (forceResp.message.content) {
                            return {
                                content: forceResp.message.content,
                                totalTokens: state.totalTokens,
                                toolCalls: state.toolCallLog,
                                iterations: state.turnCount,
                                subAgentResults: state.subAgentResults,
                            };
                        }
                    } catch {
                        this.opts.tools = savedTools;
                    }
                    break;
                }

                // Wait for streaming executor results (tools started during API stream)
                let executorResultMap: Map<string, ToolCallResult> | undefined;
                if (streamingExecutor) {
                    if (this.opts.checkCancelled?.()) {
                        streamingExecutor.discard();
                        cancelRequested = true;
                    } else {
                        await streamingExecutor.waitForAll();
                        executorResultMap = streamingExecutor.getResultMap();
                    }
                }

                // Execute all tool calls (using pre-computed streaming results when available)
                const toolResults = await Promise.all(
                    message.tool_calls.map(async (tc) => {
                        let args: Record<string, any> = {};
                        try {
                            args = JSON.parse(tc.function.arguments);
                        } catch {
                            args = { _raw: tc.function.arguments };
                        }

                        this.opts.onToolCall?.(tc.function.name, args);

                        // Check if tool is blocked due to repeated failures
                        if (state.blockedTools.has(tc.function.name)) {
                            const result: ToolCallResult = {
                                success: false,
                                output: `Tool '${tc.function.name}' has been blocked after repeated failures. Use an alternative approach.`,
                            };
                            this.opts.onToolResult?.(tc.function.name, result);
                            state = {
                                ...state,
                                toolCallLog: [...state.toolCallLog, {
                                    name: tc.function.name,
                                    args,
                                    result: result.output,
                                    success: false,
                                }],
                            };
                            return { id: tc.id, name: tc.function.name, args, result };
                        }

                        try {
                            // Sub-agent handling
                            if (
                                tc.function.name === 'run_subagent' &&
                                !this.opts.isSubAgent
                            ) {
                                const subArgs = args as {
                                    task: string;
                                    context?: string;
                                    mode?: 'fresh' | 'fork';
                                    background?: boolean;
                                    name?: string;
                                    tools?: string[];
                                    subagent_type?: string;
                                };
                                if (subArgs.background) {
                                    const agentName = subArgs.name || `agent-${Date.now()}`;
                                    const promise = this.runSubAgent(subArgs, state);
                                    state.backgroundAgents.set(agentName, promise);
                                    // Fire-and-forget: notify when complete
                                    promise.then((res) => {
                                        this.opts.onBackgroundComplete?.(agentName, res.output);
                                    }).catch(() => {});
                                    const result: ToolCallResult = {
                                        success: true,
                                        output: `Background agent '${agentName}' started. You will be notified when it completes.`,
                                    };
                                    this.opts.onToolResult?.(tc.function.name, result);
                                    // Reset failure count on success
                                    const updatedCounts = new Map(state.toolFailureCounts);
                                    updatedCounts.delete(tc.function.name);
                                    state = { ...state, toolFailureCounts: updatedCounts };
                                    return { id: tc.id, name: tc.function.name, args, result };
                                }

                                const { output, subResult } = await this.runSubAgent(subArgs, state);
                                const result: ToolCallResult = {
                                    success: true,
                                    output,
                                };
                                this.opts.onToolResult?.(tc.function.name, result);

                                // Merge sub-agent results into state; reset failure count on success
                                const updatedCounts = new Map(state.toolFailureCounts);
                                updatedCounts.delete(tc.function.name);
                                state = {
                                    ...state,
                                    subAgentResults: [...state.subAgentResults, subResult],
                                    totalTokens: state.totalTokens + subResult.tokens,
                                    toolFailureCounts: updatedCounts,
                                };

                                return { id: tc.id, name: tc.function.name, args, result };
                            }

                            // Standard tool execution — use streaming result or execute inline
                            const result = executorResultMap?.get(tc.id)
                                ?? await this.opts.toolExecutor.execute(
                                    tc.function.name,
                                    args
                                );
                            this.opts.onToolResult?.(tc.function.name, result);

                            if (result.changedFiles) {
                                for (const cf of result.changedFiles) {
                                    this.opts.onFileChanged?.(cf);
                                }
                            }

                            // Track success/failure for consecutive failure detection
                            if (result.success) {
                                const updatedCounts = new Map(state.toolFailureCounts);
                                updatedCounts.delete(tc.function.name);
                                state = {
                                    ...state,
                                    toolCallLog: [...state.toolCallLog, {
                                        name: tc.function.name,
                                        args,
                                        result: result.output,
                                        success: result.success,
                                    }],
                                    toolFailureCounts: updatedCounts,
                                };
                            } else {
                                const updatedCounts = new Map(state.toolFailureCounts);
                                const failCount = (updatedCounts.get(tc.function.name) || 0) + 1;
                                updatedCounts.set(tc.function.name, failCount);
                                if (failCount >= 3) {
                                    const updatedBlocked = new Set(state.blockedTools);
                                    updatedBlocked.add(tc.function.name);
                                    this.opts.onProgress?.(`Tool '${tc.function.name}' blocked after ${failCount} consecutive failures.`);
                                    state = {
                                        ...state,
                                        toolCallLog: [...state.toolCallLog, {
                                            name: tc.function.name,
                                            args,
                                            result: result.output,
                                            success: false,
                                        }],
                                        toolFailureCounts: updatedCounts,
                                        blockedTools: updatedBlocked,
                                    };
                                } else {
                                    state = {
                                        ...state,
                                        toolCallLog: [...state.toolCallLog, {
                                            name: tc.function.name,
                                            args,
                                            result: result.output,
                                            success: false,
                                        }],
                                        toolFailureCounts: updatedCounts,
                                    };
                                }
                            }

                            return { id: tc.id, name: tc.function.name, args, result };
                        } catch (toolError: any) {
                            const errorMsg = toolError?.message || String(toolError) || 'Unknown error';
                            const result: ToolCallResult = {
                                success: false,
                                output: `Tool '${tc.function.name}' failed: ${errorMsg}. Adjust arguments and retry, or use an alternative approach.`,
                            };
                            this.opts.onToolResult?.(tc.function.name, result);

                            // Track consecutive failures for blocklisting
                            const updatedCounts = new Map(state.toolFailureCounts);
                            const failCount = (updatedCounts.get(tc.function.name) || 0) + 1;
                            updatedCounts.set(tc.function.name, failCount);
                            if (failCount >= 3) {
                                const updatedBlocked = new Set(state.blockedTools);
                                updatedBlocked.add(tc.function.name);
                                this.opts.onProgress?.(`Tool '${tc.function.name}' blocked after ${failCount} consecutive failures.`);
                                state = {
                                    ...state,
                                    toolCallLog: [...state.toolCallLog, {
                                        name: tc.function.name,
                                        args,
                                        result: result.output,
                                        success: false,
                                    }],
                                    toolFailureCounts: updatedCounts,
                                    blockedTools: updatedBlocked,
                                };
                            } else {
                                state = {
                                    ...state,
                                    toolCallLog: [...state.toolCallLog, {
                                        name: tc.function.name,
                                        args,
                                        result: result.output,
                                        success: false,
                                    }],
                                    toolFailureCounts: updatedCounts,
                                };
                            }
                            return { id: tc.id, name: tc.function.name, args, result };
                        }
                    })
                );

                // Add tool results to message history (truncated per-tool budget)
                for (const { id, name, result } of toolResults) {
                    let output = result.output;
                    const budget = getToolOutputBudget(name, this.opts.tools);
                    if (output.length > budget) {
                        output = output.substring(0, budget) +
                            `\n\n[... truncated to ${budget} chars. ${output.length - budget} chars omitted]`;
                    }
                    state.messages = [...state.messages, {
                        role: 'tool' as const,
                        content: output,
                        tool_call_id: id,
                    }];
                }

                // Check for cancellation after tool execution completes
                if (this.opts.checkCancelled?.()) {
                    cancelRequested = true;
                }

                state = { ...state, transition: { reason: 'next_turn' } };
            } else {
                // No tool calls — model returned a final text response
                return {
                    content: message.content || '',
                    totalTokens: state.totalTokens,
                    toolCalls: state.toolCallLog,
                    iterations: state.turnCount,
                    subAgentResults: state.subAgentResults,
                };
            }
        }

        // Exceeded max iterations — force a final text response without tools
        this.opts.onProgress?.('Wrapping up...');

        try {
            state.messages = [...state.messages, {
                role: 'user' as const,
                content: '[SYSTEM: Maximum iterations reached. Respond NOW with a summary of what you accomplished. Do NOT call any tools.]',
            }];
            const savedTools = this.opts.tools;
            this.opts.tools = [];
            const finalResponse = await this.callAPI(state.messages, !!this.opts.onToken);
            this.opts.tools = savedTools;
            state = { ...state, totalTokens: state.totalTokens + finalResponse.tokens };

            if (finalResponse.message.content) {
                return {
                    content: finalResponse.message.content,
                    totalTokens: state.totalTokens,
                    toolCalls: state.toolCallLog,
                    iterations: state.turnCount,
                    subAgentResults: state.subAgentResults,
                };
            }
        } catch {
            // If the final summary call also fails, fall through to generic message
        }

        return {
            content:
                'I used all available iterations for this task. ' +
                `Here is what I did: ${state.toolCallLog.length} tool call(s) across ${state.turnCount} steps. ` +
                'You may want to continue the conversation for remaining work.',
            totalTokens: state.totalTokens,
            toolCalls: state.toolCallLog,
            iterations: state.turnCount,
            subAgentResults: state.subAgentResults,
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

    private async runSubAgent(
        args: {
            task: string;
            context?: string;
            mode?: 'fresh' | 'fork';
            background?: boolean;
            name?: string;
            tools?: string[];
            subagent_type?: string;
        },
        state: LoopState,
    ): Promise<{
        output: string;
        subResult: { task: string; content: string; tokens: number };
    }> {
        const task = args.task;
        const context = args.context || '';
        const shortTask = task.length > 60 ? task.substring(0, 60) + '...' : task;
        this.opts.onProgress?.(`Working on: ${shortTask}`);

        // Determine system prompt, tools, and maxIterations from agent definition or defaults
        let systemPrompt = SUBAGENT_SYSTEM_PROMPT;
        let subTools: ToolDefinition[] = SUBAGENT_TOOLS;
        let maxIterations = 25;

        if (args.subagent_type) {
            const def = getAgentDefinition(args.subagent_type);
            if (def) {
                systemPrompt = def.systemPrompt;
                if (def.maxTurns) {
                    maxIterations = def.maxTurns;
                }
                if (def.tools) {
                    subTools = AGENT_TOOLS.filter(t => def.tools!.includes(t.function.name));
                }
            }
        } else if (args.tools && args.tools.length > 0) {
            subTools = AGENT_TOOLS.filter(t => args.tools!.includes(t.function.name));
        } else if (args.mode === 'fork') {
            // Fork mode: use parent tools minus run_subagent
            subTools = SUBAGENT_TOOLS;
        }

        // Build conversation history for fork mode
        let conversationHistory: AgentMessage[] | undefined;
        if (args.mode === 'fork') {
            if (!this.opts.isSubAgent) {
                // Pass parent conversation history (skip system prompt at index 0)
                conversationHistory = state.messages.slice(1);
            } else {
                // Already a sub-agent — ignore fork, use fresh mode
                this.opts.onProgress?.('Warning: fork mode ignored (already a sub-agent). Using fresh mode.');
            }
        }

        const subAgent = new AgentLoop({
            apiKey: this.opts.apiKey,
            model: this.opts.model,
            systemPrompt,
            temperature: this.opts.temperature,
            topP: this.opts.topP,
            maxTokens: this.opts.maxTokens,
            maxIterations,
            tools: subTools,
            toolExecutor: this.opts.toolExecutor,
            isSubAgent: true,
            onProgress: (msg) =>
                this.opts.onProgress?.(msg),
            onToolCall: this.opts.onToolCall,
            onToolResult: this.opts.onToolResult,
            onLLMReason: this.opts.onLLMReason,
            onFileChanged: this.opts.onFileChanged,
            checkCancelled: this.opts.checkCancelled,
        });

        const userMsg = context
            ? `Context:\n${context}\n\nTask: ${task}`
            : `Task: ${task}`;

        try {
            const result = await subAgent.run(userMsg, conversationHistory);

            const output =
                `Sub-agent completed (${result.iterations} steps, ${result.toolCalls.length} tool calls):\n\n` +
                result.content;

            return {
                output,
                subResult: {
                    task,
                    content: result.content,
                    tokens: result.totalTokens,
                },
            };
        } catch (error: any) {
            return {
                output: `Sub-agent failed: ${error.message}`,
                subResult: {
                    task,
                    content: `Failed: ${error.message}`,
                    tokens: 0,
                },
            };
        }
    }

    // ─── DeepSeek API Call ───────────────────────────────────────────────

    private async callAPI(
        messages: AgentMessage[],
        streamTokens: boolean = false,
        streamingExecutor?: StreamingToolExecutor,
    ): Promise<{
        message: {
            content: string | null;
            tool_calls?: ToolCall[];
        };
        tokens: number;
        finishReason: string;
    }> {
        const useStream = streamTokens && !!this.opts.onToken;

        // Build ChatCompletionOptions from provided messages
        const completionOpts: ChatCompletionOptions = {
            messages: messages.map((m) => {
                const msg: Record<string, any> = {
                    role: m.role,
                    content: m.content,
                };
                if (m.tool_calls) { msg.tool_calls = m.tool_calls; }
                if (m.tool_call_id) { msg.tool_call_id = m.tool_call_id; }
                return msg as ChatCompletionOptions['messages'][number];
            }),
            temperature: this.opts.temperature,
            maxTokens: this.opts.maxTokens,
            topP: this.opts.topP,
        };

        if (this.opts.tools.length > 0) {
            completionOpts.tools = this.opts.tools;
            completionOpts.toolChoice = 'auto';
        }

        if (useStream) {
            // ── Streaming mode ──
            let contentAccum = '';
            let toolCallsAccum: ToolCall[] = [];
            let totalTokens = 0;
            let streamFinishReason = 'stop';

            // Track which tool indices have been submitted to the streaming executor
            const submittedIndices = new Set<number>();
            let highestToolIndex = -1;

            const submitToolBlock = (idx: number) => {
                if (!streamingExecutor || submittedIndices.has(idx)) { return; }
                const tc = toolCallsAccum[idx];
                if (!tc || !tc.function.name) { return; }
                // Skip sub-agent tools — they need special handling in run()
                if (tc.function.name === 'run_subagent') { return; }

                let args: Record<string, any>;
                try {
                    args = JSON.parse(tc.function.arguments || '{}');
                } catch {
                    args = { _raw: tc.function.arguments };
                }

                submittedIndices.add(idx);
                streamingExecutor.addTool({ id: tc.id, name: tc.function.name, arguments: args });
            };

            for await (const event of this.apiClient.streamChatCompletion(completionOpts)) {
                switch (event.type) {
                    case 'content_delta':
                        if (event.content) {
                            contentAccum += event.content;
                            this.opts.onToken?.(event.content);
                        }
                        break;

                    case 'tool_call_delta':
                        if (event.toolCall) {
                            const idx = event.toolCall.index;
                            if (!toolCallsAccum[idx]) {
                                toolCallsAccum[idx] = {
                                    id: event.toolCall.id || '',
                                    type: 'function',
                                    function: { name: '', arguments: '' },
                                };
                            }
                            if (event.toolCall.id) { toolCallsAccum[idx].id = event.toolCall.id; }
                            if (event.toolCall.name) { toolCallsAccum[idx].function.name += event.toolCall.name; }
                            if (event.toolCall.arguments) { toolCallsAccum[idx].function.arguments += event.toolCall.arguments; }

                            // When a new higher index arrives, previous blocks are complete
                            if (idx > highestToolIndex) {
                                for (let i = Math.max(0, highestToolIndex); i < idx; i++) {
                                    submitToolBlock(i);
                                }
                                highestToolIndex = idx;
                            }
                        }
                        break;

                    case 'message_stop':
                        if (event.usage) {
                            totalTokens = event.usage.totalTokens;
                        }
                        if (event.finishReason) {
                            streamFinishReason = event.finishReason;
                        }
                        // Submit any remaining tool blocks
                        for (let i = 0; i < toolCallsAccum.length; i++) {
                            submitToolBlock(i);
                        }
                        break;

                    case 'error':
                        if (event.error?.includes('Falling back') && this.opts.fallbackModel) {
                            this.opts.onModelFallback?.(this.opts.model, this.opts.fallbackModel);
                        }
                        break;
                }
            }

            const hasToolCalls = toolCallsAccum.length > 0 && toolCallsAccum.some(tc => tc.function.name);
            return {
                message: {
                    content: contentAccum || null,
                    tool_calls: hasToolCalls ? toolCallsAccum : undefined,
                },
                tokens: totalTokens,
                finishReason: streamFinishReason,
            };
        } else {
            // ── Non-streaming mode ──
            const result = await this.apiClient.chatCompletion(completionOpts);
            return {
                message: {
                    content: result.content,
                    tool_calls: result.toolCalls as ToolCall[] | undefined,
                },
                tokens: result.usage.totalTokens,
                finishReason: result.finishReason,
            };
        }
    }
}
