import * as vscode from 'vscode';
import * as https from 'https';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface DeepSeekConfig {
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    topP: number;
    frequencyPenalty: number;
    presencePenalty: number;
    stream: boolean;
    systemPrompt: string;
}

export interface UsageInfo {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface ChatResponse {
    content: string;
    usage?: UsageInfo;
    finishReason?: string;
}

const DEEPSEEK_API_BASE = 'api.deepseek.com';

const SYSTEM_PROMPT = `You are DeepCode — an elite AI software architect and programming assistant embedded in VS Code. You operate with surgical precision across any codebase, language, or framework.

## Core Identity
- You think like a senior staff engineer with decades of experience across systems programming, web development, distributed systems, compilers, databases, and DevOps.
- You don't just edit code — you understand the architecture, intent, and consequences of every change.
- You treat every file as part of a living system. Before changing anything, you reason about ripple effects, dependencies, and side effects.

## How You Operate

### Reading & Understanding
- When given code, silently analyze its structure, patterns, design decisions, language idioms, naming conventions, and style before responding.
- Infer the broader architecture even from a single file — framework used, project structure, state management patterns, error handling philosophy.
- Identify code smells, anti-patterns, latent bugs, and performance pitfalls without being asked.

### Editing & Refactoring
- Produce precise, minimal, surgical diffs — never rewrite what doesn't need rewriting.
- Preserve the original author's style, conventions, and formatting unless explicitly asked to change them.
- When refactoring, always maintain backward compatibility unless told otherwise.
- For complex edits, break changes into logical atomic steps and explain the reasoning behind each.
- If a requested change would introduce a bug, break a dependency, or degrade performance — say so before making it, and propose a safer alternative.

### Creating & Generating
- When generating new code, match the existing project's patterns, imports style, error handling approach, and naming conventions.
- Always produce production-grade code: proper error handling, edge case coverage, type safety, input validation, and meaningful naming.
- Include concise, useful comments only where logic is non-obvious — never comment the self-evident.

### Debugging & Problem Solving
- When presented with a bug or error, reason through it step by step: reproduce mentally → isolate root cause → propose targeted fix → verify no regressions.
- Distinguish between symptoms and root causes. Fix the disease, not the symptom.
- When multiple solutions exist, briefly present the tradeoffs and recommend the best one.

## Communication Style
- Lead with the answer. Explain the "what" first, then the "why."
- Be direct and concise. No filler, no preamble, no unnecessary pleasantries.
- Use precise technical language. Name the patterns, algorithms, and principles you're applying.
- When explaining changes, format them as clear before/after or step-by-step transformations.
- If something is ambiguous in the user's request, state your assumption and proceed — don't stall with questions unless truly critical information is missing.

## Advanced Behaviors
- Proactively flag security vulnerabilities (injection, XSS, auth issues, secrets exposure, race conditions).
- Suggest performance optimizations when you spot O(n²) where O(n) is possible, unnecessary re-renders, memory leaks, or redundant computations.
- When touching APIs or interfaces, consider versioning, backward compatibility, and contract stability.
- Understand and work fluently with: monorepos, microservices, event-driven architectures, ORMs, build systems, CI/CD pipelines, containerization, and testing frameworks.
- When the user's approach is fundamentally flawed, respectfully redirect toward the right solution rather than polishing the wrong one.

## Rules
- Never hallucinate APIs, functions, or library methods. If unsure whether something exists, say so.
- Never silently swallow errors or add empty catch blocks.
- Never suggest deprecated methods or insecure practices.
- If a task is too large or risky for a single edit, propose a phased plan and confirm before executing.`;

export class DeepSeekService {
    private conversationHistory: ChatMessage[] = [];

    constructor() {}

    getConfig(): DeepSeekConfig {
        const config = vscode.workspace.getConfiguration('deepcode');
        return {
            apiKey: '',
            model: config.get<string>('model', 'deepseek-chat'),
            temperature: config.get<number>('temperature', 0),
            maxTokens: config.get<number>('maxTokens', 8192),
            topP: config.get<number>('topP', 0.95),
            frequencyPenalty: config.get<number>('frequencyPenalty', 0),
            presencePenalty: config.get<number>('presencePenalty', 0),
            stream: config.get<boolean>('streamResponses', true),
            systemPrompt: SYSTEM_PROMPT,
        };
    }

    async getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
        return context.secrets.get('deepcode.apiKey');
    }

    async setApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
        await context.secrets.store('deepcode.apiKey', key);
    }

    async clearApiKey(context: vscode.ExtensionContext): Promise<void> {
        await context.secrets.delete('deepcode.apiKey');
    }

    clearHistory(): void {
        this.conversationHistory = [];
    }

    getHistory(): ChatMessage[] {
        return [...this.conversationHistory];
    }

    async chat(
        apiKey: string,
        userMessage: string,
        onToken?: (token: string) => void,
        additionalContext?: string
    ): Promise<ChatResponse> {
        const cfg = this.getConfig();

        // Build messages
        const messages: ChatMessage[] = [
            { role: 'system', content: cfg.systemPrompt },
            ...this.conversationHistory,
        ];

        // If there's additional context (e.g., file contents), prepend to user message
        const fullUserMessage = additionalContext
            ? `${additionalContext}\n\n${userMessage}`
            : userMessage;

        messages.push({ role: 'user', content: fullUserMessage });

        const shouldStream = cfg.stream && onToken !== undefined;

        const requestBody = JSON.stringify({
            model: cfg.model,
            messages,
            temperature: cfg.temperature,
            max_tokens: cfg.maxTokens,
            top_p: cfg.topP,
            frequency_penalty: cfg.frequencyPenalty,
            presence_penalty: cfg.presencePenalty,
            stream: shouldStream,
        });

        let result: ChatResponse;

        if (shouldStream) {
            result = await this.streamRequest(apiKey, requestBody, onToken!);
        } else {
            result = await this.standardRequest(apiKey, requestBody);
        }

        // Store in conversation history
        this.conversationHistory.push({ role: 'user', content: fullUserMessage });
        this.conversationHistory.push({ role: 'assistant', content: result.content });

        // Trim history if it gets too long (keep last 20 exchanges)
        if (this.conversationHistory.length > 40) {
            this.conversationHistory = this.conversationHistory.slice(-40);
        }

        return result;
    }

    async chatForEdit(
        apiKey: string,
        fileContent: string,
        fileName: string,
        instruction: string,
        selectedText?: string
    ): Promise<ChatResponse> {
        const cfg = this.getConfig();

        const editSystemPrompt = `You are DeepCode, an expert code editing assistant. You will be given a file and an edit instruction.

CRITICAL: Your response MUST be a single valid JSON object and NOTHING else. No markdown, no code fences, no explanation outside the JSON, no plain text, no shell commands. Output ONLY raw JSON.

Required JSON format:
{
  "edits": [
    {
      "oldText": "exact text to find and replace",
      "newText": "replacement text"
    }
  ],
  "explanation": "Brief explanation of what was changed and why"
}

Rules:
- Your entire response must be parseable by JSON.parse() with no preprocessing
- oldText must be an EXACT substring of the original file (character-for-character match)
- Each edit should be minimal and precise
- Multiple edits are allowed for complex changes
- Keep the explanation concise
- Do NOT wrap the JSON in markdown code blocks or backticks
- Do NOT include any text before or after the JSON object`;

        let userMsg = `File: ${fileName}\n\n`;
        if (selectedText) {
            userMsg += `Selected code:\n\`\`\`\n${selectedText}\n\`\`\`\n\n`;
        }
        userMsg += `Full file content:\n\`\`\`\n${fileContent}\n\`\`\`\n\n`;
        userMsg += `Instruction: ${instruction}`;

        const messages: ChatMessage[] = [
            { role: 'system', content: editSystemPrompt },
            { role: 'user', content: userMsg },
        ];

        const requestBody = JSON.stringify({
            model: cfg.model,
            messages,
            temperature: Math.min(cfg.temperature, 0.2), // Lower temperature for edits
            max_tokens: cfg.maxTokens,
            top_p: cfg.topP,
            frequency_penalty: cfg.frequencyPenalty,
            presence_penalty: cfg.presencePenalty,
            response_format: { type: 'json_object' },
            stream: false,
        });

        return this.standardRequest(apiKey, requestBody);
    }

    private standardRequest(apiKey: string, body: string): Promise<ChatResponse> {
        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: DEEPSEEK_API_BASE,
                port: 443,
                path: '/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        if (res.statusCode !== 200) {
                            const error = JSON.parse(data);
                            reject(new Error(error.error?.message || `API error: ${res.statusCode}`));
                            return;
                        }
                        const json = JSON.parse(data);
                        const choice = json.choices?.[0];
                        resolve({
                            content: choice?.message?.content || '',
                            usage: json.usage,
                            finishReason: choice?.finish_reason,
                        });
                    } catch (e) {
                        reject(new Error(`Failed to parse response: ${e}`));
                    }
                });
            });

            req.on('error', (e) => reject(new Error(`Request failed: ${e.message}`)));
            req.write(body);
            req.end();
        });
    }

    private streamRequest(apiKey: string, body: string, onToken: (token: string) => void): Promise<ChatResponse> {
        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: DEEPSEEK_API_BASE,
                port: 443,
                path: '/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(options, (res) => {
                if (res.statusCode !== 200) {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        try {
                            const error = JSON.parse(data);
                            reject(new Error(error.error?.message || `API error: ${res.statusCode}`));
                        } catch {
                            reject(new Error(`API error: ${res.statusCode}`));
                        }
                    });
                    return;
                }

                let fullContent = '';
                let buffer = '';
                let usage: UsageInfo | undefined;

                res.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
                        const data = trimmed.slice(6);
                        if (data === '[DONE]') { continue; }

                        try {
                            const json = JSON.parse(data);
                            const delta = json.choices?.[0]?.delta;
                            if (delta?.content) {
                                fullContent += delta.content;
                                onToken(delta.content);
                            }
                            if (json.usage) {
                                usage = json.usage;
                            }
                        } catch {
                            // Skip malformed chunks
                        }
                    }
                });

                res.on('end', () => {
                    resolve({
                        content: fullContent,
                        usage,
                        finishReason: 'stop',
                    });
                });
            });

            req.on('error', (e) => reject(new Error(`Request failed: ${e.message}`)));
            req.write(body);
            req.end();
        });
    }

    /**
     * Check API key validity by making a lightweight request
     */
    async validateApiKey(apiKey: string): Promise<boolean> {
        try {
            const body = JSON.stringify({
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 5,
            });
            await this.standardRequest(apiKey, body);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get account balance info
     */
    async getBalance(apiKey: string): Promise<{ available: string; used: string } | null> {
        return new Promise((resolve) => {
            const options: https.RequestOptions = {
                hostname: DEEPSEEK_API_BASE,
                port: 443,
                path: '/user/balance',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.balance_infos && json.balance_infos.length > 0) {
                            const info = json.balance_infos[0];
                            resolve({
                                available: info.total_balance || '0',
                                used: info.granted_balance || '0',
                            });
                        } else {
                            resolve(null);
                        }
                    } catch {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.end();
        });
    }
}
