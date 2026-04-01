import { EventEmitter } from 'events';
import { ApiClient, createApiClient } from '../apiClient';
import type { ChatCompletionOptions } from '../apiClient';

// ── Mock https ───────────────────────────────────────────────────────────────

const mockRequest = jest.fn();
jest.mock('https', () => ({
    request: (...args: any[]) => mockRequest(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

interface MockReq extends EventEmitter {
    write: jest.Mock;
    end: jest.Mock;
    setTimeout: jest.Mock;
    destroy: jest.Mock;
}

function createMockReq(): MockReq {
    const req = new EventEmitter() as MockReq;
    req.write = jest.fn();
    req.end = jest.fn();
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();
    return req;
}

/**
 * Configure mockRequest to return a sequence of controlled HTTP responses.
 * Callback and data emission are scheduled via process.nextTick to mimic
 * real Node.js HTTP behaviour (listeners are attached before data arrives).
 */
function setupMockRequest(
    responses: Array<{ statusCode: number; body: string | string[] }>,
) {
    let callIndex = 0;
    mockRequest.mockImplementation((_opts: any, callback: (res: any) => void) => {
        const req = createMockReq();
        const resp = responses[callIndex++];
        if (resp) {
            const res = new EventEmitter() as EventEmitter & { statusCode: number };
            (res as any).statusCode = resp.statusCode;
            // Deliver callback first so listeners are registered…
            process.nextTick(() => {
                callback(res);
                // …then emit data + end on the next tick.
                process.nextTick(() => {
                    if (Array.isArray(resp.body)) {
                        for (const line of resp.body) {
                            res.emit('data', Buffer.from(line + '\n'));
                        }
                    } else {
                        res.emit('data', Buffer.from(resp.body));
                    }
                    res.emit('end');
                });
            });
        }
        return req;
    });
}

const defaultOpts: ChatCompletionOptions = {
    messages: [{ role: 'user', content: 'Hello' }],
};

function makeJsonResponse(overrides: Record<string, any> = {}): string {
    return JSON.stringify({
        choices: [
            {
                message: { content: 'Hello world' },
                finish_reason: 'stop',
            },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        model: 'deepseek-chat',
        ...overrides,
    });
}

function makeErrorBody(message: string): string {
    return JSON.stringify({ error: { message } });
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('ApiClient', () => {
    let client: ApiClient;

    beforeEach(() => {
        mockRequest.mockReset();

        // Make sleep() resolve immediately so retry tests don't stall.
        jest.spyOn(global, 'setTimeout').mockImplementation(((fn: Function) => {
            fn();
            return 0 as unknown as NodeJS.Timeout;
        }) as any);

        client = createApiClient({
            apiKey: 'test-key',
            model: 'deepseek-chat',
            baseUrl: 'api.deepseek.com',
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ── chatCompletion (non-streaming) ───────────────────────────────────

    describe('chatCompletion', () => {
        it('returns parsed response on 200', async () => {
            setupMockRequest([{ statusCode: 200, body: makeJsonResponse() }]);

            const result = await client.chatCompletion(defaultOpts);

            expect(result.content).toBe('Hello world');
            expect(result.usage).toEqual({
                promptTokens: 10,
                completionTokens: 20,
                totalTokens: 30,
            });
            expect(result.finishReason).toBe('stop');
            expect(result.model).toBe('deepseek-chat');
            expect(result.toolCalls).toBeUndefined();
        });

        it('returns tool calls when present', async () => {
            const body = JSON.stringify({
                choices: [
                    {
                        message: {
                            content: null,
                            tool_calls: [
                                {
                                    id: 'call_1',
                                    type: 'function',
                                    function: {
                                        name: 'get_weather',
                                        arguments: '{"city":"NYC"}',
                                    },
                                },
                            ],
                        },
                        finish_reason: 'tool_calls',
                    },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                model: 'deepseek-chat',
            });

            setupMockRequest([{ statusCode: 200, body }]);

            const result = await client.chatCompletion(defaultOpts);

            expect(result.content).toBeNull();
            expect(result.toolCalls).toHaveLength(1);
            expect(result.toolCalls![0]).toEqual({
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            });
            expect(result.finishReason).toBe('tool_calls');
        });

        it('retries on 500 and succeeds on second attempt', async () => {
            setupMockRequest([
                { statusCode: 500, body: makeErrorBody('Internal Server Error') },
                { statusCode: 200, body: makeJsonResponse() },
            ]);

            const result = await client.chatCompletion(defaultOpts);

            expect(result.content).toBe('Hello world');
            expect(mockRequest).toHaveBeenCalledTimes(2);
        });

        it('retries on 429 and succeeds on second attempt', async () => {
            setupMockRequest([
                { statusCode: 429, body: makeErrorBody('Rate limited') },
                { statusCode: 200, body: makeJsonResponse() },
            ]);

            const result = await client.chatCompletion(defaultOpts);

            expect(result.content).toBe('Hello world');
            expect(mockRequest).toHaveBeenCalledTimes(2);
        });

        it('does NOT retry on 400 (non-retryable)', async () => {
            setupMockRequest([
                { statusCode: 400, body: makeErrorBody('Bad request') },
            ]);

            await expect(client.chatCompletion(defaultOpts)).rejects.toThrow(
                /API error 400/,
            );
            expect(mockRequest).toHaveBeenCalledTimes(1);
        });

        it('falls back to secondary model after primary exhausts retries', async () => {
            const clientWithFallback = createApiClient({
                apiKey: 'test-key',
                model: 'deepseek-chat',
                fallbackModel: 'deepseek-coder',
                baseUrl: 'api.deepseek.com',
            });

            const fallbackBody = JSON.stringify({
                choices: [
                    {
                        message: { content: 'Fallback response' },
                        finish_reason: 'stop',
                    },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                model: 'deepseek-coder',
            });

            setupMockRequest([
                { statusCode: 500, body: makeErrorBody('err') },
                { statusCode: 500, body: makeErrorBody('err') },
                { statusCode: 500, body: makeErrorBody('err') },
                { statusCode: 200, body: fallbackBody },
            ]);

            const result = await clientWithFallback.chatCompletion(defaultOpts);

            expect(result.content).toBe('Fallback response');
            expect(result.model).toBe('deepseek-coder');
            // 3 retries on primary + 1 on fallback = 4 total requests
            expect(mockRequest).toHaveBeenCalledTimes(4);
        });
    });

    // ── streamChatCompletion ─────────────────────────────────────────────

    describe('streamChatCompletion', () => {
        it('yields content deltas', async () => {
            const sseLines = [
                'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}',
                'data: {"choices":[{"delta":{"content":" world"},"index":0}]}',
                'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}',
                'data: [DONE]',
            ];

            setupMockRequest([{ statusCode: 200, body: sseLines }]);

            const events: any[] = [];
            for await (const event of client.streamChatCompletion(defaultOpts)) {
                events.push(event);
            }

            expect(events[0]).toEqual({ type: 'message_start' });
            expect(events[1]).toEqual({ type: 'content_delta', content: 'Hello' });
            expect(events[2]).toEqual({ type: 'content_delta', content: ' world' });

            const stopEvent = events.find((e) => e.type === 'message_stop');
            expect(stopEvent).toBeDefined();
            expect(stopEvent.finishReason).toBe('stop');
        });

        it('yields tool call deltas', async () => {
            const sseLines = [
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{"}}]},"index":0}]}',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"city\\":"}}]},"index":0}]}',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"NYC\\"}"}}]},"index":0}]}',
                'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":10,"total_tokens":15}}',
                'data: [DONE]',
            ];

            setupMockRequest([{ statusCode: 200, body: sseLines }]);

            const events: any[] = [];
            for await (const event of client.streamChatCompletion(defaultOpts)) {
                events.push(event);
            }

            const toolCallEvents = events.filter((e) => e.type === 'tool_call_delta');
            expect(toolCallEvents.length).toBe(3);
            expect(toolCallEvents[0].toolCall.index).toBe(0);
            expect(toolCallEvents[0].toolCall.id).toBe('call_1');
            expect(toolCallEvents[0].toolCall.name).toBe('get_weather');
        });

        it('yields message_stop with usage info', async () => {
            const sseLines = [
                'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}',
                'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":10,"total_tokens":15}}',
                'data: [DONE]',
            ];

            setupMockRequest([{ statusCode: 200, body: sseLines }]);

            const events: any[] = [];
            for await (const event of client.streamChatCompletion(defaultOpts)) {
                events.push(event);
            }

            const stopEvent = events.find((e) => e.type === 'message_stop');
            expect(stopEvent).toBeDefined();
            expect(stopEvent.usage).toEqual({
                promptTokens: 5,
                completionTokens: 10,
                totalTokens: 15,
            });
            expect(stopEvent.finishReason).toBe('stop');
        });

        it('emits fallback error event when primary model fails', async () => {
            const clientWithFallback = createApiClient({
                apiKey: 'test-key',
                model: 'deepseek-chat',
                fallbackModel: 'deepseek-coder',
                baseUrl: 'api.deepseek.com',
            });

            const sseLines = [
                'data: {"choices":[{"delta":{"content":"Fallback!"},"index":0}]}',
                'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}',
                'data: [DONE]',
            ];

            setupMockRequest([
                { statusCode: 500, body: makeErrorBody('err') },
                { statusCode: 500, body: makeErrorBody('err') },
                { statusCode: 500, body: makeErrorBody('err') },
                { statusCode: 200, body: sseLines },
            ]);

            const events: any[] = [];
            for await (const event of clientWithFallback.streamChatCompletion(defaultOpts)) {
                events.push(event);
            }

            // Should have an error event about the fallback
            const errorEvent = events.find((e) => e.type === 'error');
            expect(errorEvent).toBeDefined();
            expect(errorEvent.error).toContain('Falling back');
            expect(errorEvent.error).toContain('deepseek-chat');
            expect(errorEvent.error).toContain('deepseek-coder');

            // Should still deliver content from the fallback model
            const contentEvent = events.find((e) => e.type === 'content_delta');
            expect(contentEvent).toBeDefined();
            expect(contentEvent.content).toBe('Fallback!');
        });
    });
});
