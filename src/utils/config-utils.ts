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
export const getJjViewConfig: JjServiceConfigProvider = <T>(key: string, defaultValue?: T): T | undefined => {
    const config = vscode.workspace.getConfiguration('jj-view');
    return defaultValue !== undefined ? config.get<T>(key, defaultValue) : config.get<T>(key);
};
