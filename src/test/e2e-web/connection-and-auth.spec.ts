/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Connection and Auth', () => {
    test('should load web application and connect to daemon cleanly with valid token', async ({ page, server }) => {
        await page.goto(server.serverUrl);
        await expect(page).toHaveTitle('JJ View');

        await waitForScmReady(page);

        // Verify configuration was properly injected into window
        const config = await page.evaluate(() => window.__JJ_VIEW_CONFIG__);

        expect(config).toBeDefined();
        expect(config?.port).toBe(server.port);
        expect(config?.token).toBe(server.sessionToken);

        // Ensure no error overlay is present
        await expect(page.locator('text=Failed to connect to JJ View host daemon')).toHaveCount(0);
    });

    test('should reject HTTP request without session token', async ({ server, request }) => {
        const response = await request.get(server.baseUrl);
        expect(response.status()).toBe(401);
        const text = await response.text();
        expect(text).toContain('Unauthorized');
    });

    test('should reject HTTP request with invalid session token', async ({ server, request }) => {
        const response = await request.get(`${server.baseUrl}/?token=bogus_token_hex_12345`);
        expect(response.status()).toBe(401);
        const text = await response.text();
        expect(text).toContain('Unauthorized');
    });

    test('should reject WebSocket handshake without valid token', async ({ server, request }) => {
        const response = await request.get(`${server.baseUrl}/ws/system`);
        expect(response.status()).toBe(401);
    });
});
