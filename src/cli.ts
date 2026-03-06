/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI tool to render jj-view's graph in ASCII, matching `jj log` format.
 *
 * Usage:
 *   npx ts-node src/cli.ts [repo-path]
 *
 * If repo-path is omitted, uses the current directory.
 * Requires `jj` to be installed and the target directory to be a jj repository.
 */

import * as cp from 'child_process';
import { JjLogEntry } from './jj-types';
import { computeGraphLayout } from './webview/graph-compute';
import { renderGraphToAscii } from './cli-renderer';
import { buildLogTemplate, LOG_ENTRY_SCHEMA } from './jj-template-builder';

function main() {
    const repoPath = process.argv[2] || process.cwd();

    // Build the same template used by jj-view
    const template = buildLogTemplate(LOG_ENTRY_SCHEMA);

    // Run jj log to get JSON data
    let output: string;
    try {
        output = cp.execFileSync('jj', ['log', '--no-pager', '-T', template], {
            cwd: repoPath,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
        });
    } catch (e: unknown) {
        const err = e as { stderr?: string; message?: string };
        console.error('Failed to run jj log:', err.stderr || err.message);
        process.exit(1);
    }

    // Parse entries
    const entries: JjLogEntry[] = [];
    for (const line of output.trim().split('\n')) {
        if (!line) continue;
        const jsonStart = line.indexOf('{');
        if (jsonStart === -1) continue;
        const jsonPart = line.substring(jsonStart);
        try {
            entries.push(JSON.parse(jsonPart) as JjLogEntry);
        } catch (e) {
            console.error('Failed to parse:', line);
        }
    }

    if (entries.length === 0) {
        console.log('No commits found.');
        return;
    }

    // Compute layout using the same algorithm as the webview
    const layout = computeGraphLayout(entries);

    // Render as ASCII
    const ascii = renderGraphToAscii(layout);
    console.log(ascii);
}

main();
