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
import { LLMProvider } from './providers/types';
import { OpenAICompatibleProvider } from './providers/openaiCompatible';
import { DEEPSEEK_CONFIG } from './providers/configs';
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
import { recordTranscript, recordSubAgentTranscript } from './sessionStorage';

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
    /** LLM provider instance — when set, apiKey/model are ignored for API calls */
    provider?: LLMProvider;
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
    /** Session ID for transcript persistence — when set, conversation is recorded to disk */
    sessionId?: string;
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
const MAX_IDENTICAL_TOOL_CALLS = 2;

/** Inject a goal reminder into state.messages every N turns to prevent task drift */
const GOAL_REMINDER_INTERVAL = 5;

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
    /** The original user goal — used to anchor the agent and prevent task drift */
    originalGoal: string;
    /** The turn at which the last goal reminder was injected */
    lastGoalReminderTurn: number;
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
        originalGoal: userMessage,
        lastGoalReminderTurn: 0,
    };
}

// ─── Sub-Agent System Prompt ─────────────────────────────────────────────────

const SUBAGENT_SYSTEM_PROMPT = `You are a focused sub-agent working on a specific task. Be fast, precise, and thorough.

## Strategy
1. Understand the task fully before acting
2. Read relevant files first — never edit blind
3. Batch reads: request all needed files in one turn
4. Make targeted, surgical changes
5. Verify your changes compile if editing code

## Output Format
Return a clear, structured summary:
- **What was done**: List of changes made or findings discovered
- **Files affected**: Paths of files read or modified
- **Key details**: Important technical details the parent agent needs to know
- **Issues found**: Any problems, warnings, or edge cases discovered

## Rules
- Stay focused on your assigned task — don't expand scope
- Use the minimum tools needed — efficiency matters
- If you can't complete the task, explain what's blocking you
- Never modify files outside the scope of your task`;

// ─── Main Agent System Prompt ────────────────────────────────────────────────

export const AGENT_SYSTEM_PROMPT = `You are DeepCode — an expert AI coding agent in VS Code. You think → plan → act → observe → iterate until done.

## Identity & Philosophy
- You are autonomous — use tools proactively, don't ask permission for routine operations
- You are thorough — verify your changes work before declaring done
- You are efficient — minimize token usage, batch operations, avoid redundant reads
- You produce working code — partial fixes are unacceptable, iterate until the solution is complete
- You respect the user's codebase — match existing style, conventions, and architecture

## Planning (CRITICAL)
Before executing ANY multi-step task:
1. **Assess scope**: How many files? How complex? What could go wrong?
2. **Plan first**: For tasks touching 3+ files, think through the sequence BEFORE calling tools
3. **Batch reads**: Read all needed files in one turn, then plan edits, then batch edits
4. **Checkpoint**: After major changes, verify with diagnostics or run_command
5. **Decompose**: Break large tasks into independent subtasks — parallelize with sub-agents when possible

## Tool Strategy (ranked by efficiency)
- **Already in context?** → Use it directly. NEVER re-read a file whose content is in the conversation.
- **Simple question?** → Answer directly, no tools needed.
- **Need structure?** → get_file_skeleton first, then targeted read_file for specific sections.
- **Need to find code?** → semantic_search for concepts, search_symbol for names, grep_search for exact text.
- **Need to edit?** → If content is in context: edit_file directly. If not: read_file → edit_file. That's it.
- **Multi-file edits?** → Use multi_edit_files for atomic changes across files.
- **Complex task?** → Use run_subagent to parallelize independent work.
- **Diagnostics?** → Run automatically after edits. Only call manually if debugging a specific issue.
- **Web info?** → Use web_search only when workspace information is genuinely insufficient.
- **Prefer batching** → Multiple tool calls in ONE response over sequential single calls.

## Confidence & Decision Making
- **High confidence (>80%)**: Act immediately. Don't over-research obvious changes.
- **Medium confidence (50-80%)**: Do one targeted search to confirm, then act.
- **Low confidence (<50%)**: Research thoroughly before making changes. If still uncertain after 3 tool calls, explain your uncertainty to the user.
- **Ambiguous request**: Make the most reasonable interpretation and proceed. Mention your assumption briefly.
- **Conflicting evidence**: Prefer what's actually in the code over what docs/comments claim.

## Resource Awareness
- You have a limited iteration budget. Don't waste turns on unnecessary exploration.
- If you've used 5+ tool calls on a simple task, stop and reassess your approach.
- Long tool outputs are automatically truncated. Request specific line ranges with read_file when possible.
- For large files (500+ lines), use get_file_skeleton first to understand structure.
- Prefer grep_search with file patterns over reading entire directories.
- Track what you've already learned — never re-discover the same information.

## Edit Rules
- oldText MUST be an exact, verbatim copy from the file (including whitespace, indentation, line breaks)
- Include enough surrounding context in oldText for a unique match — at minimum 2-3 lines
- For changes spanning multiple files, prefer multi_edit_files over separate edit_file calls
- Diagnostics run automatically after edits — if errors appear, fix them immediately
- For simple edits: just call edit_file and respond. Do not over-think it.
- When creating new files, use write_file. When modifying existing files, always use edit_file.
- Never use edit_file on a file you haven't read or don't have in context.

## Error Recovery
- On tool failure: read the error carefully, adjust arguments, retry once
- After 2 failures of the same tool: try an alternative approach
- If edit_file fails to match: re-read the file to get current content, then retry
- If a command fails: check if you need to cd to the right directory or install dependencies first
- If a sub-agent fails: analyze its output, then either retry with clearer instructions or do it yourself
- NEVER give up after a single failure — persistence is required

## Code Quality Standards
- Match existing code style, naming conventions, and patterns exactly
- Add imports where needed — don't leave undefined references
- Handle edge cases and error conditions
- Preserve existing comments and documentation unless they're now incorrect
- When adding new functions/classes, follow the patterns established in the file
- Test-related changes should maintain or improve coverage

## Response Quality
- Lead with the answer. Be direct and specific.
- For code changes: briefly explain what changed and why
- Use technical terms precisely
- If a task is complete, say so clearly. If it's partially done, explain what remains.
- For errors: explain the root cause, not just the symptom
- NEVER mention internal mechanics (tools, sub-agents, iterations). Present work naturally.
- NEVER fabricate file contents, error messages, or tool outputs.

## Multi-Turn Awareness
- Remember what the user has asked before in this conversation
- Build on previous context — don't repeat work already done
- If the user corrects you, acknowledge and adjust immediately
- Track which files you've modified in this session to avoid conflicts

## Workspace
{WORKSPACE_CONTEXT}`;

// ─── Agent Loop Implementation ───────────────────────────────────────────────

export class AgentLoop {
    private provider: LLMProvider;

    constructor(private opts: AgentLoopOptions) {
        if (opts.provider) {
            this.provider = opts.provider;
        } else {
            this.provider = new OpenAICompatibleProvider(
                opts.apiKey,
                DEEPSEEK_CONFIG,
                undefined,
                opts.fallbackModel,
            );
        }
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
                this.opts.onProgress?.('Understanding your request...');
            } else {
                const toolsSoFar = state.toolCallLog.length;
                const lastTool = toolsSoFar > 0 ? state.toolCallLog[toolsSoFar - 1] : null;
                if (lastTool && !lastTool.success) {
                    this.opts.onProgress?.(`Retrying ${lastTool.name} with adjusted approach...`);
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

                // ── Periodic goal reminder to prevent task drift ──
                if (
                    state.turnCount > 1 &&
                    state.turnCount - state.lastGoalReminderTurn >= GOAL_REMINDER_INTERVAL
                ) {
                    const goalReminder: AgentMessage = {
                        role: 'user' as const,
                        content: `[SYSTEM: Goal reminder — your original task is: "${state.originalGoal}". Stay focused on this. Do not perform work outside this scope.]`,
                    };
                    state = {
                        ...state,
                        messages: [...state.messages, goalReminder],
                        lastGoalReminderTurn: state.turnCount,
                    };
                    compressedMessages = microcompact(state.messages);
                }

                if (shouldAutocompact(compressedMessages)) {
                    this.opts.onProgress?.('Optimizing context window...');
                    try {
                        const summaryPrompt = buildAutocompactPrompt(compressedMessages, state.originalGoal);
                        const summaryResult = await this.provider.chatCompletion({
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
                                state.originalGoal,
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
                    this.opts.onProgress?.(`Context window full — compressing history (${attempt}/2)...`);

                    if (state.promptTooLongCount < 1) {
                        // First occurrence: autocompact
                        try {
                            const summaryPrompt = buildAutocompactPrompt(state.messages);
                            const summaryResult = await this.provider.chatCompletion({
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
                // On 2nd retry, switch to fallback model if configured
                if (consecutiveApiErrors === 2 && this.opts.fallbackModel && !this.opts.provider) {
                    this.opts.onProgress?.('Switching to fallback model...');
                    this.opts.onModelFallback?.(this.opts.model, this.opts.fallbackModel);
                    this.provider = new OpenAICompatibleProvider(
                        this.opts.apiKey,
                        DEEPSEEK_CONFIG,
                        undefined,
                    );
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
                this.opts.onProgress?.(`Response was cut short — continuing seamlessly (${state.maxOutputRecoveryCount}/3)...`);
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
                    this.opts.onProgress?.('Consolidating findings...');
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
                                output: `Tool "${tc.function.name}" has been blocked after repeated failures. Alternative approaches:\n` +
                                    '- For file reading: try get_file_skeleton first, then read_file with specific line ranges\n' +
                                    '- For editing: re-read the file, then use write_file to replace the entire file if edit_file keeps failing\n' +
                                    '- For searching: try a different search tool (grep_search, semantic_search, search_symbol)\n' +
                                    '- For commands: check if the command exists and the working directory is correct',
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

                            // Build contextual recovery suggestion
                            let suggestion = 'Please review the arguments and try again.';
                            if (errorMsg.includes('ENOENT') || errorMsg.includes('not found') || errorMsg.includes('no such file')) {
                                suggestion = 'The file or path was not found. Use list_directory or search_files to find the correct path.';
                            } else if (errorMsg.includes('permission') || errorMsg.includes('EACCES')) {
                                suggestion = 'Permission denied. Try a different path or check file permissions.';
                            } else if (errorMsg.includes('ENOSPC')) {
                                suggestion = 'Disk space is full. Cannot write files.';
                            } else if (errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) {
                                suggestion = 'The operation timed out. Try a simpler command or break it into smaller steps.';
                            } else if (errorMsg.includes('syntax') || errorMsg.includes('parse')) {
                                suggestion = 'There may be a syntax error in the arguments. Double-check the format.';
                            } else if (tc.function.name === 'edit_file' && (errorMsg.includes('not found in file') || errorMsg.includes('oldText'))) {
                                suggestion = 'The oldText was not found. Re-read the file to get the exact current content, then retry with the correct text.';
                            }

                            const result: ToolCallResult = {
                                success: false,
                                output: `Tool "${tc.function.name}" failed: ${errorMsg}. ${suggestion}`,
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

                // If any edit tool failed, inject a system hint to re-read before retrying
                const editFailed = toolResults.some(tr =>
                    ['edit_file', 'write_file', 'multi_edit_files'].includes(tr.name) && !tr.result.success
                );
                if (editFailed) {
                    state.messages = [...state.messages, {
                        role: 'user' as const,
                        content: '[SYSTEM: An edit operation failed. Re-read the file to get the current content before retrying. Use exact, verbatim text for oldText matches.]',
                    }];
                }

                // Check for cancellation after tool execution completes
                if (this.opts.checkCancelled?.()) {
                    cancelRequested = true;
                }

                // Record transcript after each tool-call turn
                if (this.opts.sessionId) {
                    recordTranscript(this.opts.sessionId, state.messages);
                }

                state = { ...state, transition: { reason: 'next_turn' } };
            } else {
                // No tool calls — model returned a final text response
                if (this.opts.sessionId) {
                    recordTranscript(this.opts.sessionId, state.messages);
                }
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
        this.opts.onProgress?.('Composing final response...');

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

        const names = toolCalls.map(tc => tc.function.name);
        const uniqueNames = [...new Set(names)];

        if (uniqueNames.length === 1) {
            const name = uniqueNames[0];
            if (name === 'read_file') return `Reading ${toolCalls.length} files in parallel`;
            if (name === 'grep_search') return 'Searching across the codebase';
            if (name === 'edit_file') return `Applying edits to ${toolCalls.length} files`;
            if (name === 'run_subagent') return `Dispatching ${toolCalls.length} parallel agents`;
        }

        const hasSearch = names.some(n => ['grep_search', 'search_files', 'semantic_search', 'search_symbol'].includes(n));
        const hasRead = names.some(n => n === 'read_file' || n === 'get_file_skeleton');
        const hasEdit = names.some(n => ['edit_file', 'write_file', 'multi_edit_files'].includes(n));
        const hasSubAgent = names.some(n => n === 'run_subagent');
        const hasDiag = names.some(n => n === 'get_diagnostics' || n === 'run_command');

        if (hasSubAgent) return `Coordinating ${names.filter(n => n === 'run_subagent').length} parallel tasks`;
        if (hasEdit && hasDiag) return 'Applying changes and verifying';
        if (hasEdit) return `Editing ${names.filter(n => ['edit_file', 'write_file', 'multi_edit_files'].includes(n)).length} files`;
        if (hasSearch && hasRead) return 'Searching and analyzing code';
        if (hasSearch) return 'Searching the codebase';
        if (hasRead) return `Analyzing ${names.filter(n => n === 'read_file' || n === 'get_file_skeleton').length} files`;

        return `Executing ${toolCalls.length} operations`;
    }

    private describeOneTool(tc: ToolCall): string {
        let args: Record<string, any> = {};
        try { args = JSON.parse(tc.function.arguments); } catch { /* */ }

        switch (tc.function.name) {
            case 'read_file': {
                const file = (args.path || '').split('/').pop() || 'file';
                return args.startLine || args.start_line
                    ? `Reading ${file} (lines ${args.startLine || args.start_line}–${args.endLine || args.end_line || '…'})`
                    : `Reading ${file}`;
            }
            case 'write_file': return `Creating ${(args.path || 'file').split('/').pop()}`;
            case 'edit_file': return `Editing ${(args.path || 'file').split('/').pop()}`;
            case 'multi_edit_files': return `Editing ${(args.files || []).length} files atomically`;
            case 'list_directory': {
                const dir = args.path || '.';
                return dir === '.' || dir === '' ? 'Mapping project structure' : `Scanning ${dir}/`;
            }
            case 'search_files': return `Finding files matching "${args.pattern || '*'}"`;
            case 'grep_search': return `Searching for "${(args.query || '').substring(0, 40)}"`;
            case 'semantic_search': return `Semantic search: "${(args.query || '').substring(0, 40)}"`;
            case 'search_symbol': return `Looking up \`${args.symbol || args.name || ''}\``;
            case 'find_references': return `Tracing references to \`${args.symbol || args.symbolName || ''}\``;
            case 'get_file_skeleton': return `Scanning file structure`;
            case 'run_command': {
                const cmd = (args.command || '').substring(0, 40);
                if (cmd.includes('test')) return `Running tests`;
                if (cmd.includes('build') || cmd.includes('tsc')) return `Building project`;
                if (cmd.includes('lint')) return `Running linter`;
                return `Running: ${cmd}`;
            }
            case 'get_diagnostics': return 'Checking for errors';
            case 'web_search': return `Searching web: "${(args.query || '').substring(0, 40)}"`;
            case 'fetch_webpage': return 'Fetching documentation';
            case 'run_subagent': {
                const task = (args.task || '').substring(0, 50);
                return args.background ? `Launching background agent` : `Delegating: ${task}`;
            }
            default: return tc.function.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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
        this.opts.onProgress?.(`Delegating: ${shortTask}`);

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

            // Record sub-agent transcript if session tracking is active
            if (this.opts.sessionId) {
                const agentId = (args.name || task).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 60);
                const subAgentMessages: AgentMessage[] = [
                    { role: 'user', content: userMsg },
                    { role: 'assistant', content: result.content },
                ];
                recordSubAgentTranscript(this.opts.sessionId, agentId, subAgentMessages);
            }

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

            for await (const event of this.provider.streamChatCompletion(completionOpts)) {
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
            const result = await this.provider.chatCompletion(completionOpts);
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
