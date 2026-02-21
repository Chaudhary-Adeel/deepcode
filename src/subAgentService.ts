import * as https from 'https';

/**
 * Sub-Agent Service for DeepCode — v2
 *
 * Architecture (inspired by Claude Code internals):
 *   Single deeply-instructed prompt with chain-of-thought reasoning.
 *   No multi-agent routing overhead — one focused, powerful call per task.
 *
 *   For edits:
 *     1. Analyze phase: understand the code, plan changes
 *     2. Execute phase: produce minimal surgical diffs
 *     3. Validate phase: verify oldText matches exist in the file
 *     4. Retry on malformed output (up to 2 retries)
 *
 *   For chat:
 *     1. Single call with comprehensive system prompt
 *     2. Chain-of-thought reasoning before answering
 *     3. Context-aware responses using smart compression
 */

const DEEPSEEK_API_BASE = 'api.deepseek.com';

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
}

interface LLMCallOptions {
    apiKey: string;
    model: string;
    system: string;
    user: string;
    temperature: number;
    maxTokens: number;
    topP: number;
}

// ─── System Prompts ─────────────────────────────────────────────────────────

const CHAT_SYSTEM_PROMPT = `You are DeepCode — a principal-level software engineer embedded in VS Code. You have deep expertise across the entire stack: systems programming, web development, distributed systems, compilers, databases, DevOps, and security.

## How You Think

Before responding to ANY request, silently perform this analysis:

1. **Classify the request**: Is the user asking you to explain, review, fix, create, refactor, debug, or analyze?
2. **Understand the context**: What language, framework, patterns, and conventions are present? What's the broader architecture?
3. **Identify what matters**: What are the key correctness concerns, edge cases, performance implications, and security risks?
4. **Plan your response**: What's the most direct, helpful answer?

## Response Rules

- **Lead with the answer.** The first sentence should directly address what the user asked.
- **Be surgical.** Only discuss what's relevant. No filler, no preamble, no "Great question!" or "Sure, I can help!"
- **Show, don't tell.** Use code examples over lengthy explanations.
- **Be precise.** Name the exact patterns, algorithms, complexity classes, and principles you reference.
- **Flag risks proactively.** If you see security vulnerabilities (injection, XSS, auth issues, secrets exposure), race conditions, memory leaks, or O(n²) where O(n) is possible — say so immediately, even if the user didn't ask.
- **Respect existing code style.** When suggesting changes, match the project's naming conventions, import style, error handling patterns, and formatting.
- **Never hallucinate.** If you're unsure whether an API, method, or library feature exists, say so explicitly. Never invent function signatures.

## For Code Review / Analysis

When reviewing or analyzing code:
- Check correctness first (bugs, logic errors, edge cases, off-by-one, null handling)
- Then check security (injection, XSS, auth, secrets, CSRF, race conditions)
- Then check performance (unnecessary allocations, N+1 queries, redundant computation, complexity)
- Then check design (SOLID violations, code smells, coupling, naming, abstractions)
- Prioritize findings by severity: bugs > security > performance > design

## For Debugging

When debugging:
- Reason step by step: reproduce mentally → isolate root cause → propose targeted fix → verify no regressions
- Distinguish symptoms from root causes. Fix the disease, not the symptom.
- When multiple solutions exist, briefly present tradeoffs and recommend the best one.

## For Code Generation

When generating code:
- Match existing project patterns exactly (imports, error handling, naming, formatting)
- Production-grade: proper error handling, edge case coverage, type safety
- Comments only where logic is non-obvious — never comment the self-evident
- Prefer simple, readable code over clever abstractions

## Format

- Use markdown for structure when helpful (headers, bullets, code blocks)
- For code changes, show clear before/after or the minimal diff
- Keep responses concise — aim for the minimum text that fully answers the question`;

const EDIT_SYSTEM_PROMPT = `You are DeepCode — an expert code editor that produces precise, minimal, surgical edits. You think carefully before making changes and understand the full implications of every edit.

## Your Process

For every edit request, follow these steps IN ORDER:

### Step 1: Analyze
- Read the full file carefully. Understand its structure, imports, exports, dependencies.
- Identify the exact scope of change needed. What MUST change? What must NOT change?
- Consider: Will this edit break any callers? Any imports? Any types? Any tests?

### Step 2: Plan
- Determine the MINIMAL set of edits to achieve the goal.
- Each edit should be as small and precise as possible.
- Prefer fewer edits. If you can achieve the goal with 1 edit instead of 3, use 1.
- NEVER rewrite code that doesn't need to change.

### Step 3: Execute
- Each \`oldText\` MUST be an EXACT character-for-character substring of the original file. This includes whitespace, indentation, newlines, semicolons — everything.
- Each \`newText\` should preserve the surrounding code's style (indentation, naming, formatting).
- If adding new code, use an \`oldText\` that captures a unique anchor point (like the line before or after where you want to insert).

### Step 4: Verify
- Mentally apply each edit to the file and check: Does the result compile? Does it do what was asked? Did it break anything?

## Output Format

You MUST respond ONLY with this JSON (no markdown fences, no explanation outside the JSON):
{
  "edits": [
    {
      "oldText": "exact text from the original file",
      "newText": "replacement text"
    }
  ],
  "explanation": "Brief explanation of what was changed and why"
}

## Critical Rules

- oldText must be VERBATIM from the file — copy it exactly, including all whitespace and punctuation
- Each oldText must be unique in the file (if not, include more surrounding context to make it unique)
- Do NOT include the entire file — only the specific sections that need to change
- Do NOT add unnecessary changes (extra comments, reformatting untouched code, etc.)
- If the instruction is ambiguous, make the safest minimal interpretation
- If the instruction would introduce a bug or security issue, fix that too and mention it in the explanation`;

const EDIT_RETRY_PROMPT = `Your previous edit response had issues. The following oldText values were NOT found in the file:

{MISSING_TEXTS}

This means those edits cannot be applied. Common causes:
- Extra/missing whitespace or indentation
- Missing or extra newlines
- Slightly different punctuation or variable names
- The text was modified by a previous edit in the same response

Please re-read the original file content carefully and produce corrected edits. Remember: oldText must be a VERBATIM character-for-character match from the original file.

Respond with the corrected JSON only.`;

// ─── Service Implementation ─────────────────────────────────────────────────

export class SubAgentService {
    /**
     * Handle a chat message — single focused call with chain-of-thought.
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
        onStatus?.('Analyzing...');
        if (checkCancelled?.()) { throw new Error('Cancelled'); }

        const compactContext = context
            ? this.buildSmartContext(context, 12000)
            : '';

        const userPrompt = compactContext
            ? `${compactContext}\n\n---\n\n${userMessage}`
            : userMessage;

        onStatus?.('Generating response...');
        const result = await this.llmCall({
            apiKey,
            model,
            system: CHAT_SYSTEM_PROMPT,
            user: userPrompt,
            temperature,
            maxTokens: 8192,
            topP,
        });

        if (checkCancelled?.()) { throw new Error('Cancelled'); }

        return {
            content: result.content,
            agentResults: [{
                role: 'logic' as AgentRole,
                content: result.content,
                tokens: result.tokens,
            }],
            totalTokens: result.tokens,
            agentsUsed: ['logic'],
        };
    }

    /**
     * Handle an edit request — analyze, produce edits, validate, retry if needed.
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
        onStatus?.('Analyzing code...');
        if (checkCancelled?.()) { throw new Error('Cancelled'); }

        // Build a rich user prompt with file structure awareness
        const userPrompt = this.buildEditPrompt(fileContent, fileName, instruction, selectedText);

        onStatus?.('Planning edits...');
        let result = await this.llmCall({
            apiKey,
            model,
            system: EDIT_SYSTEM_PROMPT,
            user: userPrompt,
            temperature: Math.min(temperature, 0.1), // Keep edits deterministic
            maxTokens: 8192,
            topP,
        });

        if (checkCancelled?.()) { throw new Error('Cancelled'); }

        // Validate and retry if needed (up to 2 retries)
        // Catches both invalid JSON and missing oldText values.
        let finalContent = result.content;
        let totalTokens = result.tokens;

        for (let attempt = 0; attempt < 2; attempt++) {
            const validation = this.validateEditResponse(finalContent, fileContent);
            if (validation.valid) { break; }

            onStatus?.(`Fixing edit accuracy (attempt ${attempt + 1})...`);

            // Build a clear retry prompt explaining the issue
            let retryPrompt: string;
            if (validation.missingTexts.includes('[Invalid JSON in response]') ||
                validation.missingTexts.includes('[Response missing "edits" array]')) {
                // JSON parse failure — the model returned non-JSON
                retryPrompt = `Your previous response was NOT valid JSON. You returned:\n\n${finalContent.substring(0, 300)}\n\nYou MUST respond ONLY with a JSON object in this exact format (NO markdown, NO explanations, NO code blocks unless they are inside the JSON):\n{\n  "edits": [\n    { "oldText": "exact text from file", "newText": "replacement text" }\n  ],\n  "explanation": "what was changed"\n}\n\nRespond with ONLY the JSON object.`;
            } else {
                retryPrompt = EDIT_RETRY_PROMPT.replace(
                    '{MISSING_TEXTS}',
                    validation.missingTexts.map((t, i) => `${i + 1}. "${t.substring(0, 100)}${t.length > 100 ? '...' : ''}"`).join('\n')
                );
            }

            const retryResult = await this.llmCall({
                apiKey,
                model,
                system: EDIT_SYSTEM_PROMPT,
                user: `${userPrompt}\n\n---\n\nPREVIOUS ATTEMPT (had errors):\n${finalContent}\n\n${retryPrompt}`,
                temperature: 0,
                maxTokens: 8192,
                topP,
            });

            finalContent = retryResult.content;
            totalTokens += retryResult.tokens;

            if (checkCancelled?.()) { throw new Error('Cancelled'); }
        }

        onStatus?.('Done');

        return {
            content: finalContent,
            agentResults: [{
                role: 'logic' as AgentRole,
                content: finalContent,
                tokens: totalTokens,
            }],
            totalTokens,
            agentsUsed: ['logic', 'patterns'],
        };
    }

    // ─── Context Building ────────────────────────────────────────────────

    /**
     * Smart context compression that preserves code structure.
     * Instead of naive head/tail truncation, this:
     *   1. Preserves import/require blocks fully
     *   2. Preserves function/class signatures
     *   3. Preserves the focused region (selected text area)
     *   4. Truncates function bodies intelligently
     */
    private buildSmartContext(text: string, maxChars: number): string {
        if (text.length <= maxChars) { return text; }

        const lines = text.split('\n');
        const sections: { text: string; priority: number }[] = [];

        let currentSection = '';
        let currentPriority = 1; // default priority

        for (const line of lines) {
            const trimmed = line.trim();

            // High priority: imports, exports, type definitions
            if (/^(import |export |require\(|from |type |interface |enum )/.test(trimmed)) {
                if (currentSection) {
                    sections.push({ text: currentSection, priority: currentPriority });
                    currentSection = '';
                }
                currentPriority = 3;
            }
            // Medium priority: function/class/method signatures
            else if (/^(export )?(async )?(function |class |const \w+ = |let \w+ = |var \w+ = )/.test(trimmed) ||
                     /^(public |private |protected |static |abstract |override )/.test(trimmed)) {
                if (currentSection) {
                    sections.push({ text: currentSection, priority: currentPriority });
                    currentSection = '';
                }
                currentPriority = 2;
            }
            // Low priority: everything else
            else if (currentPriority > 1 && trimmed === '') {
                sections.push({ text: currentSection, priority: currentPriority });
                currentSection = '';
                currentPriority = 1;
            }

            currentSection += line + '\n';
        }

        if (currentSection) {
            sections.push({ text: currentSection, priority: currentPriority });
        }

        // Build result from highest priority sections first
        sections.sort((a, b) => b.priority - a.priority);

        let result = '';
        let remaining = maxChars;

        for (const section of sections) {
            if (section.text.length <= remaining) {
                result += section.text;
                remaining -= section.text.length;
            } else if (remaining > 200) {
                // Truncate this section but keep the start
                result += section.text.substring(0, remaining - 50);
                result += '\n// ... truncated ...\n';
                remaining = 0;
                break;
            }
        }

        return result || text.substring(0, maxChars);
    }

    /**
     * Build a rich edit prompt with structural awareness.
     */
    private buildEditPrompt(
        fileContent: string,
        fileName: string,
        instruction: string,
        selectedText: string | undefined,
    ): string {
        const ext = fileName.split('.').pop() || '';
        const lineCount = fileContent.split('\n').length;

        let prompt = `## File: ${fileName} (${lineCount} lines, .${ext})\n\n`;
        prompt += `## Instruction: ${instruction}\n\n`;

        if (selectedText) {
            // Find the line numbers of the selected text
            const selStart = fileContent.indexOf(selectedText);
            if (selStart !== -1) {
                const linesBefore = fileContent.substring(0, selStart).split('\n').length;
                const selLines = selectedText.split('\n').length;
                prompt += `## Selected Code (lines ${linesBefore}-${linesBefore + selLines - 1}):\n`;
            } else {
                prompt += `## Selected Code:\n`;
            }
            prompt += '```\n' + selectedText + '\n```\n\n';
        }

        // For large files, add line numbers so the model can reference structure
        if (lineCount > 100) {
            const numberedContent = fileContent.split('\n')
                .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
                .join('\n');
            prompt += `## Full File (with line numbers for reference):\n\`\`\`\n${numberedContent}\n\`\`\`\n`;
        } else {
            prompt += `## Full File:\n\`\`\`\n${fileContent}\n\`\`\`\n`;
        }

        prompt += `\nRemember: oldText must be EXACT substrings from the file above. Do not include line numbers in oldText.`;

        return prompt;
    }

    // ─── Validation ──────────────────────────────────────────────────────

    /**
     * Validate that all oldText values in the edit response actually exist in the file.
     */
    private validateEditResponse(
        response: string,
        fileContent: string,
    ): { valid: boolean; missingTexts: string[] } {
        try {
            let jsonStr = response.trim();
            const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) { jsonStr = jsonMatch[1].trim(); }

            const parsed = JSON.parse(jsonStr);
            if (!parsed.edits || !Array.isArray(parsed.edits)) {
                return { valid: false, missingTexts: ['[Response missing "edits" array]'] };
            }

            const missing: string[] = [];
            for (const edit of parsed.edits) {
                if (!edit.oldText) { continue; } // Append-only edits are valid
                if (!fileContent.includes(edit.oldText)) {
                    missing.push(edit.oldText);
                }
            }

            return { valid: missing.length === 0, missingTexts: missing };
        } catch {
            return { valid: false, missingTexts: ['[Invalid JSON in response]'] };
        }
    }

    // ─── LLM Call ────────────────────────────────────────────────────────

    /**
     * Single LLM call — non-streaming, returns content + token count.
     */
    private llmCall(opts: LLMCallOptions): Promise<{ content: string; tokens: number }> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                model: opts.model,
                messages: [
                    { role: 'system', content: opts.system },
                    { role: 'user', content: opts.user },
                ],
                temperature: opts.temperature,
                max_tokens: opts.maxTokens,
                top_p: opts.topP,
                stream: false,
            });

            const reqOpts: https.RequestOptions = {
                hostname: DEEPSEEK_API_BASE,
                port: 443,
                path: '/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${opts.apiKey}`,
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(reqOpts, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        if (res.statusCode !== 200) {
                            const err = JSON.parse(data);
                            reject(new Error(err.error?.message || `API ${res.statusCode}`));
                            return;
                        }
                        const json = JSON.parse(data);
                        resolve({
                            content: json.choices?.[0]?.message?.content || '',
                            tokens: json.usage?.total_tokens || 0,
                        });
                    } catch (e) {
                        reject(new Error(`Parse error: ${e}`));
                    }
                });
            });

            req.on('error', (e) => reject(new Error(`Network: ${e.message}`)));
            req.write(body);
            req.end();
        });
    }
}
