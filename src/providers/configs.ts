/**
 * Static provider configurations: endpoints, model lists, pricing.
 */

import { ProviderConfig } from './types';

export const DEEPSEEK_CONFIG: ProviderConfig = {
    id: 'deepseek',
    name: 'DeepSeek',
    requiresApiKey: true,
    defaultEndpoint: 'api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: [
        {
            id: 'deepseek-chat',
            name: 'DeepSeek V3 (Fast)',
            contextWindow: 131072,
            supportsToolCalling: true,
            supportsStreaming: true,
            pricing: { inputPerMillion: 0.14, outputPerMillion: 0.28 },
        },
        {
            id: 'deepseek-reasoner',
            name: 'DeepSeek V3 (Thinking)',
            contextWindow: 131072,
            supportsToolCalling: true,
            supportsStreaming: true,
            supportsReasoning: true,
            pricing: { inputPerMillion: 0.55, outputPerMillion: 2.19 },
        },
    ],
};

export const OPENAI_CONFIG: ProviderConfig = {
    id: 'openai',
    name: 'OpenAI',
    requiresApiKey: true,
    defaultEndpoint: 'api.openai.com',
    defaultModel: 'gpt-4o',
    models: [
        {
            id: 'gpt-4o',
            name: 'GPT-4o',
            contextWindow: 128000,
            supportsToolCalling: true,
            supportsStreaming: true,
            pricing: { inputPerMillion: 2.50, outputPerMillion: 10.00 },
        },
        {
            id: 'gpt-4o-mini',
            name: 'GPT-4o Mini',
            contextWindow: 128000,
            supportsToolCalling: true,
            supportsStreaming: true,
            pricing: { inputPerMillion: 0.15, outputPerMillion: 0.60 },
        },
        {
            id: 'gpt-4.1',
            name: 'GPT-4.1',
            contextWindow: 1047576,
            supportsToolCalling: true,
            supportsStreaming: true,
            pricing: { inputPerMillion: 2.00, outputPerMillion: 8.00 },
        },
        {
            id: 'gpt-4.1-mini',
            name: 'GPT-4.1 Mini',
            contextWindow: 1047576,
            supportsToolCalling: true,
            supportsStreaming: true,
            pricing: { inputPerMillion: 0.40, outputPerMillion: 1.60 },
        },
        {
            id: 'gpt-4.1-nano',
            name: 'GPT-4.1 Nano',
            contextWindow: 1047576,
            supportsToolCalling: true,
            supportsStreaming: true,
            pricing: { inputPerMillion: 0.10, outputPerMillion: 0.40 },
        },
        {
            id: 'o3',
            name: 'o3 (Reasoning)',
            contextWindow: 200000,
            supportsToolCalling: true,
            supportsStreaming: true,
            supportsReasoning: true,
            pricing: { inputPerMillion: 10.00, outputPerMillion: 40.00 },
        },
        {
            id: 'o3-mini',
            name: 'o3 Mini (Reasoning)',
            contextWindow: 200000,
            supportsToolCalling: true,
            supportsStreaming: true,
            supportsReasoning: true,
            pricing: { inputPerMillion: 1.10, outputPerMillion: 4.40 },
        },
        {
            id: 'o4-mini',
            name: 'o4 Mini (Reasoning)',
            contextWindow: 200000,
            supportsToolCalling: true,
            supportsStreaming: true,
            supportsReasoning: true,
            pricing: { inputPerMillion: 1.10, outputPerMillion: 4.40 },
        },
    ],
};

export const ANTHROPIC_CONFIG: ProviderConfig = {
    id: 'anthropic',
    name: 'Anthropic',
    requiresApiKey: true,
    defaultEndpoint: 'api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
    models: [
        {
            id: 'claude-sonnet-4-20250514',
            name: 'Claude Sonnet 4',
            contextWindow: 200000,
            supportsToolCalling: true,
            supportsStreaming: true,
            pricing: { inputPerMillion: 3.00, outputPerMillion: 15.00 },
        },
        {
            id: 'claude-opus-4-20250514',
            name: 'Claude Opus 4',
            contextWindow: 200000,
            supportsToolCalling: true,
            supportsStreaming: true,
            pricing: { inputPerMillion: 15.00, outputPerMillion: 75.00 },
        },
        {
            id: 'claude-haiku-3-5-20241022',
            name: 'Claude 3.5 Haiku',
            contextWindow: 200000,
            supportsToolCalling: true,
            supportsStreaming: true,
            pricing: { inputPerMillion: 0.80, outputPerMillion: 4.00 },
        },
    ],
};

export const LLAMACPP_CONFIG: ProviderConfig = {
    id: 'llamacpp',
    name: 'llama.cpp (Local)',
    requiresApiKey: false,
    defaultEndpoint: 'localhost:8080',
    defaultModel: 'local-model',
    models: [
        {
            id: 'local-model',
            name: 'Local Model (auto-detect)',
            contextWindow: 8192,
            supportsToolCalling: false,
            supportsStreaming: true,
            pricing: { inputPerMillion: 0, outputPerMillion: 0 },
        },
    ],
};

export const ALL_PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
    deepseek: DEEPSEEK_CONFIG,
    openai: OPENAI_CONFIG,
    anthropic: ANTHROPIC_CONFIG,
    llamacpp: LLAMACPP_CONFIG,
};

export function getProviderConfig(id: string): ProviderConfig | undefined {
    return ALL_PROVIDER_CONFIGS[id];
}

export function getModelPricing(providerId: string, modelId: string): { inputPerMillion: number; outputPerMillion: number } {
    const config = ALL_PROVIDER_CONFIGS[providerId];
    if (!config) { return { inputPerMillion: 0, outputPerMillion: 0 }; }
    const model = config.models.find(m => m.id === modelId);
    return model?.pricing ?? { inputPerMillion: 0, outputPerMillion: 0 };
}
