/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HostConfig } from '../../../src/core/host/host-environment';
import type { RemoteHostSystem } from '../../../src/core/host/remote-host-system';

export type SettingsScope = 'user' | 'workspace';

/**
 * Loads all configuration key-value pairs for a specific scope ('user' | 'workspace')
 * from the host daemon.
 */
export async function loadScopedSettings(
    system?: RemoteHostSystem | null,
    scope: SettingsScope = 'user',
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
        await config.update(key, value);
    }
}
