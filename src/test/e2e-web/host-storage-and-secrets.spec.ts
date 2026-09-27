/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone HostStorage and HostSecrets E2E', () => {
    test('should persist state across page reloads and sanitize URL token', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Verify URL had the token stripped from query string
        expect(page.url()).not.toContain('token=');

        // Store a value in HostStorage via the running WebHostEnvironment
        await page.evaluate(async () => {
            await window.__JJ_VIEW_ENV__?.storage.update('e2e.test.stateKey', { count: 42, label: 'persisted' });
        });

        // Verify state is immediately readable
        const valBeforeReload = await page.evaluate(async () => {
            return await window.__JJ_VIEW_ENV__?.storage.get('e2e.test.stateKey');
        });
        expect(valBeforeReload).toEqual({ count: 42, label: 'persisted' });

        // Reload the page without passing a token in the URL (relies on HttpOnly session cookie)
        await page.reload();
        await waitForScmReady(page);

        // Verify state was rehydrated and persisted across reload
        const valAfterReload = await page.evaluate(async () => {
            return await window.__JJ_VIEW_ENV__?.storage.get('e2e.test.stateKey');
        });
        expect(valAfterReload).toEqual({ count: 42, label: 'persisted' });

        // Verify the file was written to disk in userDataDir
        const stateFile = path.join(server.userDataDir, 'state.json');
        expect(fs.existsSync(stateFile)).toBe(true);
        const diskContent = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        expect(diskContent['e2e.test.stateKey']).toEqual({ count: 42, label: 'persisted' });
    });

    test('should persist secrets with secure disk permissions and support CRUD', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        // Store a secret
        await page.evaluate(async () => {
            await window.__JJ_VIEW_ENV__?.secrets.store('e2e.secret.token', 'super-secret-pat-12345');
        });

        // Retrieve secret
        const secretVal = await page.evaluate(async () => {
            return await window.__JJ_VIEW_ENV__?.secrets.get('e2e.secret.token');
        });
        expect(secretVal).toBe('super-secret-pat-12345');

        // Verify file exists on disk
        const credFile = path.join(server.userDataDir, 'credentials.json');
        expect(fs.existsSync(credFile)).toBe(true);

        // Verify permissions on POSIX systems (strict 0600)
        if (process.platform !== 'win32') {
            const stat = fs.statSync(credFile);
            expect(stat.mode & 0o777).toBe(0o600);
        }

        // Reload the page and verify secret persists
        await page.reload();
        await waitForScmReady(page);

        const secretAfterReload = await page.evaluate(async () => {
            return await window.__JJ_VIEW_ENV__?.secrets.get('e2e.secret.token');
        });
        expect(secretAfterReload).toBe('super-secret-pat-12345');

        // Delete the secret
        await page.evaluate(async () => {
            await window.__JJ_VIEW_ENV__?.secrets.delete('e2e.secret.token');
        });

        const secretAfterDelete = await page.evaluate(async () => {
            return await window.__JJ_VIEW_ENV__?.secrets.get('e2e.secret.token');
        });
        expect(secretAfterDelete).toBeUndefined();
    });

    test('should synchronize state between multiple browser tabs', async ({ page, server, context }) => {
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const page2 = await context.newPage();
        await page2.goto(server.serverUrl);
        await waitForScmReady(page2);

        // Tab 1 updates state
        await page.evaluate(async () => {
            await window.__JJ_VIEW_ENV__?.storage.update('multi.tab.key', 'written-by-tab-1');
        });

        // Tab 2 reads state
        const valInTab2 = await page2.evaluate(async () => {
            return await window.__JJ_VIEW_ENV__?.storage.get('multi.tab.key');
        });
        expect(valInTab2).toBe('written-by-tab-1');

        await page2.close();
    });
});
