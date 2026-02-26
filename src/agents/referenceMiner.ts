/**
 * ReferenceMiner — Finds external code examples for unfamiliar libraries
 *
 * Uses DuckDuckGo web search to find relevant examples, then synthesizes
 * an implementation guide via DeepSeek.
 */

import * as https from 'https';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MinerResult {
    guide: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEEPSEEK_API_BASE = 'api.deepseek.com';

const SYNTHESIZER_SYSTEM_PROMPT = `You are a technical reference synthesizer. Given a task description and raw web search results about libraries/frameworks, produce a concise implementation guide containing:

1. Key API signatures and types relevant to the task
2. Short, concrete code examples showing the correct usage patterns
3. Common pitfalls or gotchas to avoid

Be precise and code-focused. Omit marketing content, installation instructions, and boilerplate. Output Markdown.`;

// ─── ReferenceMiner ──────────────────────────────────────────────────────────

export class ReferenceMiner {
    private readonly apiKey: string;
    private readonly model: string;

    constructor(apiKey: string, model: string) {
        this.apiKey = apiKey;
        this.model = model;
    }

    /**
     * Search the web for library/framework references and synthesize a guide.
     */
    async mine(clarifiedTask: string, libraries: string[]): Promise<MinerResult> {
        if (libraries.length === 0) {
            return { guide: '' };
        }

        // Run web searches in parallel for each library
        const searchPromises = libraries.map(lib =>
            this.webSearch(`${lib} API usage examples ${clarifiedTask.substring(0, 60)}`)
                .catch(() => '') // graceful degradation per-library
        );
        const searchResults = await Promise.all(searchPromises);

        // Combine non-empty results
        const combined = searchResults
            .filter(r => r.length > 0)
            .map((result, i) => `### ${libraries[i]}\n${result}`)
            .join('\n\n');

        if (!combined) {
            return { guide: '' };
        }

        // Synthesize a guide from the raw search results
        const guide = await this.synthesize(clarifiedTask, combined);
        return { guide };
    }

    // ─── Web Search (DuckDuckGo HTML) ────────────────────────────────────

    private webSearch(query: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const encodedQuery = encodeURIComponent(query);
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
                        // Extract text snippets from DuckDuckGo HTML results
                        const snippets = this.extractSnippets(data);
                        resolve(snippets);
                    } catch {
                        resolve('');
                    }
                });
            });

            req.on('error', (e) =>
                reject(new Error(`Web search error: ${e.message}`))
            );
            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Web search timeout'));
            });
            req.end();
        });
    }

    /**
     * Extract readable text snippets from DuckDuckGo HTML response.
     */
    private extractSnippets(html: string): string {
        const snippets: string[] = [];

        // Match result snippets — DuckDuckGo wraps them in <a class="result__snippet">
        const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\//g;
        let match: RegExpExecArray | null;
        while ((match = snippetRegex.exec(html)) !== null && snippets.length < 8) {
            const text = match[1]
                .replace(/<[^>]+>/g, '') // strip inner tags
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

        // Also try result titles for context
        const titleRegex = /class="result__a"[^>]*>([\s\S]*?)<\//g;
        const titles: string[] = [];
        while ((match = titleRegex.exec(html)) !== null && titles.length < 8) {
            const text = match[1].replace(/<[^>]+>/g, '').trim();
            if (text.length > 5) {
                titles.push(text);
            }
        }

        // Combine titles + snippets
        const lines: string[] = [];
        for (let i = 0; i < snippets.length; i++) {
            if (titles[i]) {
                lines.push(`**${titles[i]}**: ${snippets[i]}`);
            } else {
                lines.push(snippets[i]);
            }
        }

        return lines.join('\n\n');
    }

    // ─── Synthesis via DeepSeek ──────────────────────────────────────────

    private synthesize(task: string, rawSearchResults: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const userContent = [
                `## Task`,
                task,
                '',
                `## Raw Search Results`,
                rawSearchResults,
            ].join('\n');

            const body = JSON.stringify({
                model: this.model,
                messages: [
                    { role: 'system', content: SYNTHESIZER_SYSTEM_PROMPT },
                    { role: 'user', content: userContent },
                ],
                temperature: 0,
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
                            let errMsg = `ReferenceMiner synthesis API error: ${res.statusCode}`;
                            try {
                                const err = JSON.parse(data);
                                errMsg = err.error?.message || errMsg;
                            } catch { /* use default */ }
                            reject(new Error(errMsg));
                            return;
                        }

                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.message?.content;
                        resolve(content || '');
                    } catch (e) {
                        reject(new Error(`ReferenceMiner: failed to parse synthesis response: ${e}`));
                    }
                });
            });

            req.on('error', (e) =>
                reject(new Error(`ReferenceMiner synthesis network error: ${e.message}`))
            );
            req.write(body);
            req.end();
        });
    }
}
