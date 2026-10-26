/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Event, EventEmitter } from '../../../src/core/host/events';
import type { LoggerChannel } from '../../../src/utils/output-channel';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface OutputLogEntry {
    readonly id: number;
    readonly timestamp: number;
    readonly formattedTime: string;
    readonly level: LogLevel;
    readonly source: string;
    readonly message: string;
    readonly details?: string;
    readonly durationMs?: number;
    readonly cached?: boolean;
    readonly rawText: string;
}

export type LogTokenKind =
    | 'text'
    | 'url'
    | 'string'
    | 'flag'
    | 'path'
    | 'duration'
    | 'rev'
    | 'keyword-error'
    | 'keyword-success';

export interface LogToken {
    readonly kind: LogTokenKind;
    readonly text: string;
}

export interface HighlightSegment {
    readonly text: string;
    readonly match: boolean;
}

const MAX_LOG_ENTRIES = 2000;

const DURATION_PREFIX_RE = /^\[(\d+(?:\.\d+)?)ms\](?:\s*\(cached\))?\s*/;
const DURATION_SUFFIX_RE = /\s*\[(\d+(?:\.\d+)?)ms\](?:\s*\(cached\))?$/;
const BRACKET_TAG_RE = /^\[([^\][]+)\]\s*/;

function formatTimestamp(ms: number): string {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const mmm = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${mmm}`;
}

interface ParsedLogFields {
    source: string;
    message: string;
    details?: string;
    durationMs?: number;
    cached?: boolean;
}

export function parseLogMessage(rawMessage: string, error?: Error): ParsedLogFields {
    let remaining = rawMessage.trimEnd();
    let durationMs: number | undefined;
    let cached: boolean | undefined;

    const durationMatch = DURATION_PREFIX_RE.exec(remaining);
    if (durationMatch) {
        durationMs = Number.parseFloat(durationMatch[1]);
        cached = durationMatch[0].includes('(cached)');
        remaining = remaining.slice(durationMatch[0].length);
    }

    const sources: string[] = [];
    while (true) {
        const tagMatch = BRACKET_TAG_RE.exec(remaining);
        if (!tagMatch) {
            break;
        }
        const tag = tagMatch[1].trim();
        if (/^\d+(?:\.\d+)?ms$/.test(tag) && durationMs === undefined) {
            durationMs = Number.parseFloat(tag);
        } else if (tag.length > 0) {
            sources.push(tag);
        }
        remaining = remaining.slice(tagMatch[0].length);
    }

    let source = sources.length > 0 ? sources.join(':') : 'General';
    if (source === 'General' && (durationMs !== undefined || remaining.startsWith('jj '))) {
        source = 'JJ CLI';
    }

    const lines = remaining.split(/\r?\n/);
    let firstLine = lines[0] ?? '';
    const extraLines = lines.slice(1).join('\n').trim();

    if (durationMs === undefined) {
        const suffixMatch = DURATION_SUFFIX_RE.exec(firstLine);
        if (suffixMatch) {
            durationMs = Number.parseFloat(suffixMatch[1]);
            cached = suffixMatch[0].includes('(cached)');
            firstLine = firstLine.slice(0, firstLine.length - suffixMatch[0].length);
        }
    }

    const detailParts: string[] = [];
    if (extraLines.length > 0) {
        detailParts.push(extraLines);
    }
    if (error) {
        const errText = error.stack || error.message;
        if (errText && !firstLine.includes(errText) && !extraLines.includes(errText)) {
            detailParts.push(errText);
        }
    }

    return {
        source,
        message: firstLine || rawMessage,
        details: detailParts.length > 0 ? detailParts.join('\n\n') : undefined,
        durationMs,
        cached,
    };
}

const TOKEN_MASTER_RE =
    /(https?:\/\/[^\s"'<>]+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|((?:^|\s)--?[a-zA-Z0-9][\w-]*(?:=[^\s"']+)?)|((?:file:\/\/[^\s"']+|\/(?:[\w.@+-]+\/)+[\w.@+-]*))|(\b\d+(?:\.\d+)?(?:ms|s)\b)|(\b(?:error|failed|failure|fatal|exception|rejected|denied|timed out|conflict|conflicted)\b)|(\b(?:success|succeeded|completed|resolved|ready|connected)\b)|(\b[0-9a-f]{8,40}\b)/gi;

export function tokenizeLogText(text: string): LogToken[] {
    if (!text) {
        return [];
    }

    const tokens: LogToken[] = [];
    let lastIndex = 0;

    TOKEN_MASTER_RE.lastIndex = 0;
    let match = TOKEN_MASTER_RE.exec(text);
    while (match !== null) {
        let matchStart = match.index;
        let matchText = match[0];

        // Flag group may capture a leading whitespace character; keep that whitespace in plain text
        if (match[3] !== undefined && /^\s/.test(matchText)) {
            matchStart += 1;
            matchText = matchText.slice(1);
        }

        if (matchStart > lastIndex) {
            tokens.push({
                kind: 'text',
                text: text.slice(lastIndex, matchStart),
            });
        }

        let kind: LogTokenKind = 'text';
        if (match[1] !== undefined) {
            kind = 'url';
        } else if (match[2] !== undefined) {
            kind = 'string';
        } else if (match[3] !== undefined) {
            kind = 'flag';
        } else if (match[4] !== undefined) {
            kind = 'path';
        } else if (match[5] !== undefined) {
            kind = 'duration';
        } else if (match[6] !== undefined) {
            kind = 'keyword-error';
        } else if (match[7] !== undefined) {
            kind = 'keyword-success';
        } else if (match[8] !== undefined) {
            kind = 'rev';
        }

        tokens.push({ kind, text: matchText });
        lastIndex = matchStart + matchText.length;
        match = TOKEN_MASTER_RE.exec(text);
    }

    if (lastIndex < text.length) {
        tokens.push({
            kind: 'text',
            text: text.slice(lastIndex),
        });
    }

    return tokens;
}

export function splitHighlightSegments(text: string, query: string): HighlightSegment[] {
    const trimmed = query.trim();
    if (!trimmed || !text) {
        return [{ text, match: false }];
    }

    const lowerText = text.toLowerCase();
    const lowerQuery = trimmed.toLowerCase();
    const qLen = lowerQuery.length;

    const segments: HighlightSegment[] = [];
    let cursor = 0;

    while (cursor < text.length) {
        const idx = lowerText.indexOf(lowerQuery, cursor);
        if (idx === -1) {
            segments.push({ text: text.slice(cursor), match: false });
            break;
        }
        if (idx > cursor) {
            segments.push({ text: text.slice(cursor, idx), match: false });
        }
        segments.push({ text: text.slice(idx, idx + qLen), match: true });
        cursor = idx + qLen;
    }

    return segments.length > 0 ? segments : [{ text, match: false }];
}

export class WebOutputChannel implements LoggerChannel {
    public readonly name: string;
    private readonly _entries: OutputLogEntry[] = [];
    private _nextId = 1;

    private readonly _onDidChangeEntries = new EventEmitter<readonly OutputLogEntry[]>();
    public readonly onDidChangeEntries: Event<readonly OutputLogEntry[]> = this._onDidChangeEntries.event;

    private readonly _onDidRequestShow = new EventEmitter<{ preserveFocus?: boolean }>();
    public readonly onDidRequestShow: Event<{ preserveFocus?: boolean }> = this._onDidRequestShow.event;

    private readonly _onDidRequestHide = new EventEmitter<void>();
    public readonly onDidRequestHide: Event<void> = this._onDidRequestHide.event;

    constructor(name = 'JJ View') {
        this.name = name;
    }

    public get entries(): readonly OutputLogEntry[] {
        return this._entries;
    }

    private _append(level: LogLevel, message: string, error?: Error): void {
        const timestamp = Date.now();
        const parsed = parseLogMessage(message, error);
        const rawParts = [
            `[${formatTimestamp(timestamp)}] [${level.toUpperCase()}] [${parsed.source}] ${parsed.message}`,
        ];
        if (parsed.details) {
            rawParts.push(parsed.details);
        }

        const entry: OutputLogEntry = {
            id: this._nextId++,
            timestamp,
            formattedTime: formatTimestamp(timestamp),
            level,
            source: parsed.source,
            message: parsed.message,
            details: parsed.details,
            durationMs: parsed.durationMs,
            cached: parsed.cached,
            rawText: rawParts.join('\n'),
        };

        this._entries.push(entry);
        if (this._entries.length > MAX_LOG_ENTRIES) {
            this._entries.splice(0, this._entries.length - MAX_LOG_ENTRIES);
        }
        this._onDidChangeEntries.fire([...this._entries]);
    }

    public trace(message: string): void {
        this._append('trace', message);
    }

    public debug(message: string): void {
        this._append('debug', message);
    }

    public info(message: string): void {
        this._append('info', message);
    }

    public warn(message: string): void {
        this._append('warn', message);
    }

    public error(message: string, error?: Error): void {
        this._append('error', message, error);
    }

    public replace(value: string): void {
        this._entries.length = 0;
        if (value.trim().length > 0) {
            this._append('info', value);
            return;
        }
        this._onDidChangeEntries.fire([]);
    }

    public clear(): void {
        this._entries.length = 0;
        this._onDidChangeEntries.fire([]);
    }

    public show(preserveFocus?: boolean): void {
        this._onDidRequestShow.fire({ preserveFocus });
    }

    public hide(): void {
        this._onDidRequestHide.fire();
    }

    public dispose(): void {
        this._onDidChangeEntries.dispose();
        this._onDidRequestShow.dispose();
        this._onDidRequestHide.dispose();
    }
}
