/**
 * Provider type definitions for multi-model support.
 *
 * All providers implement LLMProvider, returning the same
 * ChatCompletionResult / StreamEvent types from apiClient.ts
 * so that callers (AgentLoop, QueryEngine) need zero changes.
 */

import { ChatCompletionOptions, ChatCompletionResult, StreamEvent } from '../apiClient';

// Re-export so consumers can import everything from providers/
export { ChatCompletionOptions, ChatCompletionResult, StreamEvent };

export interface LLMProvider {
    chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult>;
    streamChatCompletion(opts: ChatCompletionOptions): AsyncGenerator<StreamEvent>;
    getProviderName(): string;
    getAvailableModels(): ModelInfo[];
    supportsToolCalling(): boolean;
    validateConnection(): Promise<boolean>;
}

export interface ModelInfo {
    id: string;
    name: string;
    contextWindow: number;
    supportsToolCalling: boolean;
    supportsStreaming: boolean;
    supportsReasoning?: boolean;
    pricing: {
        inputPerMillion: number;
        outputPerMillion: number;
    };
}

export interface ProviderConfig {
    id: ProviderID;
    name: string;
    requiresApiKey: boolean;
    defaultEndpoint: string;
    defaultModel: string;
    models: ModelInfo[];
}

export type ProviderID = 'deepseek' | 'openai' | 'anthropic' | 'llamacpp';
