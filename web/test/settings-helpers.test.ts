/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import '../../src/test/vitest-utils';
import type { HostConfig } from '../../src/core/host/host-environment';
import type { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import { loadScopedSettings, saveScopedSetting } from '../src/settings/settings-helpers';
import { createMock } from './test-mock';

describe('settings-helpers', () => {
    describe('loadScopedSettings', () => {
        it('returns empty record when system is undefined or lacks getAllConfig', async () => {
            expect(await loadScopedSettings(undefined, 'user')).toEqual({});
            expect(await loadScopedSettings(null, 'workspace')).toEqual({});

            const noGetAllConfig = createMock<RemoteHostSystem>({});
            expect(await loadScopedSettings(noGetAllConfig, 'user')).toEqual({});
        });

        it('delegates to system.getAllConfig with the given scope', async () => {
            const getAllConfigMock = vi.fn().mockResolvedValue({ 'appearance.theme': 'pierre-dark' });
            const mockSystem = createMock<RemoteHostSystem>({
                getAllConfig: getAllConfigMock,
            });

            const result = await loadScopedSettings(mockSystem, 'workspace');
            expect(getAllConfigMock).toHaveBeenCalledWith('workspace');
            expect(result).toEqual({ 'appearance.theme': 'pierre-dark' });
        });
    });

    describe('saveScopedSetting', () => {
        it('updates host system and host config when provided', async () => {
            const setConfigMock = vi.fn().mockResolvedValue(undefined);
            const mockSystem = createMock<RemoteHostSystem>({
                setConfig: setConfigMock,
            });

            const updateConfigMock = vi.fn().mockResolvedValue(undefined);
            const mockConfig = createMock<HostConfig>({
                update: updateConfigMock,
            });

            await saveScopedSetting(mockSystem, mockConfig, 'appearance.theme', 'pierre-light', 'user');

            expect(setConfigMock).toHaveBeenCalledWith('appearance.theme', 'pierre-light', 'user');
            expect(updateConfigMock).toHaveBeenCalledWith('appearance.theme', 'pierre-light');
        });

        it('handles null/undefined system or config gracefully', async () => {
            const setConfigMock = vi.fn().mockResolvedValue(undefined);
            const mockSystem = createMock<RemoteHostSystem>({
                setConfig: setConfigMock,
            });
            await saveScopedSetting(mockSystem, undefined, 'appearance.theme', 'pierre-light', 'workspace');
            expect(setConfigMock).toHaveBeenCalledWith('appearance.theme', 'pierre-light', 'workspace');

            const updateConfigMock = vi.fn().mockResolvedValue(undefined);
            const mockConfig = createMock<HostConfig>({
                update: updateConfigMock,
            });
            await saveScopedSetting(undefined, mockConfig, 'appearance.theme', 'pierre-light', 'workspace');
            expect(updateConfigMock).toHaveBeenCalledWith('appearance.theme', 'pierre-light');
        });
    });
});
