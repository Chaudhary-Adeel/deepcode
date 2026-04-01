jest.mock('https');

import * as https from 'https';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { AnthropicProvider } from '../providers/anthropic';

function createMockResponse(statusCode: number, body: string): Readable & { statusCode: number } {
    const readable = new Readable({ read() {} }) as Readable & { statusCode: number };
    readable.statusCode = statusCode;
    process.nextTick(() => {
        readable.push(body);
        readable.push(null);
    });
    return readable;
}

function mockHttpsRequest(response: Readable & { statusCode: number }) {
    const req = new EventEmitter() as any;
    req.write = jest.fn();
    req.end = jest.fn();
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();
    (https.request as jest.Mock).mockImplementation((_opts: any, cb: any) => {
        process.nextTick(() => cb(response));
        return req;
    });
    return req;
}

describe('AnthropicProvider', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('metadata', () => {
        it('creates provider with Anthropic config', () => {
            const provider = new AnthropicProvider('test-key');
            expect(provider.getProviderName()).toBe('Anthropic');
            expect(provider.supportsToolCalling()).toBe(true);
        });

        it('returns Anthropic models', () => {
            const provider = new AnthropicProvider('test-key');
            const models = provider.getAvailableModels();
            expect(models.find(m => m.id === 'claude-sonnet-4-20250514')).toBeDefined();
            expect(models.find(m => m.id === 'claude-opus-4-20250514')).toBeDefined();
            expect(models.find(m => m.id === 'claude-haiku-3-5-20241022')).toBeDefined();
        });
    });

    describe('chatCompletion', () => {
        it('maps OpenAI-format messages to Anthropic format and returns result', async () => {
            const responseBody = JSON.stringify({
                id: 'msg_123',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'Hello!' }],
                model: 'claude-sonnet-4-20250514',
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 5 },
            });
            const res = createMockResponse(200, responseBody);
            mockHttpsRequest(res);

            const provider = new AnthropicProvider('test-key');
            const result = await provider.chatCompletion({
                messages: [
                    { role: 'system', content: 'You are helpful.' },
                    { role: 'user', content: 'Hi' },
                ],
                maxTokens: 1024,
            });

            expect(result.content).toBe('Hello!');
            expect(result.usage.promptTokens).toBe(10);
            expect(result.usage.completionTokens).toBe(5);
            expect(result.finishReason).toBe('end_turn');

            // Verify the request was made with correct headers
            expect(https.request).toHaveBeenCalledTimes(1);
            const reqOpts = (https.request as jest.Mock).mock.calls[0][0];
            expect(reqOpts.headers['x-api-key']).toBe('test-key');
            expect(reqOpts.headers['anthropic-version']).toBe('2023-06-01');
            expect(reqOpts.path).toBe('/v1/messages');
        });

        it('maps tool_use content blocks to OpenAI tool_calls format', async () => {
            const responseBody = JSON.stringify({
                id: 'msg_456',
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Let me search.' },
                    {
                        type: 'tool_use',
                        id: 'toolu_123',
                        name: 'search_files',
                        input: { query: 'hello' },
                    },
                ],
                model: 'claude-sonnet-4-20250514',
                stop_reason: 'tool_use',
                usage: { input_tokens: 20, output_tokens: 15 },
            });
            const res = createMockResponse(200, responseBody);
            mockHttpsRequest(res);

            const provider = new AnthropicProvider('test-key');
            const result = await provider.chatCompletion({
                messages: [{ role: 'user', content: 'Search for hello' }],
                tools: [{
                    type: 'function',
                    function: {
                        name: 'search_files',
                        description: 'Search',
                        parameters: { type: 'object', properties: { query: { type: 'string' } } },
                    },
                }],
                maxTokens: 1024,
            });

            expect(result.content).toBe('Let me search.');
            expect(result.toolCalls).toHaveLength(1);
            expect(result.toolCalls![0].id).toBe('toolu_123');
            expect(result.toolCalls![0].function.name).toBe('search_files');
            expect(JSON.parse(result.toolCalls![0].function.arguments)).toEqual({ query: 'hello' });
        });

        it('retries on 429 and 500 errors', async () => {
            const errorRes = createMockResponse(429, 'rate limited');
            const successRes = createMockResponse(200, JSON.stringify({
                id: 'msg_789',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'OK' }],
                model: 'claude-sonnet-4-20250514',
                stop_reason: 'end_turn',
                usage: { input_tokens: 5, output_tokens: 2 },
            }));

            let callCount = 0;
            const req = new EventEmitter() as any;
            req.write = jest.fn();
            req.end = jest.fn();
            req.setTimeout = jest.fn();
            req.destroy = jest.fn();

            (https.request as jest.Mock).mockImplementation((_opts: any, cb: any) => {
                callCount++;
                process.nextTick(() => cb(callCount === 1 ? errorRes : successRes));
                return req;
            });

            const provider = new AnthropicProvider('test-key');
            const result = await provider.chatCompletion({
                messages: [{ role: 'user', content: 'Hi' }],
                maxTokens: 1,
            });

            expect(result.content).toBe('OK');
            expect(callCount).toBe(2);
        });

        it('does not retry on 400 errors', async () => {
            const errorRes = createMockResponse(400, 'bad request');
            mockHttpsRequest(errorRes);

            const provider = new AnthropicProvider('test-key');
            await expect(provider.chatCompletion({
                messages: [{ role: 'user', content: 'Hi' }],
                maxTokens: 1,
            })).rejects.toThrow('Anthropic API error 400');
        });
    });
});
