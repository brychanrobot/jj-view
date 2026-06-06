/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as vscode from 'vscode';
import { logPerf } from './perf-logger';
import { waitUntil } from './wait-utils';

globalThis.logPerf = logPerf;
globalThis.waitUntil = waitUntil;

let resolveRunner: (() => void) | undefined;
const handleCache = new Map<string, unknown>();

function resolveArgs(args: unknown[]): unknown[] {
    return args.map((arg) => {
        if (arg && typeof arg === 'object' && '__vscode_handle__' in arg) {
            const handle = (arg as Record<string, unknown>).__vscode_handle__;
            if (typeof handle === 'string') {
                return handleCache.get(handle);
            }
        }
        return arg;
    });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            resolve(body);
        });
        req.on('error', (err) => {
            reject(err);
        });
    });
}

async function handleCommand(req: http.IncomingMessage, res: http.ServerResponse, server: http.Server): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/command') {
        res.writeHead(404).end();
        return;
    }

    const body = await readBody(req);
    const payload = JSON.parse(body);
    const { action, script, args = [], handleId } = payload;

    if (action === 'evaluate' || action === 'evaluateHandle') {
        const extension = vscode.extensions.getExtension('jj-view.jj-view');
        const api = await extension?.activate();

        const resolvedArgs = resolveArgs(args);
        // Reconstruct the function and execute it in the Extension Host context
        const fn = new Function(
            'vscode',
            'api',
            ...resolvedArgs.map((_, i) => `arg${i}`),
            `const argsList = Array.from(arguments).slice(2);
              return (${script})(vscode, api, ...argsList);`,
        );

        const result = await fn(vscode, api, ...resolvedArgs);

        if (action === 'evaluateHandle') {
            const id = crypto.randomUUID();
            handleCache.set(id, result);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ handleId: id }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result }));
        }
        return;
    }

    if (action === 'releaseHandle') {
        handleCache.delete(handleId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success' }));
        return;
    }

    if (action === 'shutdown') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success' }));
        server.close();
        if (resolveRunner) {
            resolveRunner();
        }
        return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', error: `Unknown action: ${action}` }));
}

export function run(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        resolveRunner = resolve;

        const testIpcPath = process.env.JJ_TEST_IPC_PATH;
        if (!testIpcPath) {
            reject(new Error('process.env.JJ_TEST_IPC_PATH is not defined'));
            return;
        }

        const server = http.createServer((req, res) => {
            handleCommand(req, res, server).catch((err) => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', error: String(err) }));
            });
        });

        // Ensure socket file is removed before listening (on Unix)
        if (process.platform !== 'win32' && fs.existsSync(testIpcPath)) {
            try {
                fs.unlinkSync(testIpcPath);
            } catch {}
        }

        server.listen(testIpcPath, () => {
            console.log(`[E2E Runner] Evaluation IPC server listening on ${testIpcPath}`);
        });

        server.on('error', (err) => {
            reject(err);
        });
    });
}
