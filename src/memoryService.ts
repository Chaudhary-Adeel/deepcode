/**
 * Progressive Memory Service for DeepCode — v2 (Rich Memory + TF-IDF)
 *
 * Maintains a persistent, evolving "project memory" that grows smarter
 * with each interaction. Stored as `.deepcode/memory.json` in the workspace.
 *
 * v2 Changes:
 *   - Rich interaction logging: stores user message, agent response,
 *     full tool call details with results, sub-agent summaries
 *   - TF-IDF based similarity search for retrieving relevant past
 *     interactions given the current query
 *   - Compact context builder that selects only the most relevant
 *     past interactions to inject into the prompt
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectMemory {
    version: number;
    lastUpdated: string;
    projectSummary: string;
    techStack: string[];
    architecture: ArchitectureNote[];
    keyFiles: KeyFileEntry[];
    conventions: string[];
    learnedPatterns: string[];
    interactions: RichInteraction[];
    fileHashes: Record<string, string>;
}

export interface ArchitectureNote {
    component: string;
    description: string;
    files: string[];
}

export interface KeyFileEntry {
    path: string;
    purpose: string;
    exports: string[];
    lastHash: string;
}

/** Rich interaction entry — stores full context of what happened */
export interface RichInteraction {
    id: string;
    timestamp: string;
    userMessage: string;
    agentResponse: string;
    toolCalls: ToolCallRecord[];
    subAgentSummaries: string[];
    filesRead: string[];
    filesModified: string[];
    searchQueries: string[];
    /** Pre-computed TF-IDF terms for fast similarity matching (optional, can be recomputed) */
    tfidfTerms?: Record<string, number>;
    /** Whether this interaction has been compacted (old entries get trimmed) */
    compacted?: boolean;
}

export interface ToolCallRecord {
    tool: string;
    args: Record<string, any>;
    result: string;
    success: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MEMORY_DIR = '.deepcode';
const MEMORY_FILE = '.deepcode/memory.json';
const MAX_INTERACTIONS = 50;
const MAX_CONVENTIONS = 20;
const MAX_PATTERNS = 20;
const MAX_KEY_FILES = 30;
const MAX_ARCHITECTURE_NOTES = 15;
/** Max chars of context to inject from memory into the prompt */
const MAX_MEMORY_CONTEXT_CHARS = 6000;
/** Max chars to store per tool result in memory */
const MAX_TOOL_RESULT_CHARS = 300;
/** Top-K most relevant past interactions to retrieve */
const TOP_K_INTERACTIONS = 5;
/** Max bytes for memory.json before aggressive compaction kicks in */
const MAX_MEMORY_FILE_BYTES = 512 * 1024; // 512 KB
/** After how many interactions do we compact old entries */
const COMPACT_THRESHOLD = 30;
/** Max chars for user message stored in interactions */
const MAX_USER_MSG_CHARS = 500;
/** Max chars for agent response stored in interactions */
const MAX_AGENT_RESPONSE_CHARS = 500;
/** Max tool calls stored per interaction */
const MAX_TOOL_CALLS_PER_INTERACTION = 8;

// ─── TF-IDF Engine ───────────────────────────────────────────────────────────

/**
 * Lightweight TF-IDF implementation for finding relevant past interactions.
 * No external dependencies — pure TypeScript.
 */
class TFIDFEngine {
    private static STOP_WORDS = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
        'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
        'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
        'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
        'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
        'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
        'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
        'just', 'because', 'but', 'and', 'or', 'if', 'while', 'that', 'this',
        'these', 'those', 'what', 'which', 'who', 'whom', 'it', 'its', 'i',
        'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she',
        'her', 'they', 'them', 'their', 'about', 'up', 'also',
    ]);

    /** Tokenize text: split camelCase, remove stop words, lowercase */
    static tokenize(text: string): string[] {
        const expanded = text
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/_/g, ' ')
            .replace(/[^a-zA-Z0-9\s./-]/g, ' ');
        return expanded.toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 1 && !this.STOP_WORDS.has(w));
    }

    /** Term frequency, normalized by max frequency */
    static termFrequency(terms: string[]): Record<string, number> {
        const tf: Record<string, number> = {};
        for (const term of terms) { tf[term] = (tf[term] || 0) + 1; }
        const maxFreq = Math.max(...Object.values(tf), 1);
        for (const term in tf) { tf[term] = tf[term] / maxFreq; }
        return tf;
    }

    /** Compute TF-IDF for a document against all docs */
    static computeTFIDF(docTerms: string[], allDocs: string[][]): Record<string, number> {
        const tf = this.termFrequency(docTerms);
        const n = allDocs.length;
        const tfidf: Record<string, number> = {};
        for (const term in tf) {
            const docsContaining = allDocs.filter(d => d.includes(term)).length;
            const idf = Math.log(n / (1 + docsContaining));
            tfidf[term] = tf[term] * idf;
        }
        return tfidf;
    }

    /** Cosine similarity between two TF-IDF vectors */
    static cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number {
        let dot = 0, normA = 0, normB = 0;
        const allTerms = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const term of allTerms) {
            const va = a[term] || 0, vb = b[term] || 0;
            dot += va * vb; normA += va * va; normB += vb * vb;
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }

    /** Build combined text from an interaction for indexing */
    static interactionToText(ix: RichInteraction): string {
        return [
            ix.userMessage,
            ix.agentResponse.substring(0, 500),
            ...ix.filesRead, ...ix.filesModified, ...ix.searchQueries,
            ...ix.toolCalls.map(tc => `${tc.tool} ${JSON.stringify(tc.args).substring(0, 100)}`),
        ].join(' ');
    }
}

// ─── Default empty memory ────────────────────────────────────────────────────

function createEmptyMemory(): ProjectMemory {
    return {
        version: 2,
        lastUpdated: new Date().toISOString(),
        projectSummary: '',
        techStack: [],
        architecture: [],
        keyFiles: [],
        conventions: [],
        learnedPatterns: [],
        interactions: [],
        fileHashes: {},
    };
}

// ─── Memory Service ──────────────────────────────────────────────────────────

export class MemoryService {
    private memory: ProjectMemory | null = null;
    private workspaceRoot: string;

    constructor() {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this.workspaceRoot = root || '';
    }

    // ── Load / Save ──────────────────────────────────────────────────────

    /**
     * Load memory from disk. Migrates v1 → v2 automatically.
     */
    async load(): Promise<ProjectMemory> {
        if (this.memory) { return this.memory; }
        if (!this.workspaceRoot) {
            this.memory = createEmptyMemory();
            return this.memory;
        }

        const memPath = path.join(this.workspaceRoot, MEMORY_FILE);
        const uri = vscode.Uri.file(memPath);

        try {
            const data = await vscode.workspace.fs.readFile(uri);
            const parsed = JSON.parse(Buffer.from(data).toString('utf-8'));
            if (parsed && typeof parsed === 'object' && parsed.version) {
                // Migrate v1 → v2
                if (parsed.version === 1 && parsed.interactionLog) {
                    parsed.version = 2;
                    parsed.interactions = (parsed.interactionLog || []).map((entry: any, i: number) => ({
                        id: `migrated-${i}`,
                        timestamp: entry.timestamp || new Date().toISOString(),
                        userMessage: entry.summary || '',
                        agentResponse: '',
                        toolCalls: (entry.toolsUsed || []).map((t: string) => ({ tool: t, args: {}, result: '', success: true })),
                        subAgentSummaries: [],
                        filesRead: [],
                        filesModified: entry.filesModified || [],
                        searchQueries: [],
                        tfidfTerms: {},
                    }));
                    delete parsed.interactionLog;
                }
                this.memory = parsed as ProjectMemory;
                return this.memory;
            }
        } catch {
            // File doesn't exist or is corrupt — start fresh
        }

        this.memory = createEmptyMemory();
        return this.memory;
    }

    /**
     * Save memory to disk. Enforces file size limits.
     */
    async save(): Promise<void> {
        if (!this.memory || !this.workspaceRoot) { return; }

        this.memory.lastUpdated = new Date().toISOString();

        // Ensure .deepcode directory exists
        const dirUri = vscode.Uri.file(path.join(this.workspaceRoot, MEMORY_DIR));
        try {
            await vscode.workspace.fs.stat(dirUri);
        } catch {
            await vscode.workspace.fs.createDirectory(dirUri);
        }

        // Compact old interactions to keep file size manageable
        this.compactOldInteractions();

        let json = JSON.stringify(this.memory, null, 2);

        // If still too large, aggressively prune
        if (Buffer.byteLength(json, 'utf-8') > MAX_MEMORY_FILE_BYTES) {
            this.aggressivePrune();
            json = JSON.stringify(this.memory, null, 2);
        }

        const memUri = vscode.Uri.file(path.join(this.workspaceRoot, MEMORY_FILE));
        await vscode.workspace.fs.writeFile(memUri, Buffer.from(json, 'utf-8'));
    }

    /**
     * Compact old interactions — strip TF-IDF terms, trim responses,
     * and reduce tool call details for interactions beyond the compact threshold.
     */
    private compactOldInteractions(): void {
        if (!this.memory?.interactions) { return; }
        const total = this.memory.interactions.length;
        if (total <= COMPACT_THRESHOLD) { return; }

        // Keep the last COMPACT_THRESHOLD interactions full; compact the rest
        const cutoff = total - COMPACT_THRESHOLD;
        for (let i = 0; i < cutoff; i++) {
            const ix = this.memory.interactions[i];
            if (ix.compacted) { continue; }

            // Strip TF-IDF (will be recomputed on demand)
            delete ix.tfidfTerms;

            // Trim stored text
            ix.userMessage = ix.userMessage.substring(0, 200);
            ix.agentResponse = ix.agentResponse.substring(0, 200);

            // Keep only tool names, drop args and results
            ix.toolCalls = ix.toolCalls.slice(0, 5).map(tc => ({
                tool: tc.tool,
                args: {},
                result: '',
                success: tc.success,
            }));

            ix.subAgentSummaries = ix.subAgentSummaries.slice(0, 2).map(s => s.substring(0, 100));
            ix.searchQueries = ix.searchQueries.slice(0, 3);
            ix.compacted = true;
        }
    }

    /**
     * Aggressive pruning when file size exceeds limits.
     * Drops the oldest half of interactions entirely.
     */
    private aggressivePrune(): void {
        if (!this.memory?.interactions) { return; }
        const half = Math.ceil(this.memory.interactions.length / 2);
        this.memory.interactions = this.memory.interactions.slice(half);

        // Also trim other growing collections
        if (this.memory.keyFiles.length > 20) {
            this.memory.keyFiles = this.memory.keyFiles.slice(-20);
        }
        if (this.memory.learnedPatterns.length > 15) {
            this.memory.learnedPatterns = this.memory.learnedPatterns.slice(-15);
        }

        // Strip remaining TF-IDF terms
        for (const ix of this.memory.interactions) {
            delete ix.tfidfTerms;
        }
    }

    // ── Context Injection ────────────────────────────────────────────────

    /**
     * Build a compact context string from memory with TF-IDF relevance ranking.
     * Finds the most relevant past interactions for the current query.
     */
    async getMemoryContext(currentQuery?: string): Promise<string> {
        const mem = await this.load();

        if (
            !mem.projectSummary &&
            mem.keyFiles.length === 0 &&
            mem.techStack.length === 0 &&
            (!mem.interactions || mem.interactions.length === 0)
        ) {
            return '';
        }

        const parts: string[] = [];
        parts.push('## Project Memory (persistent)\n');

        if (mem.projectSummary) {
            parts.push(`**Summary:** ${mem.projectSummary}\n`);
        }
        if (mem.techStack.length > 0) {
            parts.push(`**Tech Stack:** ${mem.techStack.join(', ')}\n`);
        }
        if (mem.architecture.length > 0) {
            parts.push('**Architecture:**');
            for (const note of mem.architecture.slice(0, 8)) {
                parts.push(`- **${note.component}**: ${note.description} (${note.files.join(', ')})`);
            }
            parts.push('');
        }
        if (mem.keyFiles.length > 0) {
            parts.push('**Key Files:**');
            for (const kf of mem.keyFiles.slice(0, 12)) {
                const changed = await this.hasFileChanged(kf.path, kf.lastHash);
                const marker = changed ? ' [CHANGED]' : '';
                parts.push(`- \`${kf.path}\`: ${kf.purpose}${marker}`);
            }
            parts.push('');
        }
        if (mem.conventions.length > 0) {
            parts.push('**Conventions:** ' + mem.conventions.slice(0, 8).join('; ') + '\n');
        }

        // ── Relevant Past Interactions (TF-IDF ranked) ──
        if (mem.interactions && mem.interactions.length > 0 && currentQuery) {
            const relevant = this.findRelevantInteractions(currentQuery, mem.interactions);
            if (relevant.length > 0) {
                parts.push('**Relevant Past Interactions:**');
                let charBudget = MAX_MEMORY_CONTEXT_CHARS - parts.join('\n').length;

                for (const { interaction, score } of relevant) {
                    if (charBudget <= 200) { break; }
                    const date = new Date(interaction.timestamp).toLocaleDateString();
                    let entry = `\n[${date} | relevance: ${(score * 100).toFixed(0)}%]\n`;
                    entry += `Q: ${interaction.userMessage.substring(0, 200)}\n`;
                    if (interaction.agentResponse) {
                        entry += `A: ${interaction.agentResponse.substring(0, 300)}\n`;
                    }
                    if (interaction.toolCalls.length > 0) {
                        const toolSummary = interaction.toolCalls.slice(0, 5)
                            .map(tc => {
                                const argsStr = this.compactArgs(tc.args);
                                const resultStr = tc.result.substring(0, 150);
                                return `  ${tc.tool}(${argsStr}) -> ${tc.success ? 'ok' : 'fail'} ${resultStr}`;
                            }).join('\n');
                        entry += `Tools:\n${toolSummary}\n`;
                    }
                    if (interaction.filesModified.length > 0) {
                        entry += `Modified: ${interaction.filesModified.join(', ')}\n`;
                    }
                    if (interaction.filesRead.length > 0) {
                        entry += `Read: ${interaction.filesRead.slice(0, 5).join(', ')}\n`;
                    }
                    if (entry.length > charBudget) {
                        entry = entry.substring(0, charBudget - 3) + '...';
                    }
                    parts.push(entry);
                    charBudget -= entry.length;
                }
                parts.push('');
            }
        } else if (mem.interactions && mem.interactions.length > 0) {
            const recent = mem.interactions.slice(-3);
            parts.push('**Recent Interactions:**');
            for (const ix of recent) {
                const date = new Date(ix.timestamp).toLocaleDateString();
                const tc = ix.toolCalls.length;
                const fc = ix.filesRead.length + ix.filesModified.length;
                parts.push(`- ${date}: ${ix.userMessage.substring(0, 100)} (${tc} tools, ${fc} files)`);
            }
            parts.push('');
        }

        return parts.join('\n');
    }

    // ── TF-IDF Similarity Search ─────────────────────────────────────────

    /**
     * Find the most relevant past interactions for a given query using TF-IDF.
     */
    private findRelevantInteractions(
        query: string,
        interactions: RichInteraction[],
    ): Array<{ interaction: RichInteraction; score: number }> {
        if (interactions.length === 0) { return []; }

        const queryTerms = TFIDFEngine.tokenize(query);
        if (queryTerms.length === 0) { return []; }

        const allDocTerms = interactions.map(ix =>
            TFIDFEngine.tokenize(TFIDFEngine.interactionToText(ix))
        );
        allDocTerms.push(queryTerms);

        const queryTFIDF = TFIDFEngine.computeTFIDF(queryTerms, allDocTerms);

        const scored = interactions.map((interaction, i) => {
            // Always recompute TF-IDF on demand (no longer stored inline)
            const docTFIDF = TFIDFEngine.computeTFIDF(allDocTerms[i], allDocTerms);
            const score = TFIDFEngine.cosineSimilarity(queryTFIDF, docTFIDF);
            return { interaction, score };
        });

        return scored
            .filter(s => s.score > 0.05)
            .sort((a, b) => b.score - a.score)
            .slice(0, TOP_K_INTERACTIONS);
    }

    // ── Update Operations ────────────────────────────────────────────────

    /**
     * Update memory after an agent interaction with FULL details:
     * user message, agent response, all tool calls with results,
     * sub-agent outputs, files touched.
     */
    async updateFromInteraction(
        userMessage: string,
        agentResponse: string,
        toolCalls: Array<{ name: string; args: Record<string, any>; result: string; success: boolean }>,
        subAgentResults: Array<{ task: string; content: string }>,
    ): Promise<void> {
        const mem = await this.load();

        // Extract file lists
        const filesModified = toolCalls
            .filter(tc => (tc.name === 'write_file' || tc.name === 'edit_file') && tc.success)
            .map(tc => tc.args.path as string)
            .filter(Boolean);

        const filesRead = toolCalls
            .filter(tc => tc.name === 'read_file' && tc.success)
            .map(tc => tc.args.path as string)
            .filter(Boolean);

        const searchQueries = toolCalls
            .filter(tc => tc.name === 'grep_search' || tc.name === 'search_files' || tc.name === 'web_search')
            .map(tc => (tc.args.query || tc.args.pattern || '') as string)
            .filter(Boolean);

        // Build tool call records (truncate large results for storage)
        const toolRecords: ToolCallRecord[] = toolCalls.map(tc => ({
            tool: tc.name,
            args: this.compactToolArgs(tc.args),
            result: tc.result.substring(0, MAX_TOOL_RESULT_CHARS),
            success: tc.success,
        }));

        // Sub-agent summaries (trimmed for storage)
        const subAgentSummaries = subAgentResults.slice(0, 3).map(sa =>
            `[${sa.task.substring(0, 80)}]: ${sa.content.substring(0, 200)}`
        );

        const interaction: RichInteraction = {
            id: crypto.randomBytes(8).toString('hex'),
            timestamp: new Date().toISOString(),
            userMessage: userMessage.substring(0, MAX_USER_MSG_CHARS),
            agentResponse: agentResponse.substring(0, MAX_AGENT_RESPONSE_CHARS),
            toolCalls: toolRecords.slice(0, MAX_TOOL_CALLS_PER_INTERACTION),
            subAgentSummaries,
            filesRead: [...new Set(filesRead)],
            filesModified: [...new Set(filesModified)],
            searchQueries: searchQueries.slice(0, 5),
            // TF-IDF terms are NOT stored inline — recomputed on demand to save space
        };

        if (!mem.interactions) { mem.interactions = []; }
        mem.interactions.push(interaction);

        if (mem.interactions.length > MAX_INTERACTIONS) {
            mem.interactions = mem.interactions.slice(-MAX_INTERACTIONS);
        }

        // Update file hashes
        for (const fp of filesModified) {
            const hash = await this.hashFile(fp);
            if (hash) { mem.fileHashes[fp] = hash; }
        }

        // Auto-discover key files
        for (const fp of filesRead) {
            if (!mem.keyFiles.find(kf => kf.path === fp)) {
                const purpose = this.inferFilePurpose(fp);
                const hash = await this.hashFile(fp);
                if (hash) {
                    mem.keyFiles.push({ path: fp, purpose, exports: [], lastHash: hash });
                }
            }
        }
        if (mem.keyFiles.length > MAX_KEY_FILES) {
            mem.keyFiles = mem.keyFiles.slice(-MAX_KEY_FILES);
        }

        // Extract patterns
        this.extractPatterns(mem, agentResponse, toolCalls);

        // Auto-detect tech stack
        if (mem.techStack.length === 0) {
            mem.techStack = await this.detectTechStack();
        }

        // Auto-generate summary
        if (!mem.projectSummary && mem.keyFiles.length >= 3) {
            mem.projectSummary = this.generateProjectSummary(mem);
        }

        this.memory = mem;
        await this.save();
    }

    /**
     * Update project summary directly (can be called by the agent via memory tools).
     */
    async updateSummary(summary: string): Promise<void> {
        const mem = await this.load();
        mem.projectSummary = summary;
        this.memory = mem;
        await this.save();
    }

    /**
     * Add a convention that was discovered or established.
     */
    async addConvention(convention: string): Promise<void> {
        const mem = await this.load();
        if (!mem.conventions.includes(convention)) {
            mem.conventions.push(convention);
            if (mem.conventions.length > MAX_CONVENTIONS) {
                mem.conventions = mem.conventions.slice(-MAX_CONVENTIONS);
            }
        }
        this.memory = mem;
        await this.save();
    }

    /**
     * Add an architecture note.
     */
    async addArchitectureNote(component: string, description: string, files: string[]): Promise<void> {
        const mem = await this.load();
        const existing = mem.architecture.findIndex(a => a.component === component);
        if (existing >= 0) {
            mem.architecture[existing] = { component, description, files };
        } else {
            mem.architecture.push({ component, description, files });
            if (mem.architecture.length > MAX_ARCHITECTURE_NOTES) {
                mem.architecture = mem.architecture.slice(-MAX_ARCHITECTURE_NOTES);
            }
        }
        this.memory = mem;
        await this.save();
    }

    /**
     * Clear the entire memory (reset).
     */
    async clear(): Promise<void> {
        this.memory = createEmptyMemory();
        await this.save();
    }

    /**
     * Get a snapshot of current memory for diagnostic purposes.
     */
    async getSnapshot(): Promise<string> {
        const mem = await this.load();
        return JSON.stringify(mem, null, 2);
    }

    // ── Change Detection ─────────────────────────────────────────────────

    /**
     * Check if a file has changed since we last hashed it.
     */
    async hasFileChanged(filePath: string, storedHash: string): Promise<boolean> {
        const currentHash = await this.hashFile(filePath);
        if (!currentHash) { return false; } // Can't read — assume unchanged
        return currentHash !== storedHash;
    }

    /**
     * Get list of key files that have changed since last analysis.
     */
    async getChangedKeyFiles(): Promise<string[]> {
        const mem = await this.load();
        const changed: string[] = [];
        for (const kf of mem.keyFiles) {
            if (await this.hasFileChanged(kf.path, kf.lastHash)) {
                changed.push(kf.path);
            }
        }
        return changed;
    }

    // ── Private Helpers ──────────────────────────────────────────────────

    private async hashFile(filePath: string): Promise<string | null> {
        try {
            const fullPath = path.isAbsolute(filePath)
                ? filePath
                : path.join(this.workspaceRoot, filePath);
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
            return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
        } catch {
            return null;
        }
    }

    /** Compact tool args for storage — truncate large values */
    private compactToolArgs(args: Record<string, any>): Record<string, any> {
        const compact: Record<string, any> = {};
        for (const [key, value] of Object.entries(args)) {
            if (typeof value === 'string' && value.length > 200) {
                if (key === 'content' || key === 'newText' || key === 'oldText') {
                    compact[key] = `[${value.length} chars]`;
                } else {
                    compact[key] = value.substring(0, 200) + '...';
                }
            } else {
                compact[key] = value;
            }
        }
        return compact;
    }

    /** Compact args for display in context injection */
    private compactArgs(args: Record<string, any>): string {
        const parts: string[] = [];
        for (const [key, value] of Object.entries(args)) {
            const strVal = typeof value === 'string' ? value : JSON.stringify(value);
            if (strVal.length > 50) {
                parts.push(`${key}="${strVal.substring(0, 50)}..."`);
            } else {
                parts.push(`${key}="${strVal}"`);
            }
        }
        return parts.join(', ');
    }

    private inferFilePurpose(filePath: string): string {
        const ext = path.extname(filePath);
        const name = path.basename(filePath, ext);

        if (name.includes('test') || name.includes('spec')) { return 'Test file'; }
        if (name === 'package' && ext === '.json') { return 'Package manifest'; }
        if (name === 'tsconfig' || name === 'jsconfig') { return 'TS/JS config'; }
        if (name.includes('config') || name.includes('rc')) { return 'Configuration'; }
        if (name === 'index' || name === 'main' || name === 'app') { return 'Entry point'; }
        if (name.includes('service') || name.includes('Service')) { return 'Service module'; }
        if (name.includes('controller')) { return 'Controller'; }
        if (name.includes('model') || name.includes('Model')) { return 'Data model'; }
        if (name.includes('util') || name.includes('helper')) { return 'Utility'; }
        if (name.includes('type') || name.includes('interface')) { return 'Type definitions'; }
        if (name.includes('route') || name.includes('router')) { return 'Routing'; }
        if (name.includes('middleware')) { return 'Middleware'; }
        if (name.includes('component')) { return 'UI component'; }
        if (name.includes('hook') || name.includes('use')) { return 'React hook'; }
        if (name.includes('store') || name.includes('reducer')) { return 'State management'; }
        if (ext === '.css' || ext === '.scss') { return 'Styles'; }
        if (ext === '.md') { return 'Documentation'; }
        if (name === 'Dockerfile') { return 'Docker config'; }
        return `Source file (${ext})`;
    }

    private extractPatterns(
        mem: ProjectMemory,
        _response: string,
        toolCalls: Array<{ name: string; args: Record<string, any>; result: string; success: boolean }>,
    ): void {
        // Auto-detect patterns from tool calls
        const editCalls = toolCalls.filter(tc => tc.name === 'edit_file' && tc.success);

        for (const edit of editCalls) {
            const edits = edit.args.edits as Array<{ oldText: string; newText: string }> | undefined;
            if (!edits) { continue; }

            for (const e of edits) {
                // Detect import pattern additions
                if (e.newText.includes('import ') && !e.oldText.includes('import ')) {
                    const importMatch = e.newText.match(/import .+ from ['"]([^'"]+)['"]/);
                    if (importMatch) {
                        const pattern = `Uses ${importMatch[1]} imports`;
                        if (!mem.learnedPatterns.includes(pattern)) {
                            mem.learnedPatterns.push(pattern);
                        }
                    }
                }
            }
        }

        // Trim
        if (mem.learnedPatterns.length > MAX_PATTERNS) {
            mem.learnedPatterns = mem.learnedPatterns.slice(-MAX_PATTERNS);
        }
    }

    private async detectTechStack(): Promise<string[]> {
        const stack: string[] = [];

        const checks: Array<{ file: string; tech: string }> = [
            { file: 'package.json', tech: 'Node.js' },
            { file: 'tsconfig.json', tech: 'TypeScript' },
            { file: 'requirements.txt', tech: 'Python' },
            { file: 'Pipfile', tech: 'Python (Pipenv)' },
            { file: 'pyproject.toml', tech: 'Python' },
            { file: 'go.mod', tech: 'Go' },
            { file: 'Cargo.toml', tech: 'Rust' },
            { file: 'pom.xml', tech: 'Java (Maven)' },
            { file: 'build.gradle', tech: 'Java/Kotlin (Gradle)' },
            { file: 'Gemfile', tech: 'Ruby' },
            { file: 'composer.json', tech: 'PHP' },
            { file: '.csproj', tech: 'C# (.NET)' },
            { file: 'Dockerfile', tech: 'Docker' },
            { file: 'docker-compose.yml', tech: 'Docker Compose' },
            { file: '.github/workflows', tech: 'GitHub Actions' },
        ];

        for (const check of checks) {
            const fullPath = path.join(this.workspaceRoot, check.file);
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
                stack.push(check.tech);
            } catch {
                // File doesn't exist
            }
        }

        // Detect frameworks from package.json
        if (this.workspaceRoot) {
            try {
                const pkgPath = path.join(this.workspaceRoot, 'package.json');
                const data = await vscode.workspace.fs.readFile(vscode.Uri.file(pkgPath));
                const pkg = JSON.parse(Buffer.from(data).toString('utf-8'));
                const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

                if (allDeps['react']) { stack.push('React'); }
                if (allDeps['next']) { stack.push('Next.js'); }
                if (allDeps['vue']) { stack.push('Vue.js'); }
                if (allDeps['@angular/core']) { stack.push('Angular'); }
                if (allDeps['express']) { stack.push('Express'); }
                if (allDeps['fastify']) { stack.push('Fastify'); }
                if (allDeps['vscode']) { stack.push('VS Code Extension'); }
                if (allDeps['@vscode/vsce']) { stack.push('VS Code Extension'); }
                if (allDeps['electron']) { stack.push('Electron'); }
                if (allDeps['tailwindcss']) { stack.push('Tailwind CSS'); }
                if (allDeps['prisma']) { stack.push('Prisma'); }
                if (allDeps['mongoose']) { stack.push('MongoDB (Mongoose)'); }
                if (allDeps['jest']) { stack.push('Jest'); }
                if (allDeps['mocha']) { stack.push('Mocha'); }
                if (allDeps['vitest']) { stack.push('Vitest'); }
            } catch {
                // No package.json or unreadable
            }
        }

        return [...new Set(stack)];
    }

    private generateProjectSummary(mem: ProjectMemory): string {
        const parts: string[] = [];
        if (mem.techStack.length > 0) {
            parts.push(`${mem.techStack.join(', ')} project`);
        }
        if (mem.keyFiles.length > 0) {
            parts.push(`${mem.keyFiles.length} key files`);
        }
        if (mem.architecture.length > 0) {
            parts.push(`components: ${mem.architecture.map(a => a.component).join(', ')}`);
        }
        return parts.join(' — ') || 'Project analyzed';
    }
}
