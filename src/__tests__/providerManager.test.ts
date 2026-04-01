jest.mock('https');
jest.mock('vscode');

import * as vscode from 'vscode';
import { ProviderManager } from '../providers/providerManager';

const mockSecrets = {
    store: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    onDidChange: jest.fn(),
};

const mockContext = {
    secrets: mockSecrets,
} as unknown as vscode.ExtensionContext;

describe('ProviderManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((key: string, defaultVal: any) => {
                const map: Record<string, any> = {
                    provider: 'deepseek',
                    model: 'deepseek-chat',
                    temperature: 0,
                    maxTokens: 8192,
                    topP: 0.95,
                    frequencyPenalty: 0,
                    presencePenalty: 0,
                    streamResponses: true,
                    'llamacpp.endpoint': 'http://localhost:8080',
                };
                return map[key] ?? defaultVal;
            }),
        });
    });

    describe('API key management', () => {
        it('stores API key per provider', async () => {
            const pm = new ProviderManager(mockContext);
            await pm.setApiKey('openai', 'sk-test-123');
            expect(mockSecrets.store).toHaveBeenCalledWith('deepcode.apiKey.openai', 'sk-test-123');
        });

        it('retrieves API key per provider', async () => {
            mockSecrets.get.mockResolvedValue('sk-test-456');
            const pm = new ProviderManager(mockContext);
            const key = await pm.getApiKey('openai');
            expect(mockSecrets.get).toHaveBeenCalledWith('deepcode.apiKey.openai');
            expect(key).toBe('sk-test-456');
        });

        it('clears API key per provider', async () => {
            const pm = new ProviderManager(mockContext);
            await pm.clearApiKey('anthropic');
            expect(mockSecrets.delete).toHaveBeenCalledWith('deepcode.apiKey.anthropic');
        });
    });

    describe('provider selection', () => {
        it('returns active provider ID from config', () => {
            const pm = new ProviderManager(mockContext);
            expect(pm.getActiveProviderId()).toBe('deepseek');
        });

        it('returns active model from config', () => {
            const pm = new ProviderManager(mockContext);
            expect(pm.getActiveModel()).toBe('deepseek-chat');
        });

        it('returns all available providers', () => {
            const pm = new ProviderManager(mockContext);
            const providers = pm.getAvailableProviders();
            expect(providers.length).toBe(4);
            expect(providers.map(p => p.id)).toEqual(['deepseek', 'openai', 'anthropic', 'llamacpp']);
        });
    });

    describe('API key migration', () => {
        it('migrates old deepcode.apiKey to deepcode.apiKey.deepseek', async () => {
            mockSecrets.get.mockImplementation((key: string) => {
                if (key === 'deepcode.apiKey') { return Promise.resolve('old-key-123'); }
                return Promise.resolve(undefined);
            });

            const pm = new ProviderManager(mockContext);
            await pm.migrateApiKey();

            expect(mockSecrets.store).toHaveBeenCalledWith('deepcode.apiKey.deepseek', 'old-key-123');
            expect(mockSecrets.delete).toHaveBeenCalledWith('deepcode.apiKey');
        });

        it('skips migration if old key does not exist', async () => {
            mockSecrets.get.mockResolvedValue(undefined);
            const pm = new ProviderManager(mockContext);
            await pm.migrateApiKey();
            expect(mockSecrets.store).not.toHaveBeenCalled();
        });
    });

    describe('getActiveProvider', () => {
        it('creates OpenAICompatibleProvider for deepseek', async () => {
            mockSecrets.get.mockResolvedValue('test-key');
            const pm = new ProviderManager(mockContext);
            const provider = await pm.getActiveProvider();
            expect(provider).toBeDefined();
            expect(provider!.getProviderName()).toBe('DeepSeek');
        });

        it('returns null if API key missing for cloud provider', async () => {
            mockSecrets.get.mockResolvedValue(undefined);
            const pm = new ProviderManager(mockContext);
            const provider = await pm.getActiveProvider();
            expect(provider).toBeNull();
        });

        it('creates provider without API key for llamacpp', async () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn((key: string, defaultVal: any) => {
                    if (key === 'provider') { return 'llamacpp'; }
                    if (key === 'model') { return 'local-model'; }
                    if (key === 'llamacpp.endpoint') { return 'http://localhost:8080'; }
                    return defaultVal;
                }),
            });
            mockSecrets.get.mockResolvedValue(undefined);
            const pm = new ProviderManager(mockContext);
            const provider = await pm.getActiveProvider();
            expect(provider).toBeDefined();
            expect(provider!.getProviderName()).toBe('llama.cpp (Local)');
        });

        it('caches provider instance', async () => {
            mockSecrets.get.mockResolvedValue('test-key');
            const pm = new ProviderManager(mockContext);
            const p1 = await pm.getActiveProvider();
            const p2 = await pm.getActiveProvider();
            expect(p1).toBe(p2);
        });

        it('invalidates cache on config change', async () => {
            mockSecrets.get.mockResolvedValue('test-key');
            const pm = new ProviderManager(mockContext);
            const p1 = await pm.getActiveProvider();
            pm.onConfigurationChanged();
            const p2 = await pm.getActiveProvider();
            expect(p1).not.toBe(p2);
        });
    });

    describe('getConfig', () => {
        it('returns full config object', () => {
            const pm = new ProviderManager(mockContext);
            const cfg = pm.getConfig();
            expect(cfg.provider).toBe('deepseek');
            expect(cfg.model).toBe('deepseek-chat');
            expect(cfg.temperature).toBe(0);
            expect(cfg.maxTokens).toBe(8192);
        });
    });

    describe('getActiveModelPricing', () => {
        it('returns pricing for deepseek-chat', () => {
            const pm = new ProviderManager(mockContext);
            const pricing = pm.getActiveModelPricing();
            expect(pricing.inputPerMillion).toBe(0.14);
            expect(pricing.outputPerMillion).toBe(0.28);
        });
    });
});
