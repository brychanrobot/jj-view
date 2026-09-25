/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { HostFs } from '../../src/core/host/host-system';
import type { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import { createMock } from '../../src/test/test-utils';
import { WebHostEnvironment } from '../src/host/web-host-environment';
import SettingsModal from '../src/settings/SettingsModal.svelte';
import { ALL_SETTINGS, filterSettings, getCategories } from '../src/settings/settings-schema';

describe('Settings Schema Utilities', () => {
    it('includes package settings and web additional settings', () => {
        expect(ALL_SETTINGS.length).toBeGreaterThan(20);
        const themeSetting = ALL_SETTINGS.find((s) => s.key === 'appearance.theme');
        expect(themeSetting).toBeDefined();
        expect(themeSetting?.enum).toContain('pierre-dark-soft');
        expect(themeSetting?.enum).toContain('pierre-light-soft');
        expect(themeSetting?.enum?.length).toBe(10);

        // Verify no web prefix
        expect(ALL_SETTINGS.some((s) => s.key.startsWith('web.'))).toBe(false);
        const diffSetting = ALL_SETTINGS.find((s) => s.key === 'diff.style');
        expect(diffSetting).toBeDefined();

        // Verify jj-view prefix is stripped from package settings
        expect(ALL_SETTINGS.some((s) => s.key.startsWith('jj-view.'))).toBe(false);
        expect(ALL_SETTINGS.some((s) => s.key === 'fileWatcherMode')).toBe(true);
        expect(ALL_SETTINGS.some((s) => s.key === 'refreshDebounceMillis')).toBe(true);
    });

    it('derives unique categories', () => {
        const categories = getCategories(ALL_SETTINGS);
        expect(categories).toContain('Appearance');
        expect(categories).toContain('General');
    });

    it('filters settings by search query', () => {
        const results = filterSettings(ALL_SETTINGS, 'theme');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results.some((s) => s.key === 'appearance.theme')).toBe(true);

        const emptyResults = filterSettings(ALL_SETTINGS, 'nonexistent_setting_xyz');
        expect(emptyResults.length).toBe(0);
    });
});

describe('SettingsModal SSR Rendering', () => {
    function setupEnv() {
        const mockRemoteHost = createMock<RemoteHostSystem>({
            fs: createMock<HostFs>({
                readTextFile: vi.fn(),
                writeTextFile: vi.fn(),
            }),
            platform: 'linux',
            isConnected: true,
            getConfig: vi.fn(),
            setConfig: vi.fn(),
            getAllConfig: vi.fn().mockResolvedValue({}),
        });

        const env = new WebHostEnvironment(mockRemoteHost, '/test/workspace');
        return { env, mockRemoteHost };
    }

    it('renders modal with User and Workspace tabs and settings list', () => {
        const { env } = setupEnv();
        const onClose = vi.fn();

        const rendered = render(SettingsModal, {
            props: {
                webHostEnv: env,
                onClose,
            },
        });

        expect(rendered.html).toContain('Settings');
        expect(rendered.html).toContain('User');
        expect(rendered.html).toContain('Workspace');
        expect(rendered.html).toContain('appearance.theme');
        expect(rendered.html).toContain('Color Theme');
    });
});
