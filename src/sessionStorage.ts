/**
 * Session Storage for DeepCode
 *
 * Persists agent conversation transcripts to disk so sessions can be
 * resumed later. Stores transcripts as JSON files under ~/.deepcode/sessions/.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentMessage } from './agentLoop';

// Session storage directory: ~/.deepcode/sessions/
const SESSIONS_DIR = path.join(os.homedir(), '.deepcode', 'sessions');

export interface SessionMetadata {
    sessionId: string;
    timestamp: number;
    firstUserMessage: string;
    turnCount: number;
}

export interface SessionTranscript {
    sessionId: string;
    messages: Array<{
        role: string;
        content: string | null;
        tool_calls?: any[];
        tool_call_id?: string;
    }>;
    metadata: SessionMetadata;
}

/**
 * Create the sessions directory recursively if it doesn't exist.
 */
export function ensureSessionDir(): void {
    try {
        if (!fs.existsSync(SESSIONS_DIR)) {
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        }
    } catch {
        // Best effort — don't crash if we can't create the directory
    }
}

/**
 * Write the current conversation transcript to disk.
 * Fire-and-forget — callers should not await this.
 */
export function recordTranscript(sessionId: string, messages: AgentMessage[]): void {
    try {
        ensureSessionDir();

        const firstUserMsg = messages.find(m => m.role === 'user');
        const turnCount = messages.filter(m => m.role === 'assistant').length;

        const transcript: SessionTranscript = {
            sessionId,
            messages: messages.map(m => ({
                role: m.role,
                content: m.content,
                ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            })),
            metadata: {
                sessionId,
                timestamp: Date.now(),
                firstUserMessage: firstUserMsg?.content || '',
                turnCount,
            },
        };

        const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(transcript, null, 2), 'utf-8');
    } catch {
        // Fire-and-forget — never crash the caller
    }
}

/**
 * Load a previously saved transcript from disk.
 * Returns null if the session file doesn't exist or can't be parsed.
 */
export function loadTranscript(sessionId: string): SessionTranscript | null {
    try {
        const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw) as SessionTranscript;
    } catch {
        return null;
    }
}

/**
 * List all saved sessions, sorted by timestamp descending (most recent first).
 */
export function listSessions(): SessionMetadata[] {
    try {
        ensureSessionDir();

        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
        const sessions: SessionMetadata[] = [];

        for (const file of files) {
            try {
                const filePath = path.join(SESSIONS_DIR, file);
                const raw = fs.readFileSync(filePath, 'utf-8');
                const transcript = JSON.parse(raw) as SessionTranscript;
                if (transcript.metadata) {
                    sessions.push(transcript.metadata);
                }
            } catch {
                // Skip unparseable files
            }
        }

        sessions.sort((a, b) => b.timestamp - a.timestamp);
        return sessions;
    } catch {
        return [];
    }
}

/**
 * Record a sub-agent's transcript under the parent session's subdirectory.
 * Written to ${SESSIONS_DIR}/${sessionId}/subagent_${agentId}.json.
 */
export function recordSubAgentTranscript(
    sessionId: string,
    agentId: string,
    messages: AgentMessage[],
): void {
    try {
        const subDir = path.join(SESSIONS_DIR, sessionId);
        if (!fs.existsSync(subDir)) {
            fs.mkdirSync(subDir, { recursive: true });
        }

        const firstUserMsg = messages.find(m => m.role === 'user');
        const turnCount = messages.filter(m => m.role === 'assistant').length;

        const transcript: SessionTranscript = {
            sessionId: `${sessionId}/subagent_${agentId}`,
            messages: messages.map(m => ({
                role: m.role,
                content: m.content,
                ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            })),
            metadata: {
                sessionId: `${sessionId}/subagent_${agentId}`,
                timestamp: Date.now(),
                firstUserMessage: firstUserMsg?.content || '',
                turnCount,
            },
        };

        const filePath = path.join(subDir, `subagent_${agentId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(transcript, null, 2), 'utf-8');
    } catch {
        // Fire-and-forget — never crash the caller
    }
}
