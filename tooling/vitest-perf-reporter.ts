/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Reporter, TestModule } from 'vitest/reporters';

interface TraceRecord {
    caller: 'TestRepo' | 'JjService';
    command: string;
    durationMs: number;
    testFile?: string;
}

interface CommandStat {
    command: string;
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
}

export class VitestPerfReporter implements Reporter {
    private traceFilePath: string;

    constructor(traceFilePath?: string) {
        if (traceFilePath) {
            this.traceFilePath = traceFilePath;
        } else {
            const existing = process.env.JJ_VIEW_PERF_TRACE_FILE;
            this.traceFilePath = existing || path.join(os.tmpdir(), `jj-view-perf-trace-${process.pid}.jsonl`);
        }
        process.env.JJ_VIEW_PERF_TRACE_FILE = this.traceFilePath;

        try {
            if (fs.existsSync(this.traceFilePath)) {
                fs.unlinkSync(this.traceFilePath);
            }
        } catch {}
    }

    onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
        this.printReport(testModules);
    }

    private printReport(testModules: ReadonlyArray<TestModule>): void {
        const fileTimings: Array<{ file: string; durationMs: number; testCount: number }> = [];
        const testTimings: Array<{ name: string; file: string; durationMs: number }> = [];

        for (const mod of testModules) {
            const diag = mod.diagnostic();
            const durationMs = diag ? diag.duration : 0;
            const tests = Array.from(mod.children.allTests());

            fileTimings.push({
                file: mod.relativeModuleId,
                durationMs,
                testCount: tests.length,
            });

            for (const test of tests) {
                const testDiag = test.diagnostic();
                const testDuration = testDiag ? testDiag.duration : 0;
                testTimings.push({
                    name: test.fullName,
                    file: mod.relativeModuleId,
                    durationMs: testDuration,
                });
            }
        }

        fileTimings.sort((a, b) => b.durationMs - a.durationMs);
        testTimings.sort((a, b) => b.durationMs - a.durationMs);

        const traceRecords = this.readTraceRecords();
        const commandStats = this.aggregateCommandStats(traceRecords);

        console.log(`\n${'='.repeat(80)}`);
        console.log('                 JJ-VIEW PERFORMANCE TRACE SUMMARY');
        console.log('='.repeat(80));

        this.printSubprocessSummary(traceRecords, commandStats);
        this.printSlowestFiles(fileTimings.slice(0, 15));
        this.printSlowestTests(testTimings.slice(0, 20));

        console.log(`${'='.repeat(80)}\n`);

        try {
            if (fs.existsSync(this.traceFilePath)) {
                fs.unlinkSync(this.traceFilePath);
            }
        } catch {}
    }

    private readTraceRecords(): TraceRecord[] {
        if (!fs.existsSync(this.traceFilePath)) {
            return [];
        }

        try {
            const content = fs.readFileSync(this.traceFilePath, 'utf-8');
            const lines = content.split('\n');
            const records: TraceRecord[] = [];

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                try {
                    const parsed = JSON.parse(trimmed) as TraceRecord;
                    records.push(parsed);
                } catch {}
            }

            return records;
        } catch {
            return [];
        }
    }

    private aggregateCommandStats(records: TraceRecord[]): CommandStat[] {
        const statsMap = new Map<string, { count: number; totalMs: number; minMs: number; maxMs: number }>();

        for (const record of records) {
            const durationMs = Math.max(0, record.durationMs);
            const existing = statsMap.get(record.command);
            if (existing) {
                existing.count += 1;
                existing.totalMs += durationMs;
                if (durationMs < existing.minMs) {
                    existing.minMs = durationMs;
                }
                if (durationMs > existing.maxMs) {
                    existing.maxMs = durationMs;
                }
            } else {
                statsMap.set(record.command, {
                    count: 1,
                    totalMs: durationMs,
                    minMs: durationMs,
                    maxMs: durationMs,
                });
            }
        }

        const result: CommandStat[] = [];
        for (const [command, stat] of statsMap.entries()) {
            result.push({
                command,
                count: stat.count,
                totalMs: stat.totalMs,
                minMs: stat.minMs,
                maxMs: stat.maxMs,
            });
        }

        result.sort((a, b) => b.totalMs - a.totalMs);
        return result;
    }

    private printSubprocessSummary(records: TraceRecord[], commandStats: CommandStat[]): void {
        const totalCalls = records.length;
        if (totalCalls === 0) {
            console.log('\n[CLI Subprocesses] No subprocess executions recorded.');
            return;
        }

        let totalDurationMs = 0;
        let testRepoCalls = 0;
        let testRepoDurationMs = 0;
        let jjServiceCalls = 0;
        let jjServiceDurationMs = 0;
        let asyncGcCalls = 0;
        let asyncGcDurationMs = 0;

        for (const r of records) {
            const durationMs = Math.max(0, r.durationMs);
            if (r.command === 'repo-config-gc') {
                asyncGcCalls += 1;
                asyncGcDurationMs += durationMs;
                continue;
            }
            totalDurationMs += durationMs;
            if (r.caller === 'TestRepo') {
                testRepoCalls += 1;
                testRepoDurationMs += durationMs;
            } else {
                jjServiceCalls += 1;
                jjServiceDurationMs += durationMs;
            }
        }

        console.log('\n--- CLI Subprocess Overhead ---');
        console.log(`Total Invocations:     ${(totalCalls - asyncGcCalls).toLocaleString()}`);
        console.log(
            `  - TestRepo:          ${testRepoCalls.toLocaleString()} (${(testRepoDurationMs / 1000).toFixed(2)}s)`,
        );
        console.log(
            `  - JjService:         ${jjServiceCalls.toLocaleString()} (${(jjServiceDurationMs / 1000).toFixed(2)}s)`,
        );
        console.log(`Total CLI CPU/Wait:    ${(totalDurationMs / 1000).toFixed(2)}s`);
        if (asyncGcCalls > 0) {
            console.log(
                `  - Async Repo GC:     ${asyncGcCalls.toLocaleString()} calls (${(asyncGcDurationMs / 1000).toFixed(2)}s non-blocking background)`,
            );
        }

        console.log('\nCommand Breakdown (ranked by total time spent):');
        console.log('-'.repeat(80));
        console.log(
            'Command'.padEnd(20) +
                '| ' +
                'Calls'.padStart(6) +
                ' | ' +
                'Total Time'.padStart(11) +
                ' | ' +
                '% Time'.padStart(7) +
                ' | ' +
                'Avg (ms)'.padStart(9) +
                ' | ' +
                'Min/Max (ms)'.padStart(14),
        );
        console.log('-'.repeat(80));

        for (const stat of commandStats) {
            const isAsync = stat.command === 'repo-config-gc';
            const pct = isAsync
                ? ' async'
                : totalDurationMs > 0
                  ? `${((stat.totalMs / totalDurationMs) * 100).toFixed(1)}%`
                  : '0.0%';
            const avg = (stat.totalMs / stat.count).toFixed(1);
            const minMax = `${Math.round(stat.minMs)} / ${Math.round(stat.maxMs)}`;
            const timeStr =
                stat.totalMs >= 1000 ? `${(stat.totalMs / 1000).toFixed(2)}s` : `${Math.round(stat.totalMs)}ms`;

            console.log(
                stat.command.slice(0, 19).padEnd(20) +
                    '| ' +
                    stat.count.toString().padStart(6) +
                    ' | ' +
                    timeStr.padStart(11) +
                    ' | ' +
                    pct.padStart(7) +
                    ' | ' +
                    avg.padStart(9) +
                    ' | ' +
                    minMax.padStart(14),
            );
        }
        console.log('-'.repeat(80));

        // Top 10 slowest individual commands
        const sortedRecords = [...records].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
        console.log('\nTop 10 Slowest Individual CLI Invocations:');
        sortedRecords.forEach((r, idx) => {
            const loc = r.testFile ? ` (${r.testFile})` : '';
            console.log(
                `  ${(idx + 1).toString().padStart(2)}. ${Math.round(r.durationMs)}ms - jj ${r.command} [${r.caller}]${loc}`,
            );
        });
    }

    private printSlowestFiles(files: Array<{ file: string; durationMs: number; testCount: number }>): void {
        console.log('\n--- Top 15 Slowest Test Files ---');
        files.forEach((f, idx) => {
            const durationStr = `${(f.durationMs / 1000).toFixed(2)}s`;
            const countStr = `(${f.testCount} test${f.testCount === 1 ? '' : 's'})`;
            console.log(
                `  ${(idx + 1).toString().padStart(2)}. ${f.file.padEnd(50)} ${durationStr.padStart(7)} ${countStr}`,
            );
        });
    }

    private printSlowestTests(tests: Array<{ name: string; file: string; durationMs: number }>): void {
        console.log('\n--- Top 20 Slowest Individual Tests ---');
        tests.forEach((t, idx) => {
            const durationStr = `${Math.round(t.durationMs)}ms`;
            const name = t.name.length > 55 ? `${t.name.slice(0, 52)}...` : t.name;
            console.log(
                `  ${(idx + 1).toString().padStart(2)}. ${durationStr.padStart(7)} - ${name.padEnd(55)} (${t.file})`,
            );
        });
    }
}
