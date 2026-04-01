/**
 * IntentAgent — Decodes user request into structured intent
 *
 * Makes a single focused DeepSeek API call to classify the user's task,
 * determine complexity, identify files in scope, and clarify the request.
 */

import { ApiClient, createApiClient } from '../apiClient';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TaskType = 'question' | 'edit' | 'refactor' | 'debug' | 'create' | 'explain';
export type Complexity = 'simple' | 'moderate' | 'complex';

export interface IntentResult {
    taskType: TaskType;
    filesInScope: string[];
    clarifiedTask: string;
    complexity: Complexity;
    needsExternalRef: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const INTENT_SYSTEM_PROMPT = `You are an intent classifier for a coding assistant. Given a user's task and recently modified files, produce a JSON object with these fields:

- taskType: one of "question", "edit", "refactor", "debug", "create", "explain"
- filesInScope: array of file paths relevant to the task (from the recently modified files or inferred from the task description)
- clarifiedTask: a clear, unambiguous restatement of what the user wants done
- complexity: one of "simple" (single file, small change), "moderate" (few files, some logic), "complex" (multi-file, architectural)
- needsExternalRef: boolean — true if the task references libraries, frameworks, or APIs the assistant may need to look up

Be precise and concise. Output valid JSON only.`;

// ─── IntentAgent ─────────────────────────────────────────────────────────────

export class IntentAgent {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly apiClient: ApiClient;

    constructor(apiKey: string, model: string) {
        this.apiKey = apiKey;
        this.model = model;
        this.apiClient = createApiClient({ apiKey, model });
    }

    /**
     * Analyze a raw user task and produce a structured intent.
     */
    async analyze(task: string, recentFiles: string[]): Promise<IntentResult> {
        const userContent = [
            `Task: ${task}`,
            '',
            'Recently modified files:',
            ...recentFiles.map(f => `  - ${f}`),
        ].join('\n');

        const raw = await this.callAPI(userContent);

        try {
            const parsed = JSON.parse(raw);
            return {
                taskType: this.validateTaskType(parsed.taskType),
                filesInScope: Array.isArray(parsed.filesInScope) ? parsed.filesInScope : [],
                clarifiedTask: typeof parsed.clarifiedTask === 'string' ? parsed.clarifiedTask : task,
                complexity: this.validateComplexity(parsed.complexity),
                needsExternalRef: !!parsed.needsExternalRef,
            };
        } catch {
            // Fallback if parsing fails — return a safe default
            return {
                taskType: 'question',
                filesInScope: recentFiles,
                clarifiedTask: task,
                complexity: 'moderate',
                needsExternalRef: false,
            };
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    private validateTaskType(value: unknown): TaskType {
        const valid: TaskType[] = ['question', 'edit', 'refactor', 'debug', 'create', 'explain'];
        return valid.includes(value as TaskType) ? (value as TaskType) : 'question';
    }

    private validateComplexity(value: unknown): Complexity {
        const valid: Complexity[] = ['simple', 'moderate', 'complex'];
        return valid.includes(value as Complexity) ? (value as Complexity) : 'moderate';
    }

    // ─── DeepSeek API Call ───────────────────────────────────────────────

    private async callAPI(userContent: string): Promise<string> {
        const result = await this.apiClient.chatCompletion({
            messages: [
                { role: 'system', content: INTENT_SYSTEM_PROMPT },
                { role: 'user', content: userContent },
            ],
            temperature: 0,
            responseFormat: { type: 'json_object' },
        });
        if (!result.content) {
            throw new Error('IntentAgent: no content in API response');
        }
        return result.content;
    }
}
