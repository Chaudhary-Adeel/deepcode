/**
 * Query Engine for DeepCode
 *
 * Owns the session lifecycle: conversation history, token budgets,
 * cost tracking, and transcript persistence. Wraps AgentLoop so that
 * callers (SubAgentService, sidebar, tests) get a stateful, multi-turn
 * interface without managing messages or sessions themselves.
 */

import {
    AgentLoop,
    AgentLoopOptions,
    AgentLoopResult,
    AgentMessage,
    AGENT_SYSTEM_PROMPT,
} from './agentLoop';
import { ToolExecutor, AGENT_TOOLS, ToolCallResult } from './tools';
import { recordTranscript, loadTranscript } from './sessionStorage';

// ─── DeepSeek V3 pricing (per 1M tokens) ────────────────────────────────────
const INPUT_COST_PER_M = 0.14;
const OUTPUT_COST_PER_M = 0.28;
// Rough split assumption: 60% input, 40% output
const INPUT_RATIO = 0.6;
const OUTPUT_RATIO = 0.4;
const BUDGET_WARNING_THRESHOLD = 0.8;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QueryEngineOptions {
    apiKey: string;
    model: string;
    fallbackModel?: string;
    sessionId: string;
    systemPrompt?: string;
    maxIterations?: number;
    maxBudgetTokens?: number;
    onProgress?: (message: string) => void;
    onToolCall?: (toolName: string, args: Record<string, any>) => void;
    onToolResult?: (toolName: string, result: any) => void;
    onLLMReason?: (reasoning: string) => void;
    onFileChanged?: (file: { relPath: string; originalContent: string; added: number; removed: number }) => void;
    onToken?: (token: string) => void;
    onModelFallback?: (primary: string, fallback: string) => void;
    onBudgetWarning?: (used: number, budget: number) => void;
}

// ─── QueryEngine ─────────────────────────────────────────────────────────────

export class QueryEngine {
    private readonly sessionId: string;
    private messages: AgentMessage[] = [];
    private totalTokens = 0;
    private totalCost = 0;
    private turnCount = 0;
    private abortController: { cancelled: boolean } = { cancelled: false };
    private readonly opts: QueryEngineOptions;
    private readonly toolExecutor: ToolExecutor;

    constructor(opts: QueryEngineOptions) {
        this.opts = opts;
        this.sessionId = opts.sessionId;
        this.toolExecutor = new ToolExecutor();
    }

    /**
     * Submit a user message, run one AgentLoop turn, return result.
     */
    async submitMessage(prompt: string): Promise<AgentLoopResult> {
        // 1. Budget check — warn at 80%
        if (this.opts.maxBudgetTokens && this.totalTokens > 0) {
            const ratio = this.totalTokens / this.opts.maxBudgetTokens;
            if (ratio >= BUDGET_WARNING_THRESHOLD) {
                this.opts.onBudgetWarning?.(this.totalTokens, this.opts.maxBudgetTokens);
            }
        }

        // Reset abort flag for this turn
        this.abortController = { cancelled: false };
        const abortRef = this.abortController;

        // 2. Create AgentLoop
        const loopOpts: AgentLoopOptions = {
            apiKey: this.opts.apiKey,
            model: this.opts.model,
            fallbackModel: this.opts.fallbackModel,
            systemPrompt: this.opts.systemPrompt || AGENT_SYSTEM_PROMPT,
            temperature: 0,
            topP: 0.95,
            maxTokens: 4096,
            maxIterations: this.opts.maxIterations ?? 60,
            tools: AGENT_TOOLS,
            toolExecutor: this.toolExecutor,
            onProgress: this.opts.onProgress,
            onToolCall: this.opts.onToolCall,
            onToolResult: this.opts.onToolResult,
            onLLMReason: this.opts.onLLMReason,
            onFileChanged: this.opts.onFileChanged,
            onToken: this.opts.onToken,
            onModelFallback: this.opts.onModelFallback,
            checkCancelled: () => abortRef.cancelled,
            sessionId: this.sessionId,
        };

        const agentLoop = new AgentLoop(loopOpts);

        // 3. Run with conversation history
        const result = await agentLoop.run(prompt, this.messages.length > 0 ? this.messages : undefined);

        // 4. Append user + assistant messages to history
        this.messages.push({ role: 'user', content: prompt });
        if (result.content) {
            this.messages.push({ role: 'assistant', content: result.content });
        }

        // 5. Accumulate tokens
        this.totalTokens += result.totalTokens;

        // 6. Update cost estimate
        this.totalCost += this.estimateTurnCost(result.totalTokens);

        // 7. Increment turn count
        this.turnCount++;

        // 8. Record transcript (fire-and-forget)
        try {
            recordTranscript(this.sessionId, this.messages);
        } catch {
            // fire-and-forget
        }

        // 9. Budget exceeded warning — attach to result content
        if (this.opts.maxBudgetTokens && this.totalTokens > this.opts.maxBudgetTokens) {
            const warning = `\n\n⚠️ Token budget exceeded: ${this.totalTokens.toLocaleString()} / ${this.opts.maxBudgetTokens.toLocaleString()} tokens used.`;
            return { ...result, content: result.content + warning };
        }

        return result;
    }

    /** Abort current turn */
    interrupt(): void {
        this.abortController.cancelled = true;
    }

    /** Read-only access to conversation history */
    getMessages(): ReadonlyArray<AgentMessage> {
        return this.messages;
    }

    getSessionId(): string {
        return this.sessionId;
    }

    getTotalTokens(): number {
        return this.totalTokens;
    }

    getTurnCount(): number {
        return this.turnCount;
    }

    /** Estimate cost based on token usage (DeepSeek V3 pricing) */
    getEstimatedCost(): number {
        return this.totalCost;
    }

    /** Load a previous session's messages for resume */
    async loadSession(sessionId: string): Promise<boolean> {
        const transcript = loadTranscript(sessionId);
        if (!transcript) { return false; }
        this.messages = transcript.messages
            .filter(m => m.role !== 'system')
            .map(m => ({
                role: m.role as AgentMessage['role'],
                content: m.content,
                ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            }));
        return true;
    }

    // ─── Private ─────────────────────────────────────────────────────────

    private estimateTurnCost(tokens: number): number {
        const inputTokens = tokens * INPUT_RATIO;
        const outputTokens = tokens * OUTPUT_RATIO;
        return (inputTokens / 1_000_000) * INPUT_COST_PER_M
             + (outputTokens / 1_000_000) * OUTPUT_COST_PER_M;
    }
}
