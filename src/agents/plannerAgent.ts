/**
 * PlannerAgent — Plans approach before code generation
 *
 * Takes a clarified task, file skeletons, and workspace context,
 * then produces a structured plan: approach, file ordering, patterns, and risks.
 */

import * as https from 'https';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlanResult {
    approach: string;
    fileOrder: string[];
    pattern: string;
    risks: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEEPSEEK_API_BASE = 'api.deepseek.com';

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

    constructor(apiKey: string, model: string) {
        this.apiKey = apiKey;
        this.model = model;
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

    private callAPI(userContent: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                model: this.model,
                messages: [
                    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
                    { role: 'user', content: userContent },
                ],
                temperature: 0,
                response_format: { type: 'json_object' },
            });

            const reqOpts: https.RequestOptions = {
                hostname: DEEPSEEK_API_BASE,
                port: 443,
                path: '/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.apiKey}`,
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
                            let errMsg = `PlannerAgent API error: ${res.statusCode}`;
                            try {
                                const err = JSON.parse(data);
                                errMsg = err.error?.message || errMsg;
                            } catch { /* use default */ }
                            reject(new Error(errMsg));
                            return;
                        }

                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.message?.content;
                        if (!content) {
                            reject(new Error('PlannerAgent: no content in API response'));
                            return;
                        }
                        resolve(content);
                    } catch (e) {
                        reject(new Error(`PlannerAgent: failed to parse API response: ${e}`));
                    }
                });
            });

            req.on('error', (e) =>
                reject(new Error(`PlannerAgent network error: ${e.message}`))
            );
            req.write(body);
            req.end();
        });
    }
}
