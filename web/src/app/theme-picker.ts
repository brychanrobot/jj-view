/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { applyAppTheme, loadTheme } from '../diff/highlighter-setup';
import type { WebHostEnvironment } from '../host/web-host-environment';
import type { QuickInputService } from '../quick-input/quick-input-service';
import { AVAILABLE_THEMES, THEME_DESCRIPTIONS } from '../settings/settings-schema';

let themeRequestId = 0;

export async function applyTheme(themeName: string, onThemeChange: (name: string) => void): Promise<void> {
    const requestId = ++themeRequestId;
    onThemeChange(themeName);
    try {
        const theme = await loadTheme(themeName);
        if (requestId !== themeRequestId) {
            return;
        }
        applyAppTheme(theme);
    } catch (err) {
        console.error(`Failed to load theme "${themeName}":`, err);
    }
}

export async function openThemePicker(
    activeQuickInput: QuickInputService,
    currentTheme: string,
    onThemeChange: (name: string) => void,
    webHostEnv?: WebHostEnvironment,
): Promise<void> {
    const initialTheme = currentTheme;
    const items = AVAILABLE_THEMES.map((themeId, idx) => ({
        id: themeId,
        label: themeId,
        description: THEME_DESCRIPTIONS[idx] ?? '',
        iconClass: themeId === initialTheme ? 'codicon codicon-check' : undefined,
    }));
    const activeItem = items.find((it) => it.id === initialTheme);

    const selected = await activeQuickInput.showQuickPick(items, {
        title: 'Select Color Theme',
        matchOnDescription: true,
        activeItem,
        onDidChangeActive: async (activeItems) => {
            const current = activeItems[0];
            if (current) {
                await applyTheme(current.label, onThemeChange);
            }
        },
    });

    if (selected) {
        if (webHostEnv) {
            await webHostEnv.config.update('appearance.theme', selected.label);
        } else {
            await applyTheme(selected.label, onThemeChange);
        }
    } else {
        await applyTheme(initialTheme, onThemeChange);
    }
}
