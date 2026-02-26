import * as vscode from 'vscode';
import * as https from 'https';
import {
    AgentLoop,
    AGENT_SYSTEM_PROMPT,
    AgentLoopResult,
    AgentMessage,
} from './agentLoop';
import {
    ToolExecutor,
    ToolCallResult,
    AGENT_TOOLS,
    SUBAGENT_TOOLS,
} from './tools';
import { EditResult } from './fileEditorService';
import { ContextManager, RollingContext, ContextBudget, OperationEntry } from './contextManager';
import { MemoryService } from './memoryService';
import { IntentAgent, IntentResult } from './agents/intentAgent';
import { PlannerAgent, PlanResult } from './agents/plannerAgent';
import { ReferenceMiner } from './agents/referenceMiner';
import { Verifier, VerifyResult } from './agents/verifier';

/**
 * Sub-Agent Service for DeepCode — v3 (Agentic Tool-Use Architecture)
 *
 * Architecture:
 *   Full agentic loop with tool use for both chat and edit flows.
 *   Uses AgentLoop + ToolExecutor to iteratively think, act, and observe.
 *
 *   For edits:
 *     1. Agent reads the file with read_file
 *     2. Agent plans and applies edits with edit_file
 *     3. Agent verifies with get_diagnostics
 *     4. Service extracts applied edits for caller approval workflow
 *
 *   For chat:
 *     1. Agent explores codebase with tools (read_file, grep_search, etc.)
 *     2. Agent reasons and responds with full context
 *     3. Agent can spawn sub-agents for parallel investigation
 */

// ─── Types (backward compatible) ────────────────────────────────────────────

export type AgentRole = 'frontend' | 'backend' | 'patterns' | 'logic';

export interface AgentResult {
    role: AgentRole;
    content: string;
    tokens: number;
}

export interface OrchestratedResponse {
    content: string;
    agentResults: AgentResult[];
    totalTokens: number;
    agentsUsed: AgentRole[];
    /** Pre-parsed edit result — when present, callers can skip parseEditResponse entirely. */
    editResult?: EditResult;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Safety ceiling — NOT a target. The loop ends when the model stops calling tools.
 * Loop detection kicks in much earlier if the agent gets stuck.
 * Sub-agents use a tighter limit (see agentLoop sub-agent spawn).
 */
const MAX_ITERATIONS = 200;
const DEFAULT_MAX_TOKENS = 4096;

// ─── Service Implementation ─────────────────────────────────────────────────

export class SubAgentService {

    /**
     * Handle a chat message using the full agentic tool-use loop.
     * The agent can read files, search the codebase, run commands, and
     * spawn sub-agents before producing its final response.
     *
     * Maintains backward compatibility with OrchestratedResponse.
     */
    async orchestrateChat(
        apiKey: string,
        model: string,
        userMessage: string,
        context: string,
        temperature: number,
        topP: number,
        onStatus?: (status: string) => void,
        checkCancelled?: () => boolean,
    ): Promise<OrchestratedResponse> {
        onStatus?.('Building workspace context...');
        if (checkCancelled?.()) { throw new Error('Cancelled'); }

        const toolExecutor = new ToolExecutor();
        const contextManager = new ContextManager();
        const memoryService = new MemoryService();

        // Build workspace context and populate system prompt
        const workspaceContext = await contextManager.buildWorkspaceContext();
        const memoryContext = await memoryService.getMemoryContext(userMessage);
        let enrichedContext = workspaceContext;
        if (memoryContext) {
            enrichedContext = `${memoryContext}\n\n${workspaceContext}`;
        }
        const systemPrompt = AGENT_SYSTEM_PROMPT.replace(
            '{WORKSPACE_CONTEXT}',
            enrichedContext
        );

        // Prepend additional context (editor state, attached files, etc.)
        let fullUserMessage = userMessage;
        if (context) {
            const compressed = contextManager.compressContext(context, 12000);
            fullUserMessage = `${compressed}\n\n---\n\n${userMessage}`;
        }

        onStatus?.('Starting agent...');

        const agentLoop = new AgentLoop({
            apiKey,
            model,
            systemPrompt,
            temperature,
            topP,
            maxTokens: DEFAULT_MAX_TOKENS,
            maxIterations: MAX_ITERATIONS,
            tools: AGENT_TOOLS,
            toolExecutor,
            onProgress: onStatus,
            checkCancelled,
        });

        const result = await agentLoop.run(fullUserMessage);

        return this.mapToOrchestratedResponse(result);
    }

    /**
     * Handle an edit request using the full agentic loop.
     * The agent reads the target file, plans surgical edits, applies them
     * via the edit_file tool, and verifies correctness.
     *
     * After the loop completes:
     *   - If the agent used edit_file: reverts the file to original content
     *     and returns the edits as JSON so the caller's approval workflow
     *     (parseEditResponse → user approve → applyEdits) works unchanged.
     *   - If the agent used write_file: same revert + return a whole-file edit.
     *   - If the agent only gave text instructions: returns the raw content
     *     so the caller can attempt JSON extraction as a fallback.
     *
     * Maintains backward compatibility with OrchestratedResponse.
     */
    async orchestrateEdit(
        apiKey: string,
        model: string,
        fileContent: string,
        fileName: string,
        instruction: string,
        selectedText: string | undefined,
        temperature: number,
        topP: number,
        onStatus?: (status: string) => void,
        checkCancelled?: () => boolean,
    ): Promise<OrchestratedResponse> {
        onStatus?.('Building workspace context...');
        if (checkCancelled?.()) { throw new Error('Cancelled'); }

        const toolExecutor = new ToolExecutor();
        const contextManager = new ContextManager();

        const workspaceContext = await contextManager.buildWorkspaceContext();
        const systemPrompt = AGENT_SYSTEM_PROMPT.replace(
            '{WORKSPACE_CONTEXT}',
            workspaceContext
        );

        // Build an edit-specific user message with file content and instruction
        const userMessage = this.buildEditUserMessage(
            fileContent,
            fileName,
            instruction,
            selectedText
        );

        onStatus?.('Analyzing code and planning edits...');

        const agentLoop = new AgentLoop({
            apiKey,
            model,
            systemPrompt,
            temperature: Math.min(temperature, 0.1), // Keep edits deterministic
            topP,
            maxTokens: DEFAULT_MAX_TOKENS,
            maxIterations: MAX_ITERATIONS,
            tools: AGENT_TOOLS,
            toolExecutor,
            onProgress: onStatus,
            checkCancelled,
        });

        const result = await agentLoop.run(userMessage);

        // ── Post-loop: extract edits and revert file for approval workflow ──

        const relativePath = this.getRelativePath(fileName);

        // Check if the agent modified the target file via edit_file or write_file
        const touchedTarget = result.toolCalls.some(
            tc => (tc.name === 'edit_file' || tc.name === 'write_file' || tc.name === 'multi_edit_files') &&
                  this.pathsMatch(tc.args.path, relativePath)
        );

        if (touchedTarget) {
            // Read the file's FINAL content after all agent edits
            let finalContent: string;
            try {
                const uri = vscode.Uri.file(fileName);
                const doc = await vscode.workspace.openTextDocument(uri);
                finalContent = doc.getText();
            } catch {
                finalContent = fileContent; // fallback — no change detected
            }

            // Only proceed if the file actually changed
            if (finalContent !== fileContent) {
                // Revert the file so the caller can apply edits through its own
                // approval + applyEdits workflow.
                await this.revertFile(fileName, fileContent);

                const explanation = result.content
                    ? this.truncate(result.content, 500)
                    : `Applied edits to ${relativePath || fileName}`;

                // Build EditResult directly — no JSON serialization round-trip.
                // This avoids broken JSON when file content contains special chars.
                const editResult: EditResult = {
                    edits: [{ oldText: fileContent, newText: finalContent }],
                    explanation,
                };

                return {
                    content: explanation,
                    editResult,
                    agentResults: [{
                        role: 'logic' as AgentRole,
                        content: explanation,
                        tokens: result.totalTokens,
                    }],
                    totalTokens: result.totalTokens,
                    agentsUsed: this.inferAgentsUsed(result),
                };
            }
        }

        // Agent didn't modify the target file — return raw content.
        // The caller will attempt parseEditResponse as a fallback.
        return this.mapToOrchestratedResponse(result);
    }

    /**
     * Raw agentic loop with full tool and callback visibility.
     *
     * Pipeline: Intent → (Planner) → (ReferenceMiner) → Generator → (Verifier)
     *
     * - Simple tasks skip Planner
     * - Tasks with unfamiliar libs trigger ReferenceMiner
     * - Verifier runs after code generation if a verify command is configured
     * - RollingContext tracks conversation across turns
     * - ContextBudget prevents context overflow
     */
    async runAgentLoop(
        apiKey: string,
        model: string,
        userMessage: string,
        context: string,
        temperature: number,
        topP: number,
        attachedFiles?: string[],
        conversationHistory?: AgentMessage[],
        onStatus?: (status: string) => void,
        onToolCall?: (toolName: string, args: Record<string, any>) => void,
        onToolResult?: (toolName: string, result: ToolCallResult) => void,
        checkCancelled?: () => boolean,
        onToken?: (token: string) => void,
    ): Promise<AgentLoopResult> {
        const toolExecutor = new ToolExecutor();
        const contextManager = new ContextManager();
        const memoryService = new MemoryService();
        const rollingContext = new RollingContext();
        const budget = new ContextBudget();

        // Build workspace context
        const workspaceContext = await contextManager.buildWorkspaceContext();

        // Load progressive memory for project understanding
        onStatus?.('Loading project memory...');
        const memoryContext = await memoryService.getMemoryContext(userMessage);

        // Inject memory into system prompt
        let enrichedContext = workspaceContext;
        if (memoryContext) {
            enrichedContext = `${memoryContext}\n\n${workspaceContext}`;
        }

        const systemPrompt = AGENT_SYSTEM_PROMPT.replace(
            '{WORKSPACE_CONTEXT}',
            enrichedContext
        );

        // Build full user message with context and attached files
        let fullUserMessage = userMessage;
        if (context) {
            const compressed = contextManager.compressContext(context, 12000);
            fullUserMessage = `${compressed}\n\n---\n\n${userMessage}`;
        }

        if (attachedFiles && attachedFiles.length > 0) {
            const fileContents = await contextManager.readMultipleFiles(attachedFiles);
            let attachedContext = '\n\n--- Attached Files ---';
            for (const fc of fileContents) {
                const ext = fc.path.split('.').pop() || '';
                attachedContext += `\n\nFile: ${fc.path}\n\`\`\`${ext}\n${fc.content}\n\`\`\``;
            }
            fullUserMessage += attachedContext;
        }

        // Populate rolling context from conversation history
        if (conversationHistory) {
            for (const msg of conversationHistory) {
                if (msg.content) {
                    rollingContext.addTurn(msg.role, msg.content);
                }
            }
        }
        rollingContext.addTurn('user', userMessage);

        // ── Stage 1: Intent Classification ──────────────────────────────
        // Quick heuristic: skip intent agent for trivial messages
        const wordCount = userMessage.split(/\s+/).length;
        const hasAttachedContent = !!context && context.length > 100;
        const isSimpleFollowUp = conversationHistory && conversationHistory.length > 2;
        const isTrivial = wordCount < 20;
        const isSimpleEdit = wordCount < 40 && (
            userMessage.toLowerCase().includes('edit') ||
            userMessage.toLowerCase().includes('change') ||
            userMessage.toLowerCase().includes('update') ||
            userMessage.toLowerCase().includes('rename') ||
            userMessage.toLowerCase().includes('add') ||
            userMessage.toLowerCase().includes('remove') ||
            userMessage.toLowerCase().includes('delete') ||
            userMessage.toLowerCase().includes('fix')
        );
        const skipPipeline = hasAttachedContent || isSimpleFollowUp || isTrivial || isSimpleEdit;

        let intent: IntentResult | undefined;
        let plan: PlanResult | undefined;
        let referenceGuide = '';
        let pipelineContext = '';

        if (!skipPipeline && wordCount > 5) {
            // Get recently modified files from dirty tracker
            let recentFiles: string[] = [];
            try {
                const { getIndexEngine } = require('./extension') as typeof import('./extension');
                const engine = getIndexEngine();
                if (engine) {
                    recentFiles = Array.from(engine.getAllCached().keys()).slice(0, 20);
                }
            } catch { /* best effort */ }

            // Intent Agent
            onStatus?.('Classifying request...');
            onToolCall?.('intent_agent', { task: 'Classifying user intent' });
            try {
                const intentAgent = new IntentAgent(apiKey, model);
                intent = await intentAgent.analyze(userMessage, recentFiles);

                rollingContext.addOperation({
                    timestamp: Date.now(),
                    agentType: 'intent',
                    action: 'classify',
                    target: userMessage.substring(0, 100),
                    result: 'success',
                    notes: `type=${intent.taskType}, complexity=${intent.complexity}, files=${intent.filesInScope.length}`,
                });

                onToolResult?.('intent_agent', {
                    success: true,
                    output: `Intent: ${intent.taskType} (${intent.complexity}), ${intent.filesInScope.length} files in scope`,
                });

                pipelineContext += `\n## Intent Analysis\nTask type: ${intent.taskType}\nComplexity: ${intent.complexity}\nClarified: ${intent.clarifiedTask}\nFiles in scope: ${intent.filesInScope.join(', ')}\n`;
            } catch (err: any) {
                rollingContext.addOperation({
                    timestamp: Date.now(),
                    agentType: 'intent',
                    action: 'classify',
                    target: userMessage.substring(0, 100),
                    result: 'failure',
                    notes: err.message,
                });
                onToolResult?.('intent_agent', { success: false, output: err.message });
            }

            if (checkCancelled?.()) { throw new Error('Cancelled'); }

            // ── Stage 2: Planner (complex tasks only) ───────────────────
            if (intent && (intent.complexity === 'complex' || intent.complexity === 'moderate')) {
                onStatus?.('Planning approach...');
                onToolCall?.('planner_agent', { task: 'Planning implementation' });
                try {
                    const plannerAgent = new PlannerAgent(apiKey, model);

                    // Get skeletons for files in scope
                    let skeletons = '';
                    try {
                        const { getIndexEngine } = require('./extension') as typeof import('./extension');
                        const engine = getIndexEngine();
                        if (engine) {
                            const skels: string[] = [];
                            for (const fp of intent.filesInScope.slice(0, 10)) {
                                const skel = await engine.getSkeleton(fp);
                                if (skel) { skels.push(`=== ${fp} ===\n${skel}`); }
                            }
                            skeletons = skels.join('\n\n');
                        }
                    } catch { /* best effort */ }

                    plan = await plannerAgent.plan(intent.clarifiedTask, skeletons, workspaceContext);

                    rollingContext.addOperation({
                        timestamp: Date.now(),
                        agentType: 'planner',
                        action: 'plan',
                        target: intent.clarifiedTask.substring(0, 100),
                        result: 'success',
                        notes: `approach=${plan.approach.substring(0, 100)}, files=${plan.fileOrder.length}, risks=${plan.risks.length}`,
                    });

                    onToolResult?.('planner_agent', {
                        success: true,
                        output: `Plan: ${plan.approach.substring(0, 200)}; Files: ${plan.fileOrder.join(', ')}`,
                    });

                    pipelineContext += `\n## Execution Plan\nApproach: ${plan.approach}\nFile order: ${plan.fileOrder.join(' → ')}\nPattern: ${plan.pattern}\nRisks: ${plan.risks.join('; ')}\n`;
                } catch (err: any) {
                    rollingContext.addOperation({
                        timestamp: Date.now(),
                        agentType: 'planner',
                        action: 'plan',
                        target: intent.clarifiedTask.substring(0, 100),
                        result: 'failure',
                        notes: err.message,
                    });
                    onToolResult?.('planner_agent', { success: false, output: err.message });
                }
            }

            if (checkCancelled?.()) { throw new Error('Cancelled'); }

            // ── Stage 3: Reference Miner (unfamiliar libs) ──────────────
            if (intent?.needsExternalRef) {
                onStatus?.('Searching for reference examples...');
                onToolCall?.('reference_miner', { task: 'Finding code examples' });
                try {
                    const miner = new ReferenceMiner(apiKey, model);
                    // Extract library names from the task
                    const libs = this.extractLibraryNames(intent.clarifiedTask);
                    if (libs.length > 0) {
                        const minerResult = await miner.mine(intent.clarifiedTask, libs);
                        if (minerResult.guide) {
                            referenceGuide = minerResult.guide;
                            pipelineContext += `\n## External References\n${referenceGuide}\n`;

                            rollingContext.addOperation({
                                timestamp: Date.now(),
                                agentType: 'reference-miner',
                                action: 'mine',
                                target: libs.join(', '),
                                result: 'success',
                                notes: `guide=${referenceGuide.length} chars`,
                            });
                        }
                    }
                    onToolResult?.('reference_miner', {
                        success: true,
                        output: referenceGuide ? `Found references for ${libs.join(', ')}` : 'No references needed',
                    });
                } catch (err: any) {
                    rollingContext.addOperation({
                        timestamp: Date.now(),
                        agentType: 'reference-miner',
                        action: 'mine',
                        target: userMessage.substring(0, 100),
                        result: 'failure',
                        notes: err.message,
                    });
                    onToolResult?.('reference_miner', { success: false, output: err.message });
                }
            }

            if (checkCancelled?.()) { throw new Error('Cancelled'); }
        }

        // ── Stage 4: Generator (main agent loop) ────────────────────────
        // Prepend pipeline findings to the user message for the generator
        if (pipelineContext) {
            fullUserMessage = `${pipelineContext}\n---\n\n${fullUserMessage}`;
        }

        // Apply context budget before sending to generator
        const rollingBuild = rollingContext.buildContext();
        const budgetResult = budget.fit({
            systemPrompt,
            summary: rollingBuild,
            skeletons: '', // Skeletons are fetched on-demand by tools
            toolResults: pipelineContext,
            history: conversationHistory?.map(m => ({
                role: m.role,
                content: m.content || '',
            })) || [],
        });

        // Log any budget drops
        if (budgetResult.dropped.length > 0) {
            rollingContext.addOperation({
                timestamp: Date.now(),
                agentType: 'orchestrator',
                action: 'budget-trim',
                target: 'context',
                result: 'success',
                notes: `Dropped: ${budgetResult.dropped.join(', ')} (${budgetResult.totalTokens} tokens remaining)`,
            });
        }

        // Check for repeated failures — switch to simpler approach
        if (rollingContext.hasRepeatedFailure('classify', 2) ||
            rollingContext.hasRepeatedFailure('plan', 2)) {
            onStatus?.('Previous attempts had issues — using direct approach...');
        }

        onStatus?.('Working on your request...');

        const agentLoop = new AgentLoop({
            apiKey,
            model,
            systemPrompt: budgetResult.systemPrompt,
            temperature,
            topP,
            maxTokens: DEFAULT_MAX_TOKENS,
            maxIterations: MAX_ITERATIONS,
            tools: AGENT_TOOLS,
            toolExecutor,
            onProgress: onStatus,
            onToolCall,
            onToolResult,
            onToken,
            checkCancelled,
        });

        const result = await agentLoop.run(fullUserMessage, conversationHistory);

        rollingContext.addTurn('assistant', result.content);
        rollingContext.addOperation({
            timestamp: Date.now(),
            agentType: 'generator',
            action: intent?.taskType || 'respond',
            target: userMessage.substring(0, 100),
            result: 'success',
            notes: `${result.iterations} iterations, ${result.toolCalls.length} tool calls`,
        });

        // ── Stage 5: Verifier (if verify command is configured and code was generated) ──
        const verifyCommand = vscode.workspace
            .getConfiguration('deepcode')
            .get<string>('verifyCommand', '');

        const madeCodeChanges = result.toolCalls.some(
            tc => tc.name === 'edit_file' || tc.name === 'write_file' || tc.name === 'multi_edit_files'
        );

        if (verifyCommand && madeCodeChanges) {
            onStatus?.('Verifying changes...');
            onToolCall?.('verifier', { command: verifyCommand });
            try {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                const verifier = new Verifier(apiKey, model);
                const verifyResult = await verifier.run(workspaceRoot);

                rollingContext.addOperation({
                    timestamp: Date.now(),
                    agentType: 'verifier',
                    action: 'verify',
                    target: verifyCommand,
                    result: verifyResult.passed ? 'success' : 'failure',
                    notes: verifyResult.passed
                        ? `Passed (${verifyResult.attempts} attempt(s))`
                        : `Failed after ${verifyResult.attempts} attempts: ${verifyResult.errors.slice(0, 3).join('; ')}`,
                });

                onToolResult?.('verifier', {
                    success: verifyResult.passed,
                    output: verifyResult.passed
                        ? `Verification passed (${verifyResult.attempts} attempt(s))`
                        : `Verification failed: ${verifyResult.errors.slice(0, 3).join('\n')}`,
                });
            } catch (err: any) {
                rollingContext.addOperation({
                    timestamp: Date.now(),
                    agentType: 'verifier',
                    action: 'verify',
                    target: verifyCommand,
                    result: 'failure',
                    notes: err.message,
                });
                onToolResult?.('verifier', { success: false, output: err.message });
            }
        }

        // ── Post-flight: Summarize if conversation is getting long ───────
        if (rollingContext.getTurnCount() > 6) {
            try {
                await rollingContext.maybeSummarize(async (text) => {
                    // Use DeepSeek to summarize older turns
                    return this.summarizeText(apiKey, model, text);
                });
            } catch { /* non-critical */ }
        }

        // ── Post-flight: Update Progressive Memory ──────────────────────
        try {
            await memoryService.updateFromInteraction(
                userMessage,
                result.content,
                result.toolCalls,
                result.subAgentResults,
            );
        } catch {
            // Non-critical — don't fail the response if memory update fails
        }

        return result;
    }

    // ─── Pipeline Helpers ────────────────────────────────────────────────

    /**
     * Extract library/framework names from a task description.
     * Looks for common patterns like package names, framework keywords.
     */
    private extractLibraryNames(task: string): string[] {
        const libs: string[] = [];

        // Match quoted package names
        const quoted = task.match(/['"`]([a-z@][a-z0-9./_-]+)['"`]/gi);
        if (quoted) {
            for (const q of quoted) {
                libs.push(q.replace(/['"`]/g, ''));
            }
        }

        // Match common framework/library keywords
        const keywords = [
            'react', 'vue', 'angular', 'svelte', 'next', 'nuxt', 'express',
            'fastify', 'prisma', 'drizzle', 'mongoose', 'sequelize', 'typeorm',
            'tailwind', 'bootstrap', 'material-ui', 'chakra', 'ant-design',
            'jest', 'vitest', 'mocha', 'cypress', 'playwright',
            'webpack', 'vite', 'rollup', 'esbuild', 'turbopack',
            'graphql', 'trpc', 'socket.io', 'redis', 'kafka',
            'aws-sdk', 'firebase', 'supabase', 'stripe', 'twilio',
            'd3', 'three.js', 'tensorflow', 'sharp', 'puppeteer',
        ];

        const lower = task.toLowerCase();
        for (const kw of keywords) {
            if (lower.includes(kw) && !libs.includes(kw)) {
                libs.push(kw);
            }
        }

        return libs.slice(0, 5); // Cap at 5 to avoid excessive web searches
    }

    /**
     * Summarize text using DeepSeek (used by RollingContext).
     */
    private summarizeText(apiKey: string, model: string, text: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                model,
                messages: [
                    {
                        role: 'system',
                        content: 'Summarize the following conversation turns into a concise ~150-word digest. Focus on: what was asked, what code was modified, what decisions were made, and any unresolved issues.',
                    },
                    { role: 'user', content: text },
                ],
                temperature: 0,
                max_tokens: 500,
            });

            const reqOpts: https.RequestOptions = {
                hostname: 'api.deepseek.com',
                port: 443,
                path: '/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(reqOpts, (res: any) => {
                let data = '';
                res.on('data', (chunk: any) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.choices?.[0]?.message?.content || text.substring(0, 300));
                    } catch {
                        resolve(text.substring(0, 300));
                    }
                });
            });

            req.on('error', () => resolve(text.substring(0, 300)));
            req.setTimeout(10000, () => {
                req.destroy();
                resolve(text.substring(0, 300));
            });
            req.write(body);
            req.end();
        });
    }

    // ─── Private Helpers ─────────────────────────────────────────────────

    /**
     * Build the user prompt for edit requests.
     * Includes the file content, instruction, and selected text so the agent
     * has full context before it starts reading/editing with tools.
     */
    private buildEditUserMessage(
        fileContent: string,
        fileName: string,
        instruction: string,
        selectedText?: string,
    ): string {
        const relativePath = this.getRelativePath(fileName);
        const displayPath = relativePath || fileName;
        const ext = fileName.split('.').pop() || '';
        const lineCount = fileContent.split('\n').length;

        let message = `I need you to edit the file \`${displayPath}\` (${lineCount} lines, .${ext}).\n\n`;
        message += `## Instruction\n${instruction}\n\n`;

        if (selectedText) {
            const selStart = fileContent.indexOf(selectedText);
            if (selStart !== -1) {
                const linesBefore = fileContent.substring(0, selStart).split('\n').length;
                const selLines = selectedText.split('\n').length;
                message += `## Selected Code (lines ${linesBefore}-${linesBefore + selLines - 1})\n`;
            } else {
                message += `## Selected Code\n`;
            }
            message += `\`\`\`${ext}\n${selectedText}\n\`\`\`\n\n`;
        }

        message += `## Current File Content\n`;
        if (lineCount > 100) {
            const numbered = fileContent.split('\n')
                .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
                .join('\n');
            message += `\`\`\`${ext}\n${numbered}\n\`\`\`\n`;
        } else {
            message += `\`\`\`${ext}\n${fileContent}\n\`\`\`\n`;
        }

        message += `\nIMPORTANT: The file content above is ALREADY the current content — do NOT read_file again. `;
        message += `Use edit_file with precise oldText/newText pairs to make the changes directly. `;
        message += `Diagnostics are checked automatically after edit_file — no need to call get_diagnostics manually.`;

        return message;
    }

    /**
     * Extract individual {oldText, newText} edits from edit_file tool calls
     * that targeted a specific file path.
     */
    /**
     * Revert a file to its original content.
     * Uses the VS Code editor API when possible (preserves undo stack),
     * falls back to direct file system write.
     */
    private async revertFile(
        filePath: string,
        originalContent: string,
    ): Promise<void> {
        try {
            const uri = vscode.Uri.file(filePath);
            // Write directly to disk without opening/showing the file
            await vscode.workspace.fs.writeFile(
                uri,
                Buffer.from(originalContent, 'utf-8')
            );
        } catch {
            // Best-effort — if we can't revert, the caller's applyEdits
            // will fail gracefully on oldText mismatch.
        }
    }

    // ─── Web Search ──────────────────────────────────────────────────────

    /**
     * Search the web using DuckDuckGo's Instant Answer API.
     * Returns a formatted string of results suitable for use as AI context.
     */
    async webSearch(query: string): Promise<string> {
        return new Promise((resolve) => {
            let settled = false;
            const done = (result: string) => {
                if (!settled) { settled = true; resolve(result); }
            };

            const encodedQuery = encodeURIComponent(query);
            const reqOpts: https.RequestOptions = {
                hostname: 'api.duckduckgo.com',
                port: 443,
                path: `/?q=${encodedQuery}&format=json&no_html=1&no_redirect=1&skip_disambig=1`,
                method: 'GET',
                headers: {
                    'User-Agent': 'DeepCode-VSCode-Extension/1.0',
                    'Accept': 'application/json',
                },
            };

            const req = https.request(reqOpts, (res: any) => {
                let data = '';
                res.on('data', (chunk: any) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const parts: string[] = [];

                        if (json.Answer) {
                            parts.push(`Answer: ${json.Answer}`);
                        }
                        if (json.AbstractText) {
                            parts.push(`Summary: ${json.AbstractText}`);
                            if (json.AbstractURL) {
                                parts.push(`Source: ${json.AbstractURL}`);
                            }
                        }
                        if (json.RelatedTopics && Array.isArray(json.RelatedTopics)) {
                            const topics = json.RelatedTopics
                                .filter((t: any) => t.Text)
                                .slice(0, 5)
                                .map((t: any) => `  • ${t.Text}`);
                            if (topics.length > 0) {
                                parts.push('Related:', ...topics);
                            }
                        }

                        done(parts.length > 0
                            ? parts.join('\n')
                            : `No instant results found for: "${query}"`);
                    } catch {
                        done(`Could not parse search results for: "${query}"`);
                    }
                });
            });

            req.setTimeout(5000, () => {
                done(`Search timed out for: "${query}"`);
                req.destroy();
            });

            req.on('error', () => done(`Search unavailable for: "${query}"`));
            req.end();
        });
    }

    // ─── LLM Call ────────────────────────────────────────────────────────

    /**
     * Convert an absolute file path to workspace-relative.
     */
    private getRelativePath(absolutePath: string): string {
        const workspaceRoot =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        if (workspaceRoot && absolutePath.startsWith(workspaceRoot)) {
            return absolutePath.slice(workspaceRoot.length + 1);
        }
        return absolutePath;
    }

    /**
     * Map an AgentLoopResult to the backward-compatible OrchestratedResponse.
     */
    private mapToOrchestratedResponse(
        result: AgentLoopResult,
    ): OrchestratedResponse {
        return {
            content: result.content,
            agentResults: [{
                role: 'logic' as AgentRole,
                content: result.content,
                tokens: result.totalTokens,
            }],
            totalTokens: result.totalTokens,
            agentsUsed: this.inferAgentsUsed(result),
        };
    }

    /**
     * Infer which "agent roles" were used based on the tool calls made
     * during the agentic loop. Maps tool names to legacy role categories
     * for backward compatibility with the UI.
     */
    private inferAgentsUsed(result: AgentLoopResult): AgentRole[] {
        const roles: Set<AgentRole> = new Set(['logic']);

        for (const tc of result.toolCalls) {
            switch (tc.name) {
                case 'edit_file':
                case 'write_file':
                    roles.add('patterns');
                    break;
                case 'grep_search':
                case 'search_files':
                case 'read_file':
                    roles.add('backend');
                    break;
                case 'run_command':
                case 'get_diagnostics':
                    roles.add('frontend');
                    break;
            }
        }

        if (result.subAgentResults.length > 0) {
            roles.add('frontend');
        }

        return Array.from(roles);
    }

    /**
     * Truncate a string, appending "..." if it exceeds maxLength.
     */
    private truncate(text: string, maxLength: number): string {
        if (text.length <= maxLength) { return text; }
        return text.substring(0, maxLength - 3) + '...';
    }

    /**
     * Check if two file paths refer to the same file.
     * Handles relative vs absolute, trailing slashes, etc.
     */
    private pathsMatch(pathA: string, pathB: string): boolean {
        if (!pathA || !pathB) { return false; }
        const normalize = (p: string) =>
            p.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
        const a = normalize(pathA);
        const b = normalize(pathB);
        return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
    }
}
