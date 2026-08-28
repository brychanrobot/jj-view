/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { JjServiceConfigProvider } from '../jj-service';

/**
 * Standard configuration provider for 'jj-view' extension settings.
 * Passable directly to JjServiceOptions.getConfig.
 */
export const getJjViewConfig: JjServiceConfigProvider<vscode.ConfigurationScope | null> = <T>(
    key: string,
    defaultValue?: T,
    scope?: vscode.ConfigurationScope | null,
): T | undefined => {
    const config =
        scope !== undefined
            ? vscode.workspace.getConfiguration('jj-view', scope)
            : vscode.workspace.getConfiguration('jj-view');
    return defaultValue !== undefined ? config.get<T>(key, defaultValue) : config.get<T>(key);
};

/**
 * Utility to get configuration values from any workspace configuration section.
 */
export function getWorkspaceConfig<T>(
    section: string,
    key: string,
    defaultValue?: T,
    scope?: vscode.ConfigurationScope | null,
): T | undefined {
    const config =
        scope !== undefined
            ? vscode.workspace.getConfiguration(section, scope)
            : vscode.workspace.getConfiguration(section);
    return defaultValue !== undefined ? config.get<T>(key, defaultValue) : config.get<T>(key);
}

/**
 * Utility to update a 'jj-view' configuration setting.
 */
export function updateJjViewConfig(
    key: string,
    value: unknown,
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
): Thenable<void> {
    const config = vscode.workspace.getConfiguration('jj-view');
    return config.update(key, value, target);
}
