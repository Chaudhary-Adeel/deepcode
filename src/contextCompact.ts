import { AgentMessage } from './agentLoop';

function findToolCallInfo(
    messages: AgentMessage[],
    toolCallId: string,
): { name: string; args: Record<string, any> } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'assistant' && msg.tool_calls) {
            const tc = msg.tool_calls.find((t) => t.id === toolCallId);
            if (tc) {
                let args: Record<string, any> = {};
                try {
                    args = JSON.parse(tc.function.arguments);
                } catch {}
                return { name: tc.function.name, args };
            }
        }
    }
    return null;
}

function compactToolResult(
    toolName: string,
    args: Record<string, any>,
    content: string,
): string {
    const lines = content.split('\n');

    switch (toolName) {
        case 'read_file': {
            const path = args.file_path || args.path || 'unknown';
            return `[read_file: ${path} — ${lines.length} lines]`;
        }
        case 'grep_search': {
            const query = args.query || args.pattern || 'unknown';
            const fileSet = new Set<string>();
            let matchCount = 0;
            for (const line of lines) {
                if (line.trim()) {
                    matchCount++;
                    const colonIdx = line.indexOf(':');
                    if (colonIdx > 0) {
                        fileSet.add(line.substring(0, colonIdx));
                    }
                }
            }
            return `[grep_search: '${query}' — ${matchCount} matches across ${fileSet.size} files]`;
        }
        case 'run_command': {
            const cmd = args.command || 'unknown';
            const exitMatch = content.match(/exit code[:\s]*(\d+)/i);
            const exitCode = exitMatch ? exitMatch[1] : '0';
            return `[run_command: '${cmd}' — exit ${exitCode}, ${lines.length} lines output]`;
        }
        case 'search_files': {
            const pattern = args.pattern || args.query || 'unknown';
            const resultCount = lines.filter((l) => l.trim()).length;
            return `[search_files: '${pattern}' — ${resultCount} results]`;
        }
        case 'list_directory': {
            const path = args.path || args.directory || 'unknown';
            const entryCount = lines.filter((l) => l.trim()).length;
            return `[list_directory: ${path} — ${entryCount} entries]`;
        }
        case 'web_search': {
            const query = args.query || 'unknown';
            return `[web_search: '${query}' — results retrieved]`;
        }
        case 'fetch_webpage': {
            const url = args.url || 'unknown';
            return `[fetch_webpage: ${url} — content retrieved]`;
        }
        case 'edit_file': {
            const path = args.file_path || args.path || 'unknown';
            return `[edit_file: ${path} — edits applied]`;
        }
        case 'write_file': {
            const path = args.file_path || args.path || 'unknown';
            return `[write_file: ${path} — file written]`;
        }
        default:
            return `[${toolName}: completed]`;
    }
}

export function microcompact(
    messages: AgentMessage[],
    preserveRecentTurns: number = 3,
): AgentMessage[] {
    // Count turns backwards. A turn = assistant message followed by its tool results.
    let turnCount = 0;
    let preserveFromIndex = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
            turnCount++;
            if (turnCount >= preserveRecentTurns) {
                preserveFromIndex = i;
                break;
            }
        }
    }

    const result: AgentMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        if (i < preserveFromIndex && msg.role === 'tool' && msg.tool_call_id) {
            const info = findToolCallInfo(messages, msg.tool_call_id);
            if (info) {
                const summary = compactToolResult(
                    info.name,
                    info.args,
                    msg.content || '',
                );
                result.push({ ...msg, content: summary });
            } else {
                result.push({ ...msg });
            }
        } else {
            result.push({ ...msg });
        }
    }

    return result;
}

export function estimateTokens(messages: AgentMessage[]): number {
    let totalChars = 0;
    for (const msg of messages) {
        if (msg.content) {
            totalChars += msg.content.length;
        }
        if (msg.tool_calls) {
            totalChars += JSON.stringify(msg.tool_calls).length;
        }
    }
    return Math.ceil(totalChars / 4);
}

export function shouldAutocompact(
    messages: AgentMessage[],
    contextWindowTokens: number = 128_000,
): boolean {
    const estimated = estimateTokens(messages);
    return estimated > contextWindowTokens * 0.8;
}

export function buildAutocompactPrompt(messages: AgentMessage[], originalGoal?: string): string {
    const summary = messages
        .filter((m) => m.role !== 'system')
        .map((m) => {
            if (m.role === 'tool') {
                const preview = (m.content || '').substring(0, 200);
                return `[tool result: ${preview}...]`;
            }
            return `${m.role}: ${(m.content || '').substring(0, 500)}`;
        })
        .join('\n');

    const goalLine = originalGoal
        ? `The original user task is: "${originalGoal}"\n\n`
        : '';

    return `${goalLine}Summarize this conversation so far. Preserve ALL:\n- The original task goal (stated above)\n- File paths mentioned or modified\n- Code changes made (what was changed and why)\n- Errors encountered and how they were resolved\n- Current task state and what remains to be done\n- Key decisions made\n\nConversation:\n${summary}`;
}

export function applyAutocompact(
    messages: AgentMessage[],
    summary: string,
    compactedAtTurn: number,
    originalGoal?: string,
): AgentMessage[] {
    const systemMsg = messages[0];

    let turnsSeen = 0;
    let recentStart = messages.length;
    for (let i = 1; i < messages.length; i++) {
        if (messages[i].role === 'assistant') {
            turnsSeen++;
        }
        if (turnsSeen >= compactedAtTurn) {
            recentStart = i;
            break;
        }
    }

    const compacted: AgentMessage[] = [
        systemMsg,
        {
            role: 'user' as const,
            content: `[Previous conversation summary]\n${summary}`,
            tool_calls: undefined,
            tool_call_id: undefined,
        },
    ];

    // Pin the original goal after compaction so it is never lost from context
    if (originalGoal) {
        compacted.push({
            role: 'user' as const,
            content: `[SYSTEM: Original task reminder — you are working on: "${originalGoal}". Stay focused on this goal.]`,
            tool_calls: undefined,
            tool_call_id: undefined,
        });
    }

    compacted.push(...messages.slice(recentStart));
    return compacted;
}
