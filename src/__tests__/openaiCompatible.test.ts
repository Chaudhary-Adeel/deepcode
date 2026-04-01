jest.mock('https');

import { OpenAICompatibleProvider } from '../providers/openaiCompatible';
import { DEEPSEEK_CONFIG, OPENAI_CONFIG, LLAMACPP_CONFIG } from '../providers/configs';

describe('OpenAICompatibleProvider', () => {
    describe('constructor', () => {
        it('creates provider with DeepSeek config', () => {
            const provider = new OpenAICompatibleProvider('test-key', DEEPSEEK_CONFIG);
            expect(provider.getProviderName()).toBe('DeepSeek');
            expect(provider.supportsToolCalling()).toBe(true);
        });

        it('creates provider with OpenAI config', () => {
            const provider = new OpenAICompatibleProvider('test-key', OPENAI_CONFIG);
            expect(provider.getProviderName()).toBe('OpenAI');
        });

        it('creates provider with llama.cpp config and no API key', () => {
            const provider = new OpenAICompatibleProvider('', LLAMACPP_CONFIG);
            expect(provider.getProviderName()).toBe('llama.cpp (Local)');
        });
    });

    describe('getAvailableModels', () => {
        it('returns models from config', () => {
            const provider = new OpenAICompatibleProvider('test-key', DEEPSEEK_CONFIG);
            const models = provider.getAvailableModels();
            expect(models.length).toBe(2);
            expect(models[0].id).toBe('deepseek-chat');
            expect(models[1].id).toBe('deepseek-reasoner');
        });

        it('returns OpenAI models', () => {
            const provider = new OpenAICompatibleProvider('test-key', OPENAI_CONFIG);
            const models = provider.getAvailableModels();
            expect(models.length).toBeGreaterThan(0);
            expect(models.find(m => m.id === 'gpt-4o')).toBeDefined();
        });
    });

    describe('supportsToolCalling', () => {
        it('returns true for providers with tool-capable models', () => {
            const provider = new OpenAICompatibleProvider('test-key', OPENAI_CONFIG);
            expect(provider.supportsToolCalling()).toBe(true);
        });

        it('returns false for llama.cpp by default', () => {
            const provider = new OpenAICompatibleProvider('', LLAMACPP_CONFIG);
            expect(provider.supportsToolCalling()).toBe(false);
        });
    });
});
