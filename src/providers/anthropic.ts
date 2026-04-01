/**
 * Anthropic provider — standalone implementation for the Messages API.
 *
 * Maps between OpenAI-format types (ChatCompletionOptions, ChatCompletionResult,
 * StreamEvent) and Anthropic's native format so callers see no difference.
 */

import * as https from 'https';
import { ChatCompletionOptions, ChatCompletionResult, StreamEvent } from '../apiClient';
import { LLMProvider, ModelInfo } from './types';
import { ANTHROPIC_CONFIG } from './configs';

const ANTHROPIC_VERSION = '2023-06-01';
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const DEFAULT_TIMEOUT_MS = 90_000;

// ── Anthropic-specific types ────────────────────────────────────────────────

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
    type: 'text' | 'tool_use' | 'tool_result';
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, any>;
    tool_use_id?: string;
    content?: string;
}

interface AnthropicTool {
    name: string;
    description: string;
    input_schema: Record<string, any>;
}

interface AnthropicResponse {
    id: string;
    type: string;
    role: string;
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: string;
    usage: { input_tokens: number; output_tokens: number };
}

// ── Provider ────────────────────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
    private readonly apiKey: string;
    private readonly endpoint: string;
    private readonly timeout: number;

    constructor(apiKey: string, endpoint?: string, timeout?: number) {
        this.apiKey = apiKey;
        this.endpoint = endpoint || ANTHROPIC_CONFIG.defaultEndpoint;
        this.timeout = timeout ?? DEFAULT_TIMEOUT_MS;
    }

    getProviderName(): string {
        return ANTHROPIC_CONFIG.name;
    }

    getAvailableModels(): ModelInfo[] {
        return ANTHROPIC_CONFIG.models;
    }

    supportsToolCalling(): boolean {
        return true;
    }

    async validateConnection(): Promise<boolean> {
        try {
            await this.chatCompletion({
                messages: [{ role: 'user', content: 'Hi' }],
                maxTokens: 1,
            });
            return true;
        } catch {
            return false;
        }
    }

    async chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
        const { system, messages } = this.convertMessages(opts.messages);
        const body = this.buildRequestBody(system, messages, opts, false);

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const raw = await this.rawRequest(body);
                return this.mapResponse(raw);
            } catch (err: any) {
                if (attempt < MAX_RETRIES && err._retryable) {
                    await sleep(RETRY_DELAYS_MS[attempt]);
                    continue;
                }
                throw err;
            }
        }
        throw new Error('Anthropic: max retries exceeded');
    }

    async *streamChatCompletion(opts: ChatCompletionOptions): AsyncGenerator<StreamEvent> {
        const { system, messages } = this.convertMessages(opts.messages);
        const body = this.buildRequestBody(system, messages, opts, true);

        yield { type: 'message_start' };

        let inputTokens = 0;
        let outputTokens = 0;
        const toolCalls = new Map<number, { id: string; name: string; args: string }>();
        let toolIndex = -1;
        let finishReason: string | undefined;

        for await (const line of this.openStreamLines(body)) {
            if (line.startsWith('event: ')) { continue; }
            if (!line.startsWith('data: ')) { continue; }

            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') { continue; }

            let parsed: any;
            try { parsed = JSON.parse(data); } catch { continue; }

            if (parsed.type === 'message_start' && parsed.message?.usage) {
                inputTokens = parsed.message.usage.input_tokens ?? 0;
            }

            if (parsed.type === 'content_block_start') {
                if (parsed.content_block?.type === 'tool_use') {
                    toolIndex++;
                    toolCalls.set(toolIndex, {
                        id: parsed.content_block.id,
                        name: parsed.content_block.name,
                        args: '',
                    });
                    yield {
                        type: 'tool_call_delta',
                        toolCall: { index: toolIndex, id: parsed.content_block.id, name: parsed.content_block.name },
                    };
                }
            }

            if (parsed.type === 'content_block_delta') {
                if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
                    yield { type: 'content_delta', content: parsed.delta.text };
                }
                if (parsed.delta?.type === 'input_json_delta' && parsed.delta.partial_json) {
                    const tc = toolCalls.get(toolIndex);
                    if (tc) {
                        tc.args += parsed.delta.partial_json;
                        yield {
                            type: 'tool_call_delta',
                            toolCall: { index: toolIndex, arguments: parsed.delta.partial_json },
                        };
                    }
                }
            }

            if (parsed.type === 'message_delta') {
                if (parsed.usage?.output_tokens) {
                    outputTokens = parsed.usage.output_tokens;
                }
                finishReason = parsed.delta?.stop_reason ?? undefined;
            }
        }

        yield {
            type: 'message_stop',
            usage: {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens,
            },
            finishReason,
        };
    }

    // ── Message format conversion ───────────────────────────────────────────

    private convertMessages(messages: ChatCompletionOptions['messages']): {
        system: string | undefined;
        messages: AnthropicMessage[];
    } {
        let system: string | undefined;
        const converted: AnthropicMessage[] = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                system = msg.content ?? undefined;
                continue;
            }

            if (msg.role === 'tool') {
                const block: AnthropicContentBlock = {
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id,
                    content: msg.content ?? '',
                };
                const lastMsg = converted[converted.length - 1];
                if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
                    (lastMsg.content as AnthropicContentBlock[]).push(block);
                } else {
                    converted.push({ role: 'user', content: [block] });
                }
                continue;
            }

            if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                const blocks: AnthropicContentBlock[] = [];
                if (msg.content) {
                    blocks.push({ type: 'text', text: msg.content });
                }
                for (const tc of msg.tool_calls) {
                    let input: Record<string, any> = {};
                    try { input = JSON.parse(tc.function.arguments); } catch { /* use empty */ }
                    blocks.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.function.name,
                        input,
                    });
                }
                converted.push({ role: 'assistant', content: blocks });
                continue;
            }

            converted.push({
                role: msg.role as 'user' | 'assistant',
                content: msg.content ?? '',
            });
        }

        return { system, messages: converted };
    }

    private convertTools(tools: any[]): AnthropicTool[] {
        return tools.map(t => ({
            name: t.function.name,
            description: t.function.description || '',
            input_schema: t.function.parameters || { type: 'object', properties: {} },
        }));
    }

    // ── Request building ────────────────────────────────────────────────────

    private buildRequestBody(
        system: string | undefined,
        messages: AnthropicMessage[],
        opts: ChatCompletionOptions,
        stream: boolean,
    ): string {
        const body: Record<string, any> = {
            model: ANTHROPIC_CONFIG.defaultModel,
            messages,
            max_tokens: opts.maxTokens || 8192,
            stream,
        };

        if (system) { body.system = system; }
        if (opts.temperature !== undefined) { body.temperature = opts.temperature; }
        if (opts.topP !== undefined) { body.top_p = opts.topP; }
        if (opts.tools && opts.tools.length > 0) {
            body.tools = this.convertTools(opts.tools);
        }

        return JSON.stringify(body);
    }

    // ── HTTP ────────────────────────────────────────────────────────────────

    private rawRequest(body: string): Promise<AnthropicResponse> {
        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: this.endpoint,
                port: 443,
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(data));
                        } catch {
                            reject(nonRetryableError('Anthropic: invalid JSON response'));
                        }
                    } else {
                        reject(apiError(res.statusCode, data));
                    }
                });
            });

            req.setTimeout(this.timeout, () => {
                req.destroy();
                reject(retryableError(`Anthropic: request timed out after ${this.timeout / 1000}s`));
            });

            req.on('error', (e) => { reject(retryableError(`Anthropic: network error: ${e.message}`)); });
            req.write(body);
            req.end();
        });
    }

    private async *openStreamLines(body: string): AsyncGenerator<string> {
        const lines = await new Promise<string[]>((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: this.endpoint,
                port: 443,
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const allLines: string[] = [];
            let buffer = '';

            const req = https.request(options, (res) => {
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                    let errData = '';
                    res.on('data', (c) => { errData += c; });
                    res.on('end', () => reject(apiError(res.statusCode, errData)));
                    return;
                }
                res.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString();
                    const parts = buffer.split('\n');
                    buffer = parts.pop() || '';
                    for (const line of parts) {
                        if (line.trim()) { allLines.push(line); }
                    }
                });
                res.on('end', () => {
                    if (buffer.trim()) { allLines.push(buffer.trim()); }
                    resolve(allLines);
                });
            });

            req.setTimeout(this.timeout, () => {
                req.destroy();
                reject(retryableError('Anthropic: stream timed out'));
            });

            req.on('error', (e) => reject(retryableError(`Anthropic: stream error: ${e.message}`)));
            req.write(body);
            req.end();
        });

        for (const line of lines) {
            yield line;
        }
    }

    // ── Response mapping ────────────────────────────────────────────────────

    private mapResponse(raw: AnthropicResponse): ChatCompletionResult {
        let content: string | null = null;
        const toolCalls: ChatCompletionResult['toolCalls'] = [];

        for (const block of raw.content) {
            if (block.type === 'text' && block.text) {
                content = (content ?? '') + block.text;
            }
            if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id!,
                    type: 'function',
                    function: {
                        name: block.name!,
                        arguments: JSON.stringify(block.input),
                    },
                });
            }
        }

        return {
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage: {
                promptTokens: raw.usage.input_tokens,
                completionTokens: raw.usage.output_tokens,
                totalTokens: raw.usage.input_tokens + raw.usage.output_tokens,
            },
            finishReason: raw.stop_reason,
            model: raw.model,
        };
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function retryableError(message: string): Error & { _retryable: boolean } {
    const err = new Error(message) as Error & { _retryable: boolean };
    err._retryable = true;
    return err;
}

function nonRetryableError(message: string): Error & { _retryable: boolean } {
    const err = new Error(message) as Error & { _retryable: boolean };
    err._retryable = false;
    return err;
}

function apiError(statusCode: number | undefined, body: string): Error & { _retryable: boolean } {
    const retryable = statusCode === undefined || statusCode === 429 || (statusCode !== undefined && statusCode >= 500);
    const err = new Error(`Anthropic API error ${statusCode}: ${body.substring(0, 200)}`) as Error & { _retryable: boolean };
    err._retryable = retryable;
    return err;
}
