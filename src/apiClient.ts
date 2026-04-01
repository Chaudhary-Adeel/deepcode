import * as https from 'https';
import * as http from 'http';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ApiClientOptions {
    apiKey: string;
    baseUrl?: string;
    model: string;
    timeout?: number;
    fallbackModel?: string;
}

export type StreamEventType = 'content_delta' | 'tool_call_delta' | 'message_start' | 'message_stop' | 'error';

export interface StreamEvent {
    type: StreamEventType;
    content?: string;
    toolCall?: {
        index: number;
        id?: string;
        name?: string;
        arguments?: string;
    };
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    error?: string;
    finishReason?: string;
}

export interface ChatCompletionOptions {
    messages: Array<{ role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string }>;
    tools?: any[];
    toolChoice?: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    responseFormat?: { type: string };
}

export interface ChatCompletionResult {
    content: string | null;
    toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason: string;
    model: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

interface ParsedEndpoint {
    hostname: string;
    port: number | undefined;
    basePath: string;
}

function parseBaseUrl(raw: string): ParsedEndpoint {
    let url: URL;
    if (/^https?:\/\//i.test(raw)) {
        url = new URL(raw);
    } else {
        url = new URL(`https://${raw}`);
    }
    const hostname = url.hostname;
    const port = url.port ? Number(url.port) : undefined;
    let basePath = url.pathname;
    if (basePath.endsWith('/')) {
        basePath = basePath.slice(0, -1);
    }
    return { hostname, port, basePath };
}

function isRetryable(statusCode: number | undefined): boolean {
    if (statusCode === undefined) { return true; }
    if (statusCode === 429) { return true; }
    if (statusCode >= 500) { return true; }
    return false;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function mapUsage(raw: any): { promptTokens: number; completionTokens: number; totalTokens: number } {
    return {
        promptTokens: raw?.prompt_tokens ?? 0,
        completionTokens: raw?.completion_tokens ?? 0,
        totalTokens: raw?.total_tokens ?? 0,
    };
}

/** Retryable error with a flag the retry loop can inspect. */
function retryableError(message: string): Error {
    const err: any = new Error(message);
    err._retryable = true;
    return err;
}

function nonRetryableError(message: string): Error {
    const err: any = new Error(message);
    err._retryable = false;
    return err;
}

function apiError(statusCode: number, model: string, body: string): Error {
    let errMsg = `API error ${statusCode} from model "${model}"`;
    try {
        const parsed = JSON.parse(body);
        if (parsed.error?.message) {
            errMsg += `: ${parsed.error.message}`;
        }
    } catch { /* use default */ }

    const err: any = new Error(errMsg);
    err._retryable = isRetryable(statusCode);
    return err;
}

// ── Push-based async iterable for true streaming ─────────────────────────────

interface PushChannel<T> {
    push(value: T): void;
    done(): void;
    error(err: Error): void;
    iterable: AsyncIterable<T>;
}

function createPushChannel<T>(): PushChannel<T> {
    const queue: T[] = [];
    let finished = false;
    let rejection: Error | null = null;
    let waiting: { resolve: (v: IteratorResult<T>) => void; reject: (e: Error) => void } | null = null;

    function push(value: T): void {
        if (finished) { return; }
        if (waiting) {
            const w = waiting;
            waiting = null;
            w.resolve({ value, done: false });
        } else {
            queue.push(value);
        }
    }

    function done(): void {
        finished = true;
        if (waiting) {
            const w = waiting;
            waiting = null;
            w.resolve({ value: undefined as any, done: true });
        }
    }

    function error(err: Error): void {
        rejection = err;
        finished = true;
        if (waiting) {
            const w = waiting;
            waiting = null;
            w.reject(err);
        }
    }

    const iterable: AsyncIterable<T> = {
        [Symbol.asyncIterator](): AsyncIterator<T> {
            return {
                next(): Promise<IteratorResult<T>> {
                    if (queue.length > 0) {
                        return Promise.resolve({ value: queue.shift()!, done: false });
                    }
                    if (rejection) {
                        return Promise.reject(rejection);
                    }
                    if (finished) {
                        return Promise.resolve({ value: undefined as any, done: true });
                    }
                    return new Promise<IteratorResult<T>>((resolve, reject) => {
                        waiting = { resolve, reject };
                    });
                },
            };
        },
    };

    return { push, done, error, iterable };
}

// ── ApiClient ────────────────────────────────────────────────────────────────

export class ApiClient {
    private readonly apiKey: string;
    private readonly endpoint: ParsedEndpoint;
    private readonly model: string;
    private readonly fallbackModel: string | undefined;
    private readonly timeout: number;

    constructor(opts: ApiClientOptions) {
        this.apiKey = opts.apiKey;
        this.endpoint = parseBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL);
        this.model = opts.model;
        this.fallbackModel = opts.fallbackModel;
        this.timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    }

    // ── Non-streaming completion ─────────────────────────────────────────

    async chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
        const models = this.fallbackModel ? [this.model, this.fallbackModel] : [this.model];

        for (let mi = 0; mi < models.length; mi++) {
            const currentModel = models[mi];
            const isFallback = mi > 0;

            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                try {
                    return await this.rawRequest(currentModel, opts);
                } catch (err: any) {
                    const retryable = err._retryable === true;
                    const isLastAttempt = attempt === MAX_RETRIES - 1;

                    if (!retryable) { throw err; }

                    if (isLastAttempt) {
                        if (!isFallback && this.fallbackModel) {
                            break; // exhaust retries on primary → try fallback
                        }
                        throw err;
                    }
                    await sleep(RETRY_DELAYS_MS[attempt]);
                }
            }
        }

        throw new Error(`All models exhausted for chat completion`);
    }

    // ── Streaming completion ─────────────────────────────────────────────

    async *streamChatCompletion(opts: ChatCompletionOptions): AsyncGenerator<StreamEvent> {
        const models = this.fallbackModel ? [this.model, this.fallbackModel] : [this.model];

        for (let mi = 0; mi < models.length; mi++) {
            const currentModel = models[mi];
            const isFallback = mi > 0;

            if (isFallback) {
                yield {
                    type: 'error',
                    error: `Falling back from model "${this.model}" to "${this.fallbackModel}" due to errors`,
                };
            }

            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                try {
                    const channel = this.openStreamChannel(currentModel, opts);
                    for await (const event of channel) {
                        yield event;
                    }
                    return; // success
                } catch (err: any) {
                    const retryable = err._retryable === true;
                    const isLastAttempt = attempt === MAX_RETRIES - 1;

                    if (!retryable) {
                        yield { type: 'error', error: err.message ?? String(err) };
                        return;
                    }

                    if (isLastAttempt) {
                        if (!isFallback && this.fallbackModel) {
                            break; // move to fallback model
                        }
                        yield { type: 'error', error: err.message ?? String(err) };
                        return;
                    }
                    await sleep(RETRY_DELAYS_MS[attempt]);
                }
            }
        }
    }

    // ── Raw non-streaming request ────────────────────────────────────────

    private rawRequest(model: string, opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
        return new Promise((resolve, reject) => {
            const bodyObj = this.buildRequestBody(model, opts, false);
            const body = JSON.stringify(bodyObj);
            const reqOpts = this.buildHttpOptions(body);

            const req = https.request(reqOpts, (res: http.IncomingMessage) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    const statusCode = res.statusCode ?? 0;
                    if (statusCode !== 200) {
                        reject(apiError(statusCode, model, data));
                        return;
                    }

                    try {
                        const json = JSON.parse(data);
                        const choice = json.choices?.[0];
                        if (!choice) {
                            reject(nonRetryableError(`No choices in API response from model "${model}"`));
                            return;
                        }

                        const toolCalls = choice.message?.tool_calls;
                        resolve({
                            content: choice.message?.content ?? null,
                            toolCalls: toolCalls?.length ? toolCalls : undefined,
                            usage: mapUsage(json.usage),
                            finishReason: choice.finish_reason ?? 'unknown',
                            model: json.model ?? model,
                        });
                    } catch (e) {
                        reject(nonRetryableError(
                            `Failed to parse API response from model "${model}": ${e}`
                        ));
                    }
                });
                res.on('error', (e: Error) => {
                    reject(retryableError(`Response stream error: ${e.message}`));
                });
            });

            req.on('error', (e: Error) => {
                reject(retryableError(`Network error calling model "${model}": ${e.message}`));
            });

            req.setTimeout(this.timeout, () => {
                req.destroy();
                reject(retryableError(
                    `Request to model "${model}" timed out after ${this.timeout / 1000}s`
                ));
            });

            req.write(body);
            req.end();
        });
    }

    // ── Raw streaming request via push channel ───────────────────────────

    private openStreamChannel(
        model: string,
        opts: ChatCompletionOptions,
    ): AsyncIterable<StreamEvent> {
        const channel = createPushChannel<StreamEvent>();
        const bodyObj = this.buildRequestBody(model, opts, true);
        const body = JSON.stringify(bodyObj);
        const reqOpts = this.buildHttpOptions(body);

        const req = https.request(reqOpts, (res: http.IncomingMessage) => {
            const statusCode = res.statusCode ?? 0;

            if (statusCode !== 200) {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => { channel.error(apiError(statusCode, model, data)); });
                res.on('error', () => {
                    channel.error(apiError(statusCode, model, ''));
                });
                return;
            }

            let buffer = '';
            let emittedStart = false;
            let finishReason: string | undefined;
            let usage: StreamEvent['usage'] | undefined;

            res.on('data', (chunk: Buffer) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ')) { continue; }
                    const payload = trimmed.slice(6);
                    if (payload === '[DONE]') { continue; }

                    try {
                        const json = JSON.parse(payload);

                        if (!emittedStart) {
                            emittedStart = true;
                            channel.push({ type: 'message_start' });
                        }

                        const delta = json.choices?.[0]?.delta;
                        const choiceFinish = json.choices?.[0]?.finish_reason;

                        if (delta?.content) {
                            channel.push({ type: 'content_delta', content: delta.content });
                        }

                        if (delta?.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                channel.push({
                                    type: 'tool_call_delta',
                                    toolCall: {
                                        index: tc.index ?? 0,
                                        id: tc.id || undefined,
                                        name: tc.function?.name || undefined,
                                        arguments: tc.function?.arguments || undefined,
                                    },
                                });
                            }
                        }

                        if (choiceFinish) {
                            finishReason = choiceFinish;
                        }

                        if (json.usage) {
                            usage = mapUsage(json.usage);
                        }
                    } catch { /* skip malformed SSE */ }
                }
            });

            res.on('end', () => {
                channel.push({
                    type: 'message_stop',
                    finishReason: finishReason ?? 'unknown',
                    usage: usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                });
                channel.done();
            });

            res.on('error', (e: Error) => {
                channel.error(retryableError(
                    `Stream error from model "${model}": ${e.message}`
                ));
            });
        });

        req.on('error', (e: Error) => {
            channel.error(retryableError(
                `Network error calling model "${model}": ${e.message}`
            ));
        });

        req.setTimeout(this.timeout, () => {
            req.destroy();
            channel.error(retryableError(
                `Streaming request to model "${model}" timed out after ${this.timeout / 1000}s`
            ));
        });

        req.write(body);
        req.end();

        return channel.iterable;
    }

    // ── Shared helpers ───────────────────────────────────────────────────

    private buildRequestBody(
        model: string,
        opts: ChatCompletionOptions,
        stream: boolean,
    ): Record<string, any> {
        const body: Record<string, any> = {
            model,
            messages: opts.messages,
            stream,
        };

        if (opts.temperature !== undefined) { body.temperature = opts.temperature; }
        if (opts.maxTokens !== undefined) { body.max_tokens = opts.maxTokens; }
        if (opts.topP !== undefined) { body.top_p = opts.topP; }
        if (opts.responseFormat) { body.response_format = opts.responseFormat; }

        if (opts.tools && opts.tools.length > 0) {
            body.tools = opts.tools;
            body.tool_choice = opts.toolChoice ?? 'auto';
        }

        if (stream) {
            body.stream_options = { include_usage: true };
        }

        return body;
    }

    private buildHttpOptions(body: string): https.RequestOptions {
        return {
            hostname: this.endpoint.hostname,
            port: this.endpoint.port ?? 443,
            path: `${this.endpoint.basePath}/chat/completions`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Length': Buffer.byteLength(body),
            },
        };
    }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createApiClient(opts: ApiClientOptions): ApiClient {
    return new ApiClient(opts);
}
