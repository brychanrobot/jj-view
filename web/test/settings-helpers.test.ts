/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import '../../src/test/vitest-utils';
import type { HostConfig } from '../../src/core/host/host-environment';
import type { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import { loadScopedSettings, resolveSettingDisplayInfo, saveScopedSetting } from '../src/settings/settings-helpers';
import type { SettingDefinition } from '../src/settings/settings-schema';
import { createMock } from './test-mock';

const UPLOAD_SETTING: SettingDefinition = {
    key: 'uploadCommand',
    title: 'Upload Command',
    description: 'Command run by upload',
    type: 'string',
    default: 'git push',
    category: 'Git & Remote',
};

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
            expect(updateConfigMock).toHaveBeenCalledWith('appearance.theme', 'pierre-light', 'user');
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
            expect(updateConfigMock).toHaveBeenCalledWith('appearance.theme', 'pierre-light', 'workspace');
        });
    });

    describe('resolveSettingDisplayInfo', () => {
        it('shows VS Code User Settings provenance and workspace override badge in user tab', () => {
            const info = resolveSettingDisplayInfo(UPLOAD_SETTING, 'user', {
                userConfig: {},
                vscodeUserConfig: { 'jj-view.uploadCommand': 'upload -d --allow-warnings --parallel' },
                workspaceConfig: { 'jj-view.uploadCommand': 'upload --ws' },
                vscodeWorkspaceConfig: {},
            });

            expect(info.value).toBe('upload -d --allow-warnings --parallel');
            expect(info.isModifiedInScope).toBe(false);
            expect(info.badges.map((b) => b.label)).toEqual([
                'From VS Code User Settings',
                'Overridden in .jj-view/config.json',
            ]);
        });

        it('shows .vscode/settings.json provenance in workspace tab when standalone workspace config is unset', () => {
            const info = resolveSettingDisplayInfo(UPLOAD_SETTING, 'workspace', {
                userConfig: { uploadCommand: 'upload --user' },
                vscodeUserConfig: {},
                workspaceConfig: {},
                vscodeWorkspaceConfig: { 'jj-view.uploadCommand': 'upload --vscode-ws' },
            });

            expect(info.value).toBe('upload --vscode-ws');
            expect(info.isModifiedInScope).toBe(true);
            expect(info.canResetInScope).toBe(true);
            expect(info.badges.map((b) => b.label)).toEqual(['From .vscode/settings.json']);
        });

        it('prefers .jj-view/config.json over .vscode/settings.json in workspace tab', () => {
            const info = resolveSettingDisplayInfo(UPLOAD_SETTING, 'workspace', {
                userConfig: {},
                vscodeUserConfig: {},
                workspaceConfig: { 'jj-view.uploadCommand': 'upload --jj-view-ws' },
                vscodeWorkspaceConfig: { 'jj-view.uploadCommand': 'upload --vscode-ws' },
            });

            expect(info.value).toBe('upload --jj-view-ws');
            expect(info.isModifiedInScope).toBe(true);
            expect(info.badges.map((b) => b.label)).toEqual(['.jj-view/config.json']);
        });
    });
});
