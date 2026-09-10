/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PerfTraceEntry {
    caller: 'TestRepo' | 'JjService';
    command: string;
    durationMs: number;
    testFile?: string;
}

type GlobalWithExpect = typeof globalThis & {
    expect?: {
        getState?: () => { testPath?: string };
    };
};

function getTraceFilePath(): string | undefined {
    return process.env.JJ_VIEW_PERF_TRACE_FILE;
}

function getCurrentTestFile(): string | undefined {
    try {
        const testPath = (globalThis as GlobalWithExpect).expect?.getState?.()?.testPath;
        if (!testPath) {
            return undefined;
        }
        return path.relative(process.cwd(), testPath);
    } catch {
        return undefined;
    }
}

export function extractJjSubcommand(args: string[]): string {
    const flagsWithArg = new Set([
        '--config-file',
        '--config',
        '-r',
        '--revision',
        '-m',
        '--message',
        '--at-op',
        '-b',
        '--bookmark',
        '--from',
        '--to',
    ]);
    const nonFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (flagsWithArg.has(arg)) {
            i++;
            continue;
        }
        if (arg.startsWith('-')) {
            continue;
        }
        nonFlags.push(arg);
    }
    if (nonFlags.length === 0) {
        return args[0] || 'unknown';
    }

    const first = nonFlags[0];
    const second = nonFlags[1];

    if (first === 'git' && second) {
        return `git ${second}`;
    }
    if (first === 'config' && second) {
        return `config ${second}`;
    }
    if (first === 'bookmark' && second) {
        return `bookmark ${second}`;
    }
    if (first === 'workspace' && second) {
        return `workspace ${second}`;
    }
    if (first === 'operation' && second) {
        return `operation ${second}`;
    }

    return first;
}

export function recordCommandTrace(caller: 'TestRepo' | 'JjService', args: string[], durationMs: number): void {
    const traceFile = getTraceFilePath();
    if (!traceFile) {
        return;
    }

    const command = extractJjSubcommand(args);
    const testFile = getCurrentTestFile();
    const entry: PerfTraceEntry = {
        caller,
        command,
        durationMs: Math.max(0, durationMs),
        testFile,
    };

    try {
        fs.appendFileSync(traceFile, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch {
        // Silently ignore write errors
    }
}
