/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { WebHostEnvironment } from '../host/web-host-environment';
import type { ContextKeyService } from '../menu/context-key-service';
import { DEFAULT_PACKAGE_JSON_CONTRIBUTES } from '../menu/default-menus';
import { WhenEvaluator } from '../menu/when-evaluator';
import type { CommandPaletteEntry, QuickInputService } from '../quick-input/quick-input-service';
import type { StatusBarService } from '../status/status-bar-service';

export interface CommandPaletteOptions {
    activeQuickInput: QuickInputService;
    rootContext: ContextKeyService;
    activeStatusBar: StatusBarService;
    openQuickOpen: () => void | Promise<void>;
    openThemePicker: () => void | Promise<void>;
    performCheckForUpdates: (interactive: boolean) => Promise<void>;
    performInstallUpdate: () => Promise<void>;
    webHostEnv?: WebHostEnvironment;
}

export function openCommandPalette(options: CommandPaletteOptions): void {
    const {
        activeQuickInput,
        rootContext,
        activeStatusBar,
        openQuickOpen,
        openThemePicker,
        performCheckForUpdates,
        performInstallUpdate,
        webHostEnv,
    } = options;

    const rawCommands = DEFAULT_PACKAGE_JSON_CONTRIBUTES.commands || [];
    const paletteRules = DEFAULT_PACKAGE_JSON_CONTRIBUTES.menus?.commandPalette || [];

    // Map rules by command
    const ruleByCommand = new Map<string, (typeof paletteRules)[number]>();
    for (const rule of paletteRules) {
        ruleByCommand.set(rule.command, rule);
    }

    const commands: CommandPaletteEntry[] = [];
    const seenIds = new Set<string>();

    for (const cmd of rawCommands) {
        // Check omission rules from package.json commandPalette menu
        const rule = ruleByCommand.get(cmd.command);
        if (rule) {
            if (rule.when === 'false') {
                continue;
            }
            if (rule.when && !WhenEvaluator.evaluate(rule.when, rootContext)) {
                continue;
            }
        }

        seenIds.add(cmd.command);
        let iconClass: string | undefined;
        if (cmd.icon) {
            const iconStr = typeof cmd.icon === 'string' ? cmd.icon : cmd.icon.dark || cmd.icon.light;
            if (iconStr) {
                const match = /^\$\((.*?)\)$/.exec(iconStr);
                iconClass = match ? `codicon codicon-${match[1]}` : undefined;
            }
        }
        commands.push({
            id: cmd.command,
            title: cmd.title,
            category: cmd.category,
            iconClass,
        });
    }

    const builtIns: CommandPaletteEntry[] = [
        {
            id: 'workbench.action.quickOpen',
            title: 'Go to File...',
            category: 'File',
            iconClass: 'codicon codicon-go-to-file',
        },
        {
            id: 'workbench.action.openSettings',
            title: 'Open Settings',
            category: 'Preferences',
            iconClass: 'codicon codicon-settings-gear',
        },
        {
            id: 'workbench.action.selectTheme',
            title: 'Color Theme',
            category: 'Preferences',
            iconClass: 'codicon codicon-color-mode',
        },
        {
            id: 'jj-view.showOutput',
            title: 'Show Output Log',
            category: 'View',
            iconClass: 'codicon codicon-output',
        },
        {
            id: 'jj-view.checkForUpdates',
            title: 'Check for Updates',
            category: 'Help',
            iconClass: 'codicon codicon-cloud-download',
        },
    ];

    const availableUpdate = activeStatusBar.state.updateAvailable;
    if (availableUpdate) {
        builtIns.push({
            id: 'jj-view.installUpdate',
            title: `Update to v${availableUpdate.latestVersion}`,
            category: 'Help',
            iconClass: 'codicon codicon-cloud-download',
        });
    }

    for (const b of builtIns) {
        if (!seenIds.has(b.id)) {
            seenIds.add(b.id);
            commands.push(b);
        }
    }

    void activeQuickInput.openCommandPalette(commands, async (cmdId) => {
        if (cmdId === 'workbench.action.quickOpen') {
            await openQuickOpen();
            return;
        }
        if (cmdId === 'workbench.action.selectTheme') {
            await openThemePicker();
            return;
        }
        if (webHostEnv) {
            await webHostEnv.commands.executeCommand(cmdId);
            return;
        }
        if (cmdId === 'jj-view.checkForUpdates') {
            await performCheckForUpdates(true);
            return;
        }
        if (cmdId === 'jj-view.installUpdate') {
            await performInstallUpdate();
        }
    });
}
