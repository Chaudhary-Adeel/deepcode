/**
 * OpenAI-compatible provider — thin wrapper around the existing ApiClient.
 * Used by DeepSeek, OpenAI, and llama.cpp (all speak OpenAI format).
 */

import { ApiClient, createApiClient, ChatCompletionOptions, ChatCompletionResult, StreamEvent } from '../apiClient';
import { LLMProvider, ModelInfo, ProviderConfig } from './types';

export class OpenAICompatibleProvider implements LLMProvider {
    protected client: ApiClient;
    protected config: ProviderConfig;

    constructor(apiKey: string, config: ProviderConfig, endpoint?: string, fallbackModel?: string) {
        this.config = config;
        this.client = createApiClient({
            apiKey,
            baseUrl: endpoint || config.defaultEndpoint,
            model: config.defaultModel,
            fallbackModel,
        });
    }

    async chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
        return this.client.chatCompletion(opts);
    }

    async *streamChatCompletion(opts: ChatCompletionOptions): AsyncGenerator<StreamEvent> {
        yield* this.client.streamChatCompletion(opts);
    }

    getProviderName(): string {
        return this.config.name;
    }

    getAvailableModels(): ModelInfo[] {
        return this.config.models;
    }

    supportsToolCalling(): boolean {
        return this.config.models.some(m => m.supportsToolCalling);
    }

    async validateConnection(): Promise<boolean> {
        try {
            await this.client.chatCompletion({
                messages: [{ role: 'user', content: 'Hi' }],
                maxTokens: 1,
            });
            return true;
        } catch {
            return false;
        }
    }
}
