/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import * as credentialUtils from '../utils/git-credential-utils';
import { NodeHostHttp } from '../utils/node-host-http';
import { FakeHostEnvironment } from './fake-host-environment';

interface RecordedRequest {
    method: string;
    url: string;
    authorization: string | undefined;
    body: string;
}

describe('NodeHostHttp', () => {
    let server: http.Server;
    let baseUrl: string;
    let requests: RecordedRequest[];
    let responseStatus: number;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk: Buffer) => {
                body += chunk.toString('utf8');
            });
            req.on('end', () => {
                requests.push({
                    method: req.method ?? '',
                    url: req.url ?? '',
                    authorization: req.headers.authorization,
                    body,
                });
                res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        requests = [];
        responseStatus = 200;
        vi.restoreAllMocks();
    });

    test('relays method, body and response without auth', async () => {
        const host = new FakeHostEnvironment();
        const client = new NodeHostHttp(host.secrets);

        const response = await client.fetch(`${baseUrl}/changes/`, { method: 'PUT', body: '{"a":1}' });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(requests).toEqual([{ method: 'PUT', url: '/changes/', authorization: undefined, body: '{"a":1}' }]);
    });

    test('injects secrets and bearer tokens without exposing them to callers', async () => {
        const host = new FakeHostEnvironment();
        await host.secrets.store('github_token', 'ghp_secret');
        const client = new NodeHostHttp(host.secrets);

        await client.fetch(`${baseUrl}/user`, { auth: { kind: 'secret', key: 'github_token' } });
        await client.fetch(`${baseUrl}/user`, { auth: { kind: 'secret', key: 'missing' } });
        await client.fetch(`${baseUrl}/user`, { auth: { kind: 'bearer', token: 'oauth' } });

        expect(requests.map((r) => r.authorization)).toEqual(['Bearer ghp_secret', undefined, 'Bearer oauth']);
    });

    test('attaches git credentials, caches them, and drops them after 401/403', async () => {
        const resolveSpy = vi
            .spyOn(credentialUtils, 'resolveGitAuthHeader')
            .mockResolvedValue({ name: 'Authorization', value: 'Basic Z2l0OnB3' });
        const host = new FakeHostEnvironment();
        const client = new NodeHostHttp(host.secrets);

        expect(await client.hasGitCredentials(`${baseUrl}/`, '/repo/.git')).toBe(true);
        await client.fetch(`${baseUrl}/a/changes/`, { auth: { kind: 'git', gitDir: '/repo/.git' } });
        expect(requests[0].authorization).toBe('Basic Z2l0OnB3');
        expect(resolveSpy).toHaveBeenCalledTimes(1);
        expect(resolveSpy).toHaveBeenCalledWith(baseUrl, '/repo/.git', undefined);

        responseStatus = 401;
        await client.fetch(`${baseUrl}/a/changes/`, { auth: { kind: 'git', gitDir: '/repo/.git' } });
        expect(resolveSpy).toHaveBeenCalledTimes(1);

        resolveSpy.mockResolvedValue(undefined);
        responseStatus = 200;
        await client.fetch(`${baseUrl}/a/changes/`, { auth: { kind: 'git', gitDir: '/repo/.git' } });
        expect(resolveSpy).toHaveBeenCalledTimes(2);
        expect(requests[2].authorization).toBeUndefined();
        expect(await client.hasGitCredentials(`${baseUrl}/`, '/repo/.git')).toBe(false);
    });

    test('expires cached git credentials after the TTL', async () => {
        const resolveSpy = vi.spyOn(credentialUtils, 'resolveGitAuthHeader').mockResolvedValue(undefined);
        let now = 1_000_000;
        const host = new FakeHostEnvironment();
        const client = new NodeHostHttp(host.secrets, undefined, () => now);

        await client.hasGitCredentials(`${baseUrl}/`);
        await client.hasGitCredentials(`${baseUrl}/`);
        expect(resolveSpy).toHaveBeenCalledTimes(1);

        now += 6 * 60 * 1000;
        await client.hasGitCredentials(`${baseUrl}/`);
        expect(resolveSpy).toHaveBeenCalledTimes(2);
    });

    test('shares one in-flight resolution between concurrent requests', async () => {
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const resolveSpy = vi.spyOn(credentialUtils, 'resolveGitAuthHeader').mockImplementation(async () => {
            await gate;
            return { name: 'Authorization', value: 'Basic Z2l0OnB3' };
        });
        const host = new FakeHostEnvironment();
        const client = new NodeHostHttp(host.secrets);

        const pending = Promise.all([
            client.hasGitCredentials(`${baseUrl}/`, '/repo/.git'),
            client.fetch(`${baseUrl}/a/changes/`, { auth: { kind: 'git', gitDir: '/repo/.git' } }),
            client.fetch(`${baseUrl}/a/changes/drafts`, { auth: { kind: 'git', gitDir: '/repo/.git' } }),
        ]);
        release?.();
        const [available] = await pending;

        expect(available).toBe(true);
        expect(resolveSpy).toHaveBeenCalledTimes(1);
        expect(requests.map((r) => r.authorization)).toEqual(['Basic Z2l0OnB3', 'Basic Z2l0OnB3']);
    });
});
