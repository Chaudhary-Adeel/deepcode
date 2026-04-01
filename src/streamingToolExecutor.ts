/**
 * Streaming Tool Executor for DeepCode
 *
 * Executes tools as their tool_use blocks arrive during API streaming,
 * instead of waiting for the full response. Respects concurrency safety:
 *   - Safe tools (read_file, grep_search, etc.) run in parallel
 *   - Unsafe tools (write_file, edit_file, run_command) run sequentially
 *   - Safe tools do NOT run in parallel with unsafe tools
 */

import { ToolCallResult, ToolExecutor, isToolConcurrencySafe } from './tools';

// ─── Types ───────────────────────────────────────────────────────────────────

interface TrackedEntry {
    block: { id: string; name: string; arguments: Record<string, any> };
    state: 'pending' | 'running' | 'completed';
    promise: Promise<ToolCallResult> | null;
    result: ToolCallResult | null;
    isSafe: boolean;
}

// ─── StreamingToolExecutor ───────────────────────────────────────────────────

export class StreamingToolExecutor {
    private readonly toolExecutor: ToolExecutor;
    private readonly entries: TrackedEntry[] = [];
    private cancelled = false;
    /** Chain of unsafe (write) tool executions — safe tools await this before starting */
    private unsafeChain: Promise<void> = Promise.resolve();

    constructor(toolExecutor: ToolExecutor) {
        this.toolExecutor = toolExecutor;
    }

    /**
     * Called as each tool_use block arrives during streaming.
     * Immediately starts executing the tool in a background promise,
     * respecting concurrency safety rules.
     */
    addTool(toolBlock: { id: string; name: string; arguments: Record<string, any> }): void {
        if (this.cancelled) { return; }

        const isSafe = isToolConcurrencySafe(toolBlock.name);
        const entry: TrackedEntry = {
            block: toolBlock,
            state: 'pending',
            promise: null,
            result: null,
            isSafe,
        };
        this.entries.push(entry);

        if (isSafe) {
            entry.promise = this.executeSafe(entry);
        } else {
            entry.promise = this.executeUnsafe(entry);
        }
    }

    /** Returns results that have finished so far (non-blocking). */
    getCompletedResults(): ToolCallResult[] {
        return this.entries
            .filter(e => e.state === 'completed' && e.result !== null)
            .map(e => e.result!);
    }

    /** Wait for all pending executions to complete, return all results. */
    async waitForAll(): Promise<ToolCallResult[]> {
        const promises = this.entries
            .filter(e => e.promise !== null)
            .map(e => e.promise!);
        await Promise.allSettled(promises);
        return this.entries.map(e => e.result || { success: false, output: 'No result' });
    }

    /** Async generator that yields remaining results as they complete. */
    async *getRemainingResults(): AsyncGenerator<ToolCallResult> {
        for (const entry of this.entries) {
            if (entry.state === 'completed') { continue; }
            if (entry.promise) {
                yield await entry.promise;
            }
        }
    }

    /** Returns a map of tool ID → result for all completed tools. */
    getResultMap(): Map<string, ToolCallResult> {
        const map = new Map<string, ToolCallResult>();
        for (const entry of this.entries) {
            if (entry.result) {
                map.set(entry.block.id, entry.result);
            }
        }
        return map;
    }

    /**
     * Cancel all pending executions (for abort/fallback).
     * Sets a cancelled flag that prevents new tools from starting,
     * but lets currently-running tools finish.
     */
    discard(): void {
        this.cancelled = true;
    }

    // ─── Internal execution helpers ──────────────────────────────────────

    /** Execute a concurrency-safe tool — runs in parallel with other safe tools, waits for unsafe chain. */
    private async executeSafe(entry: TrackedEntry): Promise<ToolCallResult> {
        await this.unsafeChain;
        if (this.cancelled) {
            return this.makeCancelledResult(entry);
        }
        return this.executeEntry(entry);
    }

    /** Execute a non-safe tool — waits for unsafe chain AND all running safe tools. */
    private async executeUnsafe(entry: TrackedEntry): Promise<ToolCallResult> {
        const previousChain = this.unsafeChain;
        let resolveChain!: () => void;
        this.unsafeChain = new Promise<void>(resolve => { resolveChain = resolve; });

        await previousChain;

        // Wait for all currently running (safe) tools to finish
        const running = this.entries
            .filter(e => e !== entry && e.state === 'running' && e.promise)
            .map(e => e.promise!);
        if (running.length > 0) {
            await Promise.allSettled(running);
        }

        if (this.cancelled) {
            resolveChain();
            return this.makeCancelledResult(entry);
        }

        try {
            return await this.executeEntry(entry);
        } finally {
            resolveChain();
        }
    }

    /** Run a single tool via the ToolExecutor. */
    private async executeEntry(entry: TrackedEntry): Promise<ToolCallResult> {
        entry.state = 'running';
        try {
            const result = await this.toolExecutor.execute(
                entry.block.name,
                entry.block.arguments,
            );
            entry.result = result;
            entry.state = 'completed';
            return result;
        } catch (error: any) {
            const result: ToolCallResult = {
                success: false,
                output: `Tool "${entry.block.name}" failed: ${error?.message || String(error)}`,
            };
            entry.result = result;
            entry.state = 'completed';
            return result;
        }
    }

    private makeCancelledResult(entry: TrackedEntry): ToolCallResult {
        const result: ToolCallResult = { success: false, output: 'Execution cancelled' };
        entry.result = result;
        entry.state = 'completed';
        return result;
    }
}
