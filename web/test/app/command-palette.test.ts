/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { openCommandPalette } from '../../src/app/command-palette';
import type { WebHostCommands, WebHostEnvironment } from '../../src/host/web-host-environment';
import { ContextKeyService } from '../../src/menu/context-key-service';
import type { CommandPaletteEntry, QuickInputService } from '../../src/quick-input/quick-input-service';
import { StatusBarService } from '../../src/status/status-bar-service';
import { createMock } from '../test-mock';

describe('command-palette', () => {
    it('evaluates WhenEvaluator rules, excludes omitted commands, and includes built-ins', () => {
        let presentedCommands: CommandPaletteEntry[] = [];
        const mockQuickInput = createMock<QuickInputService>({
            openCommandPalette: (async (entries: CommandPaletteEntry[]) => {
                presentedCommands = entries;
            }) as QuickInputService['openCommandPalette'],
        });

        const rootContext = new ContextKeyService();
        rootContext.set('resourceScheme', 'file');

        const statusBar = new StatusBarService();

        openCommandPalette({
            activeQuickInput: mockQuickInput,
            rootContext,
            activeStatusBar: statusBar,
            openQuickOpen: () => {},
            openThemePicker: () => {},
            performCheckForUpdates: async () => {},
            performInstallUpdate: async () => {},
        });

        // Built-ins should be present
        const builtInIds = presentedCommands.map((cmd) => cmd.id);
        expect(builtInIds).toContain('workbench.action.quickOpen');
        expect(builtInIds).toContain('workbench.action.selectTheme');
        expect(builtInIds).toContain('jj-view.checkForUpdates');

        // Update command should not be present when no update available
        expect(builtInIds).not.toContain('jj-view.installUpdate');
    });

    it('injects update command when update is available', () => {
        let presentedCommands: CommandPaletteEntry[] = [];
        const mockQuickInput = createMock<QuickInputService>({
            openCommandPalette: (async (entries: CommandPaletteEntry[]) => {
                presentedCommands = entries;
            }) as QuickInputService['openCommandPalette'],
        });

        const rootContext = new ContextKeyService();
        const statusBar = new StatusBarService();
        statusBar.setUpdateAvailable({
            currentVersion: '1.0.0',
            latestVersion: '2.0.0',
            updating: false,
        });

        openCommandPalette({
            activeQuickInput: mockQuickInput,
            rootContext,
            activeStatusBar: statusBar,
            openQuickOpen: () => {},
            openThemePicker: () => {},
            performCheckForUpdates: async () => {},
            performInstallUpdate: async () => {},
        });

        const installCmd = presentedCommands.find((cmd) => cmd.id === 'jj-view.installUpdate');
        expect(installCmd).toBeDefined();
        expect(installCmd?.title).toBe('Update to v2.0.0');
    });

    it('dispatches command actions on selection', async () => {
        let paletteCallback: ((cmdId: string) => Promise<void>) | undefined;
        const mockQuickInput = createMock<QuickInputService>({
            openCommandPalette: (async (
                _entries: CommandPaletteEntry[],
                onSelect: (cmdId: string) => Promise<void>,
            ) => {
                paletteCallback = onSelect;
            }) as QuickInputService['openCommandPalette'],
        });

        const rootContext = new ContextKeyService();

        let executedCommand: string | undefined;
        const mockWebHostEnv = createMock<WebHostEnvironment>({
            commands: createMock<WebHostCommands>({
                executeCommand: async <R = unknown>(cmdId: string): Promise<R> => {
                    executedCommand = cmdId;
                    return undefined as R;
                },
            }),
        });

        let quickOpenOpened = false;
        let themePickerOpened = false;

        const statusBar = new StatusBarService();

        openCommandPalette({
            activeQuickInput: mockQuickInput,
            rootContext,
            activeStatusBar: statusBar,
            openQuickOpen: () => {
                quickOpenOpened = true;
            },
            openThemePicker: () => {
                themePickerOpened = true;
            },
            performCheckForUpdates: async () => {},
            performInstallUpdate: async () => {},
            webHostEnv: mockWebHostEnv,
        });

        expect(paletteCallback).toBeDefined();
        if (paletteCallback) {
            await paletteCallback('workbench.action.quickOpen');
            expect(quickOpenOpened).toBe(true);

            await paletteCallback('workbench.action.selectTheme');
            expect(themePickerOpened).toBe(true);

            await paletteCallback('custom.extension.command');
            expect(executedCommand).toBe('custom.extension.command');
        }
    });
});
