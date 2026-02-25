/**
 * Progressive Memory Service for DeepCode
 *
 * Maintains a persistent, evolving "project memory" that grows smarter
 * with each interaction. Stored as `.deepcode/memory.json` in the workspace.
 *
 * Features:
 *   - Project summary (tech stack, architecture, conventions)
 *   - Key file registry with content hashes (detect changes)
 *   - Learned patterns and conventions from past interactions
 *   - Interaction log for context continuity
 *   - Auto-update after each agent loop run
 *   - Compact serialization to minimize token usage
 *
 * The memory is injected into the system prompt so the agent starts
 * each conversation with deep project understanding instead of
 * re-exploring from scratch.
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
    interactionLog: InteractionEntry[];
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

export interface InteractionEntry {
    timestamp: string;
    summary: string;
    toolsUsed: string[];
    filesModified: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MEMORY_DIR = '.deepcode';
const MEMORY_FILE = '.deepcode/memory.json';
const MAX_INTERACTIONS = 50;
const MAX_CONVENTIONS = 30;
const MAX_PATTERNS = 30;
const MAX_KEY_FILES = 40;
const MAX_ARCHITECTURE_NOTES = 20;

// ─── Default empty memory ────────────────────────────────────────────────────

function createEmptyMemory(): ProjectMemory {
    return {
        version: 1,
        lastUpdated: new Date().toISOString(),
        projectSummary: '',
        techStack: [],
        architecture: [],
        keyFiles: [],
        conventions: [],
        learnedPatterns: [],
        interactionLog: [],
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
     * Load memory from disk. Returns empty memory if none exists.
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
            // Validate structure
            if (parsed && typeof parsed === 'object' && parsed.version) {
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
     * Save memory to disk.
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

        const memUri = vscode.Uri.file(path.join(this.workspaceRoot, MEMORY_FILE));
        const json = JSON.stringify(this.memory, null, 2);
        await vscode.workspace.fs.writeFile(memUri, Buffer.from(json, 'utf-8'));
    }

    // ── Context Injection ────────────────────────────────────────────────

    /**
     * Build a compact context string from memory to inject into the system prompt.
     * Designed to give the agent instant project understanding.
     */
    async getMemoryContext(): Promise<string> {
        const mem = await this.load();

        // Empty memory — nothing to inject
        if (!mem.projectSummary && mem.keyFiles.length === 0 && mem.techStack.length === 0) {
            return '';
        }

        const parts: string[] = [];
        parts.push('## 🧠 Project Memory (persistent across sessions)\n');

        if (mem.projectSummary) {
            parts.push(`**Summary:** ${mem.projectSummary}\n`);
        }

        if (mem.techStack.length > 0) {
            parts.push(`**Tech Stack:** ${mem.techStack.join(', ')}\n`);
        }

        if (mem.architecture.length > 0) {
            parts.push('**Architecture:**');
            for (const note of mem.architecture.slice(0, 10)) {
                parts.push(`- **${note.component}**: ${note.description} (${note.files.join(', ')})`);
            }
            parts.push('');
        }

        if (mem.keyFiles.length > 0) {
            parts.push('**Key Files:**');
            for (const kf of mem.keyFiles.slice(0, 15)) {
                const changed = await this.hasFileChanged(kf.path, kf.lastHash);
                const marker = changed ? ' ⚠️ CHANGED' : '';
                parts.push(`- \`${kf.path}\`: ${kf.purpose}${marker}`);
            }
            parts.push('');
        }

        if (mem.conventions.length > 0) {
            parts.push('**Conventions:**');
            for (const c of mem.conventions.slice(0, 10)) {
                parts.push(`- ${c}`);
            }
            parts.push('');
        }

        if (mem.learnedPatterns.length > 0) {
            parts.push('**Learned Patterns:**');
            for (const p of mem.learnedPatterns.slice(0, 10)) {
                parts.push(`- ${p}`);
            }
            parts.push('');
        }

        if (mem.interactionLog.length > 0) {
            const recent = mem.interactionLog.slice(-5);
            parts.push('**Recent Interactions:**');
            for (const entry of recent) {
                const date = new Date(entry.timestamp).toLocaleDateString();
                parts.push(`- ${date}: ${entry.summary}`);
            }
            parts.push('');
        }

        return parts.join('\n');
    }

    // ── Update Operations ────────────────────────────────────────────────

    /**
     * Update memory after an agent interaction.
     * Called automatically at the end of each agent loop run.
     */
    async updateFromInteraction(
        userMessage: string,
        agentResponse: string,
        toolCalls: Array<{ name: string; args: Record<string, any>; result: string; success: boolean }>,
        subAgentResults: Array<{ task: string; content: string }>,
    ): Promise<void> {
        const mem = await this.load();

        // 1. Log the interaction
        const filesModified = toolCalls
            .filter(tc => (tc.name === 'write_file' || tc.name === 'edit_file') && tc.success)
            .map(tc => tc.args.path as string)
            .filter(Boolean);

        const toolsUsed = [...new Set(toolCalls.map(tc => tc.name))];

        const summary = this.summarizeInteraction(userMessage, toolsUsed, filesModified);

        mem.interactionLog.push({
            timestamp: new Date().toISOString(),
            summary,
            toolsUsed,
            filesModified,
        });

        // Trim old interactions
        if (mem.interactionLog.length > MAX_INTERACTIONS) {
            mem.interactionLog = mem.interactionLog.slice(-MAX_INTERACTIONS);
        }

        // 2. Update file hashes for modified files
        for (const fp of filesModified) {
            const hash = await this.hashFile(fp);
            if (hash) {
                mem.fileHashes[fp] = hash;
            }
        }

        // 3. Auto-discover key files from tool calls
        const filesRead = toolCalls
            .filter(tc => tc.name === 'read_file' && tc.success)
            .map(tc => tc.args.path as string)
            .filter(Boolean);

        for (const fp of filesRead) {
            if (!mem.keyFiles.find(kf => kf.path === fp)) {
                const purpose = this.inferFilePurpose(fp, toolCalls);
                const hash = await this.hashFile(fp);
                if (hash) {
                    mem.keyFiles.push({
                        path: fp,
                        purpose,
                        exports: [],
                        lastHash: hash,
                    });
                }
            }
        }

        // Trim key files
        if (mem.keyFiles.length > MAX_KEY_FILES) {
            mem.keyFiles = mem.keyFiles.slice(-MAX_KEY_FILES);
        }

        // 4. Extract conventions and patterns from the response
        this.extractPatterns(mem, agentResponse, toolCalls);

        // 5. Auto-detect tech stack if not yet populated
        if (mem.techStack.length === 0) {
            const detectedStack = await this.detectTechStack();
            if (detectedStack.length > 0) {
                mem.techStack = detectedStack;
            }
        }

        // 6. Auto-generate project summary if empty
        if (!mem.projectSummary && mem.keyFiles.length >= 3) {
            mem.projectSummary = await this.generateProjectSummary(mem);
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

    private summarizeInteraction(
        userMessage: string,
        toolsUsed: string[],
        filesModified: string[],
    ): string {
        const msg = userMessage.substring(0, 80).replace(/\n/g, ' ');
        const parts = [msg];
        if (filesModified.length > 0) {
            parts.push(`modified: ${filesModified.join(', ')}`);
        }
        if (toolsUsed.length > 0) {
            parts.push(`tools: ${toolsUsed.join(', ')}`);
        }
        return parts.join(' | ');
    }

    private inferFilePurpose(
        filePath: string,
        toolCalls: Array<{ name: string; args: Record<string, any>; result: string }>,
    ): string {
        const ext = path.extname(filePath);
        const name = path.basename(filePath, ext);

        // Heuristic purpose inference
        if (name.includes('test') || name.includes('spec')) { return 'Test file'; }
        if (name === 'package' && ext === '.json') { return 'Package manifest'; }
        if (name === 'tsconfig' || name === 'jsconfig') { return 'TypeScript/JS config'; }
        if (name.includes('config') || name.includes('rc')) { return 'Configuration'; }
        if (name === 'index' || name === 'main' || name === 'app') { return 'Entry point'; }
        if (name.includes('service') || name.includes('Service')) { return 'Service module'; }
        if (name.includes('controller') || name.includes('Controller')) { return 'Controller'; }
        if (name.includes('model') || name.includes('Model')) { return 'Data model'; }
        if (name.includes('util') || name.includes('helper')) { return 'Utility module'; }
        if (name.includes('type') || name.includes('interface')) { return 'Type definitions'; }
        if (name.includes('route') || name.includes('router')) { return 'Routing'; }
        if (name.includes('middleware')) { return 'Middleware'; }
        if (name.includes('component') || name.includes('Component')) { return 'UI component'; }
        if (name.includes('hook') || name.includes('use')) { return 'React hook'; }
        if (name.includes('store') || name.includes('reducer')) { return 'State management'; }
        if (ext === '.css' || ext === '.scss' || ext === '.less') { return 'Styles'; }
        if (ext === '.md') { return 'Documentation'; }
        if (name === 'Dockerfile' || name === 'docker-compose') { return 'Docker config'; }

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

    private async generateProjectSummary(mem: ProjectMemory): Promise<string> {
        const parts: string[] = [];

        if (mem.techStack.length > 0) {
            parts.push(`${mem.techStack.join(', ')} project`);
        }

        if (mem.keyFiles.length > 0) {
            parts.push(`with ${mem.keyFiles.length} key files analyzed`);
        }

        if (mem.architecture.length > 0) {
            const components = mem.architecture.map(a => a.component).join(', ');
            parts.push(`components: ${components}`);
        }

        return parts.join(' — ') || 'Project analyzed';
    }
}
