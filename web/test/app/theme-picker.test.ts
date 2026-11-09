/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { applyTheme, openThemePicker } from '../../src/app/theme-picker';
import type { WebHostConfig, WebHostEnvironment } from '../../src/host/web-host-environment';
import type { QuickInputService } from '../../src/quick-input/quick-input-service';
import { createMock } from '../test-mock';

describe('theme-picker', () => {
    it('notifies theme change callback on applyTheme', async () => {
        let changedTheme: string | undefined;
        await applyTheme('vitesse-black', (name) => {
            changedTheme = name;
        });
        expect(changedTheme).toBe('vitesse-black');
    });

    it('previews theme on active item change and persists selected theme to config', async () => {
        const previewedThemes: string[] = [];
        let persistedThemeKey: string | undefined;
        let persistedThemeValue: unknown;

        const mockConfig = createMock<WebHostConfig>({
            update: async (key: string, value: unknown) => {
                persistedThemeKey = key;
                persistedThemeValue = value;
            },
        });

        const mockWebHostEnv = createMock<WebHostEnvironment>({
            config: mockConfig,
        });

        const mockQuickInput = createMock<QuickInputService>({
            showQuickPick: (async (
                items: { id: string; label: string }[],
                options?: { onDidChangeActive?: (active: { label: string }[]) => Promise<void> },
            ) => {
                if (options?.onDidChangeActive && items.length > 1) {
                    await options.onDidChangeActive([items[1]]);
                }
                return items[1];
            }) as QuickInputService['showQuickPick'],
        });

        await openThemePicker(
            mockQuickInput,
            'github-dark-default',
            (name) => {
                previewedThemes.push(name);
            },
            mockWebHostEnv,
        );

        expect(previewedThemes.length).toBeGreaterThan(0);
        expect(persistedThemeKey).toBe('appearance.theme');
        expect(persistedThemeValue).toBe(previewedThemes[0]);
    });

    it('reverts to initial theme when picker is cancelled', async () => {
        const previewedThemes: string[] = [];
        const initialTheme = 'github-dark-default';

        const mockQuickInput = createMock<QuickInputService>({
            showQuickPick: (async (
                items: { id: string; label: string }[],
                options?: { onDidChangeActive?: (active: { label: string }[]) => Promise<void> },
            ) => {
                if (options?.onDidChangeActive && items.length > 2) {
                    await options.onDidChangeActive([items[2]]);
                }
                return undefined; // User pressed Escape
            }) as QuickInputService['showQuickPick'],
        });

        await openThemePicker(mockQuickInput, initialTheme, (name) => {
            previewedThemes.push(name);
        });

        // Final theme call must be the initial theme reversion
        expect(previewedThemes[previewedThemes.length - 1]).toBe(initialTheme);
    });
});
