/**
 * Verifier — Verifies generated code via tsc/lint/tests
 *
 * Applies a verify command (configurable), checks output, and on failure
 * searches the web for error solutions and retries up to 3 times.
 */

import * as vscode from 'vscode';
import * as https from 'https';
import { exec } from 'child_process';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VerifyResult {
    passed: boolean;
    errors: string[];
    attempts: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEEPSEEK_API_BASE = 'api.deepseek.com';
const MAX_RETRIES = 3;
const EXEC_TIMEOUT_MS = 60_000;

const FIX_SYSTEM_PROMPT = `You are an error-fixing agent. Given a TypeScript/JavaScript compilation or lint error and a web-search result about the error, produce a concise JSON object:

{
  "diagnosis": "One-sentence root cause",
  "suggestedFix": "Concrete code-level fix description",
  "commands": ["any shell commands to run, e.g. npm install missing-package"]
}

Output valid JSON only.`;

// ─── Verifier ────────────────────────────────────────────────────────────────

export class Verifier {
    private readonly apiKey: string;
    private readonly model: string;

    constructor(apiKey: string, model: string) {
        this.apiKey = apiKey;
        this.model = model;
    }

    /**
     * Run the verify command in the workspace, retrying on failure
     * with web-searched solutions fed back to the caller.
     */
    async run(workspaceRoot: string): Promise<VerifyResult> {
        const verifyCommand = vscode.workspace
            .getConfiguration('deepcode')
            .get<string>('verifyCommand', 'npx tsc --noEmit');

        const allErrors: string[] = [];
        let attempt = 0;

        while (attempt < MAX_RETRIES) {
            attempt++;

            const { exitCode, stdout, stderr } = await this.execCommand(
                verifyCommand,
                workspaceRoot
            );

            if (exitCode === 0) {
                return { passed: true, errors: [], attempts: attempt };
            }

            // Collect error output
            const errorOutput = (stderr || stdout || '').trim();
            const errorLines = errorOutput
                .split('\n')
                .filter(line => line.trim().length > 0);
            allErrors.push(...errorLines);

            // If we've exhausted retries, don't search — just return
            if (attempt >= MAX_RETRIES) {
                break;
            }

            // Try to get a fix suggestion: web search the first error, then ask DeepSeek
            const firstError = errorLines[0] || errorOutput.substring(0, 200);
            try {
                const searchResult = await this.webSearchError(firstError);
                const fix = await this.getFix(firstError, searchResult);

                // If the fix suggests commands, run them
                if (fix.commands && fix.commands.length > 0) {
                    for (const cmd of fix.commands) {
                        await this.execCommand(cmd, workspaceRoot).catch(() => {
                            /* best effort */
                        });
                    }
                }

                // Push diagnosis into errors for caller visibility
                allErrors.push(`[Attempt ${attempt}] Diagnosis: ${fix.diagnosis}`);
                allErrors.push(`[Attempt ${attempt}] Suggested fix: ${fix.suggestedFix}`);
            } catch {
                // If web search or fix generation fails, just retry the verify
                allErrors.push(
                    `[Attempt ${attempt}] Could not auto-diagnose — retrying...`
                );
            }
        }

        // Deduplicate errors
        const uniqueErrors = [...new Set(allErrors)];
        return { passed: false, errors: uniqueErrors, attempts: attempt };
    }

    // ─── Command Execution ───────────────────────────────────────────────

    private execCommand(
        command: string,
        cwd: string
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return new Promise((resolve) => {
            exec(
                command,
                { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
                (error, stdout, stderr) => {
                    resolve({
                        exitCode: error ? (error as any).code ?? 1 : 0,
                        stdout: stdout || '',
                        stderr: stderr || '',
                    });
                }
            );
        });
    }

    // ─── Web Search for Error ────────────────────────────────────────────

    private webSearchError(errorMessage: string): Promise<string> {
        return new Promise((resolve, reject) => {
            // Trim and sanitize for search
            const query = errorMessage
                .replace(/[^\w\s:.'"()\-/\\]/g, '')
                .substring(0, 150);
            const encodedQuery = encodeURIComponent(`typescript ${query} fix`);

            const reqOpts: https.RequestOptions = {
                hostname: 'html.duckduckgo.com',
                port: 443,
                path: `/html/?q=${encodedQuery}`,
                method: 'GET',
                headers: {
                    'User-Agent': 'DeepCode-VSCode/1.0',
                },
            };

            const req = https.request(reqOpts, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    try {
                        const snippets = this.extractSnippets(data);
                        resolve(snippets);
                    } catch {
                        resolve('');
                    }
                });
            });

            req.on('error', (e) =>
                reject(new Error(`Verifier web search error: ${e.message}`))
            );
            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Verifier web search timeout'));
            });
            req.end();
        });
    }

    /**
     * Extract text snippets from DuckDuckGo HTML response.
     */
    private extractSnippets(html: string): string {
        const snippets: string[] = [];
        const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\//g;
        let match: RegExpExecArray | null;

        while ((match = snippetRegex.exec(html)) !== null && snippets.length < 5) {
            const text = match[1]
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#x27;/g, "'")
                .replace(/\s+/g, ' ')
                .trim();
            if (text.length > 20) {
                snippets.push(text);
            }
        }

        return snippets.join('\n\n');
    }

    // ─── Fix Generation via DeepSeek ─────────────────────────────────────

    private async getFix(
        errorMessage: string,
        webSearchResult: string
    ): Promise<{ diagnosis: string; suggestedFix: string; commands: string[] }> {
        const raw = await this.callAPI(
            `## Error\n${errorMessage}\n\n## Web Search Results\n${webSearchResult}`
        );

        try {
            const parsed = JSON.parse(raw);
            return {
                diagnosis: typeof parsed.diagnosis === 'string' ? parsed.diagnosis : 'Unknown',
                suggestedFix: typeof parsed.suggestedFix === 'string' ? parsed.suggestedFix : '',
                commands: Array.isArray(parsed.commands) ? parsed.commands : [],
            };
        } catch {
            return {
                diagnosis: 'Could not parse fix suggestion',
                suggestedFix: '',
                commands: [],
            };
        }
    }

    // ─── DeepSeek API Call ───────────────────────────────────────────────

    private callAPI(userContent: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                model: this.model,
                messages: [
                    { role: 'system', content: FIX_SYSTEM_PROMPT },
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
                            let errMsg = `Verifier API error: ${res.statusCode}`;
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
                            reject(new Error('Verifier: no content in API response'));
                            return;
                        }
                        resolve(content);
                    } catch (e) {
                        reject(new Error(`Verifier: failed to parse API response: ${e}`));
                    }
                });
            });

            req.on('error', (e) =>
                reject(new Error(`Verifier network error: ${e.message}`))
            );
            req.write(body);
            req.end();
        });
    }
}
