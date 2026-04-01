/**
 * ProviderManager — central coordinator for multi-provider support.
 *
 * Manages per-provider API keys in VS Code SecretStorage, creates/caches
 * provider instances, reads configuration, and handles migration from
 * the old single-key format.
 */

import * as vscode from 'vscode';
import { LLMProvider, ProviderConfig, ProviderID } from './types';
import { ALL_PROVIDER_CONFIGS, getProviderConfig, getModelPricing } from './configs';
import { OpenAICompatibleProvider } from './openaiCompatible';
import { AnthropicProvider } from './anthropic';

const API_KEY_PREFIX = 'deepcode.apiKey';
const OLD_API_KEY = 'deepcode.apiKey';

export class ProviderManager {
    private context: vscode.ExtensionContext;
    private cachedProvider: LLMProvider | null = null;
    private cachedProviderId: string | null = null;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    // ── API Key Management ──────────────────────────────────────────────────

    async getApiKey(providerId: string): Promise<string | undefined> {
        return this.context.secrets.get(`${API_KEY_PREFIX}.${providerId}`);
    }

    async setApiKey(providerId: string, key: string): Promise<void> {
        await this.context.secrets.store(`${API_KEY_PREFIX}.${providerId}`, key);
        this.invalidateCache();
    }

    async clearApiKey(providerId: string): Promise<void> {
        await this.context.secrets.delete(`${API_KEY_PREFIX}.${providerId}`);
        this.invalidateCache();
    }

    async migrateApiKey(): Promise<void> {
        const oldKey = await this.context.secrets.get(OLD_API_KEY);
        if (oldKey) {
            await this.context.secrets.store(`${API_KEY_PREFIX}.deepseek`, oldKey);
            await this.context.secrets.delete(OLD_API_KEY);
        }
    }

    // ── Provider Selection ──────────────────────────────────────────────────

    getActiveProviderId(): ProviderID {
        const config = vscode.workspace.getConfiguration('deepcode');
        return config.get<ProviderID>('provider', 'deepseek');
    }

    getActiveModel(): string {
        const config = vscode.workspace.getConfiguration('deepcode');
        return config.get<string>('model', 'deepseek-chat');
    }

    getAvailableProviders(): ProviderConfig[] {
        return Object.values(ALL_PROVIDER_CONFIGS);
    }

    getActiveModelPricing(): { inputPerMillion: number; outputPerMillion: number } {
        return getModelPricing(this.getActiveProviderId(), this.getActiveModel());
    }

    getConfig(): {
        provider: ProviderID;
        model: string;
        temperature: number;
        maxTokens: number;
        topP: number;
        frequencyPenalty: number;
        presencePenalty: number;
        stream: boolean;
        systemPrompt: string;
    } {
        const config = vscode.workspace.getConfiguration('deepcode');
        return {
            provider: config.get<ProviderID>('provider', 'deepseek'),
            model: config.get<string>('model', 'deepseek-chat'),
            temperature: config.get<number>('temperature', 0),
            maxTokens: config.get<number>('maxTokens', 8192),
            topP: config.get<number>('topP', 0.95),
            frequencyPenalty: config.get<number>('frequencyPenalty', 0),
            presencePenalty: config.get<number>('presencePenalty', 0),
            stream: config.get<boolean>('streamResponses', true),
            systemPrompt: '',
        };
    }

    // ── Provider Creation ───────────────────────────────────────────────────

    async getActiveProvider(): Promise<LLMProvider | null> {
        const providerId = this.getActiveProviderId();

        if (this.cachedProvider && this.cachedProviderId === providerId) {
            return this.cachedProvider;
        }

        const providerConfig = getProviderConfig(providerId);
        if (!providerConfig) { return null; }

        if (providerConfig.requiresApiKey) {
            const apiKey = await this.getApiKey(providerId);
            if (!apiKey) { return null; }
            const provider = this.createProvider(providerId, apiKey, providerConfig);
            this.cachedProvider = provider;
            this.cachedProviderId = providerId;
            return provider;
        }

        const provider = this.createProvider(providerId, '', providerConfig);
        this.cachedProvider = provider;
        this.cachedProviderId = providerId;
        return provider;
    }

    async hasApiKey(): Promise<boolean> {
        const providerId = this.getActiveProviderId();
        const config = getProviderConfig(providerId);
        if (!config?.requiresApiKey) { return true; }
        const key = await this.getApiKey(providerId);
        return !!key;
    }

    /** Clear the cached provider so the next call to getActiveProvider() creates a fresh one */
    clearCachedProvider(): void {
        this.cachedProvider = null;
        this.cachedProviderId = null;
    }

    onConfigurationChanged(): void {
        this.invalidateCache();
    }

    // ── Private ─────────────────────────────────────────────────────────────

    private createProvider(providerId: string, apiKey: string, config: ProviderConfig): LLMProvider {
        if (providerId === 'anthropic') {
            return new AnthropicProvider(apiKey);
        }

        let endpoint: string | undefined;
        if (providerId === 'llamacpp') {
            const vsConfig = vscode.workspace.getConfiguration('deepcode');
            const rawEndpoint = vsConfig.get<string>('llamacpp.endpoint', 'http://localhost:8080');
            endpoint = rawEndpoint.replace(/^https?:\/\//, '');
        }

        return new OpenAICompatibleProvider(apiKey, config, endpoint);
    }

    private invalidateCache(): void {
        this.cachedProvider = null;
        this.cachedProviderId = null;
    }
}
