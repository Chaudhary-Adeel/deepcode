/**
 * PlannerAgent — Plans approach before code generation
 *
 * Takes a clarified task, file skeletons, and workspace context,
 * then produces a structured plan: approach, file ordering, patterns, and risks.
 */

import { ApiClient, createApiClient } from '../apiClient';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlanResult {
    approach: string;
    fileOrder: string[];
    pattern: string;
    risks: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `You are a code planning agent. Given a task, file skeletons, and workspace context, produce a JSON plan with these fields:

- approach: a concise description of how to accomplish the task step-by-step
- fileOrder: array of file paths in the order they should be created or modified
- pattern: the primary design pattern or architectural approach to use (e.g. "observer", "factory", "middleware chain", "simple function")
- risks: array of potential risks, edge cases, or things that could go wrong

Think carefully about dependencies between files — edit/create leaf modules before higher-level ones.
Output valid JSON only.`;

// ─── PlannerAgent ────────────────────────────────────────────────────────────

export class PlannerAgent {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly apiClient: ApiClient;

    constructor(apiKey: string, model: string) {
        this.apiKey = apiKey;
        this.model = model;
        this.apiClient = createApiClient({ apiKey, model });
    }

    /**
     * Generate an execution plan for the given task.
     */
    async plan(
        clarifiedTask: string,
        fileSkeletons: string,
        workspaceContext: string
    ): Promise<PlanResult> {
        const userContent = [
            `## Task`,
            clarifiedTask,
            '',
            `## File Skeletons`,
            fileSkeletons,
            '',
            `## Workspace Context`,
            workspaceContext,
        ].join('\n');

        const raw = await this.callAPI(userContent);

        try {
            const parsed = JSON.parse(raw);
            return {
                approach: typeof parsed.approach === 'string' ? parsed.approach : '',
                fileOrder: Array.isArray(parsed.fileOrder) ? parsed.fileOrder : [],
                pattern: typeof parsed.pattern === 'string' ? parsed.pattern : 'unknown',
                risks: Array.isArray(parsed.risks) ? parsed.risks : [],
            };
        } catch {
            // Fallback — return a minimal plan so the pipeline can continue
            return {
                approach: clarifiedTask,
                fileOrder: [],
                pattern: 'unknown',
                risks: ['Failed to parse planner output — proceeding with defaults'],
            };
        }
    }

    // ─── DeepSeek API Call ───────────────────────────────────────────────

    private async callAPI(userContent: string): Promise<string> {
        const result = await this.apiClient.chatCompletion({
            messages: [
                { role: 'system', content: PLANNER_SYSTEM_PROMPT },
                { role: 'user', content: userContent },
            ],
            temperature: 0,
            responseFormat: { type: 'json_object' },
        });
        if (!result.content) {
            throw new Error('PlannerAgent: no content in API response');
        }
        return result.content;
    }
}
