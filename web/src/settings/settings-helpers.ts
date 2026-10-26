/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HostConfig } from '../../../src/core/host/host-environment';
import type { RemoteHostSystem } from '../../../src/core/host/remote-host-system';
import type { SettingDefinition } from './settings-schema';

export type SettingsScope = 'user' | 'workspace';
export type SettingsReadScope = 'effective' | 'user' | 'vscode-user' | 'workspace' | 'vscode-workspace';

export interface SettingSourceBadge {
    readonly label: string;
    readonly tooltip: string;
    readonly kind: 'standalone' | 'vscode' | 'inherited' | 'overridden';
}

export interface SettingDisplayInfo {
    readonly value: unknown;
    readonly isModifiedInScope: boolean;
    readonly canResetInScope: boolean;
    readonly badges: readonly SettingSourceBadge[];
}

export interface LayeredSettingsMaps {
    readonly userConfig: Record<string, unknown>;
    readonly vscodeUserConfig: Record<string, unknown>;
    readonly workspaceConfig: Record<string, unknown>;
    readonly vscodeWorkspaceConfig: Record<string, unknown>;
}

/**
 * Normalizes a setting key by stripping any leading `jj-view.` prefix.
 */
export function normalizeSettingKey(key: string): string {
    return key.replace(/^jj-view\./, '');
}

/**
 * Looks up a setting key in a scoped config map, checking exact, normalized,
 * and `jj-view.`-prefixed variants.
 */
export function lookupInConfigMap(scopeData: Record<string, unknown>, key: string): unknown {
    const norm = normalizeSettingKey(key);
    if (scopeData[`jj-view.${norm}`] !== undefined) {
        return scopeData[`jj-view.${norm}`];
    }
    if (scopeData[key] !== undefined) {
        return scopeData[key];
    }
    if (scopeData[norm] !== undefined) {
        return scopeData[norm];
    }
    return undefined;
}

/**
 * Resolves the displayed value, modification state, reset availability, and
 * provenance badges for a setting in the active scope ('user' | 'workspace')
 * across all 4 configuration layers (`.jj-view/config.json`, `.vscode/settings.json`,
 * `~/.config/jj-view/config.json`, and VS Code `User/settings.json`).
 */
export function resolveSettingDisplayInfo(
    setting: SettingDefinition,
    activeScope: SettingsScope,
    layers: LayeredSettingsMaps,
    hostConfig?: HostConfig | null,
): SettingDisplayInfo {
    const wsVal = lookupInConfigMap(layers.workspaceConfig, setting.key);
    const vscodeWsVal = lookupInConfigMap(layers.vscodeWorkspaceConfig, setting.key);
    const userVal = lookupInConfigMap(layers.userConfig, setting.key);
    const vscodeUserVal = lookupInConfigMap(layers.vscodeUserConfig, setting.key);

    const badges: SettingSourceBadge[] = [];

    if (activeScope === 'workspace') {
        if (wsVal !== undefined) {
            badges.push({
                label: '.jj-view/config.json',
                tooltip:
                    vscodeWsVal !== undefined
                        ? 'Configured in standalone workspace config (.jj-view/config.json), overriding .vscode/settings.json'
                        : 'Configured in standalone workspace config (.jj-view/config.json)',
                kind: 'standalone',
            });
        } else if (vscodeWsVal !== undefined) {
            badges.push({
                label: 'From .vscode/settings.json',
                tooltip:
                    'Inherited from VS Code workspace settings (.vscode/settings.json). Saving here writes to .jj-view/config.json.',
                kind: 'vscode',
            });
        } else if (userVal !== undefined) {
            badges.push({
                label: 'From User (~/.config/jj-view)',
                tooltip: 'Inherited from standalone user config (~/.config/jj-view/config.json)',
                kind: 'inherited',
            });
        } else if (vscodeUserVal !== undefined) {
            badges.push({
                label: 'From VS Code User',
                tooltip: 'Inherited from VS Code user settings (~/.config/Code/User/settings.json)',
                kind: 'inherited',
            });
        }

        const value =
            wsVal ??
            vscodeWsVal ??
            userVal ??
            vscodeUserVal ??
            hostConfig?.get(setting.key, undefined) ??
            setting.default;
        const isModifiedInScope = wsVal !== undefined || vscodeWsVal !== undefined;
        return {
            value,
            isModifiedInScope,
            canResetInScope: isModifiedInScope,
            badges,
        };
    }

    // activeScope === 'user'
    if (userVal !== undefined) {
        badges.push({
            label: '~/.config/jj-view/config.json',
            tooltip:
                vscodeUserVal !== undefined
                    ? 'Configured in standalone user config (~/.config/jj-view/config.json), overriding VS Code User settings'
                    : 'Configured in standalone user config (~/.config/jj-view/config.json)',
            kind: 'standalone',
        });
    } else if (vscodeUserVal !== undefined) {
        badges.push({
            label: 'From VS Code User Settings',
            tooltip:
                'Inherited from VS Code user settings (~/.config/Code/User/settings.json). Saving here writes to ~/.config/jj-view/config.json.',
            kind: 'vscode',
        });
    }

    if (wsVal !== undefined) {
        badges.push({
            label: 'Overridden in .jj-view/config.json',
            tooltip: `Overridden in this workspace by .jj-view/config.json (${String(wsVal)})`,
            kind: 'overridden',
        });
    } else if (vscodeWsVal !== undefined) {
        badges.push({
            label: 'Overridden in .vscode/settings.json',
            tooltip: `Overridden in this workspace by .vscode/settings.json (${String(vscodeWsVal)})`,
            kind: 'overridden',
        });
    }

    const fallbackEffective =
        wsVal === undefined && vscodeWsVal === undefined ? hostConfig?.get(setting.key, undefined) : undefined;
    const value = userVal ?? vscodeUserVal ?? fallbackEffective ?? setting.default;
    const isModifiedInScope = userVal !== undefined;

    return {
        value,
        isModifiedInScope,
        canResetInScope: isModifiedInScope,
        badges,
    };
}

/**
 * Loads all configuration key-value pairs for a specific scope
 * from the host daemon.
 */
export async function loadScopedSettings(
    system?: RemoteHostSystem | null,
    scope: SettingsReadScope = 'user',
): Promise<Record<string, unknown>> {
    if (!system || typeof system.getAllConfig !== 'function') {
        return {};
    }
    return system.getAllConfig(scope);
}

/**
 * Saves a setting at a specific scope ('user' | 'workspace') to the host daemon
 * and updates the HostConfig instance so reactive listeners are notified.
 */
export async function saveScopedSetting(
    system: RemoteHostSystem | null | undefined,
    config: HostConfig | null | undefined,
    key: string,
    value: unknown,
    scope: SettingsScope = 'user',
): Promise<void> {
    if (system && typeof system.setConfig === 'function') {
        await system.setConfig(key, value, scope);
    }
    if (config && typeof config.update === 'function') {
        await config.update(key, value, scope);
    }
}
