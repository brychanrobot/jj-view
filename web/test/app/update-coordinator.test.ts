/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { SystemUpdateInfo } from '../../../src/core/host/host-system';
import type { RemoteHostSystem } from '../../../src/core/host/remote-host-system';
import { UpdateCoordinator } from '../../src/app/update-coordinator';
import { NotificationService } from '../../src/notifications/notification-service';
import { StatusBarService } from '../../src/status/status-bar-service';
import { createMock } from '../test-mock';

describe('UpdateCoordinator', () => {
    it('handles available update and deduplicates notification prompt per version', () => {
        const notifications = new NotificationService();
        const statusBar = new StatusBarService();

        const coordinator = new UpdateCoordinator({
            activeNotifications: notifications,
            statusBarService: statusBar,
        });

        const updateInfo: SystemUpdateInfo = {
            updateAvailable: true,
            currentVersion: '1.0.0',
            latestVersion: '1.1.0',
            canSelfUpdate: true,
            releaseUrl: 'https://example.com/v1.1.0',
        };

        coordinator.handleUpdateInfo(updateInfo, false);
        expect(statusBar.state.updateAvailable?.latestVersion).toBe('1.1.0');
        expect(notifications.items.length).toBe(1);
        expect(notifications.items[0].message).toContain('JJ View v1.1.0 is available');

        // Calling again silently with same version does not create duplicate prompt
        coordinator.handleUpdateInfo(updateInfo, false);
        expect(notifications.items.length).toBe(1);

        // Calling in interactive mode does prompt again
        coordinator.handleUpdateInfo(updateInfo, true);
        expect(notifications.items.length).toBe(1); // Old dismissed, new shown
    });

    it('shows informative notification in interactive mode when up to date', () => {
        const notifications = new NotificationService();
        const statusBar = new StatusBarService();

        const coordinator = new UpdateCoordinator({
            activeNotifications: notifications,
            statusBarService: statusBar,
        });

        const upToDateInfo: SystemUpdateInfo = {
            updateAvailable: false,
            currentVersion: '1.0.0',
            latestVersion: '1.0.0',
            canSelfUpdate: true,
        };

        // Silent mode: no toast
        coordinator.handleUpdateInfo(upToDateInfo, false);
        expect(notifications.items.length).toBe(0);

        // Interactive mode: shows up-to-date message
        coordinator.handleUpdateInfo(upToDateInfo, true);
        expect(notifications.items.length).toBe(1);
        expect(notifications.items[0].message).toBe('JJ View v1.0.0 is up to date.');
    });

    it('performs update check and install flow', async () => {
        const notifications = new NotificationService();
        const statusBar = new StatusBarService();
        let updateApplied = false;

        const mockHost = createMock<RemoteHostSystem>({
            checkUpdate: async () => ({
                updateAvailable: true,
                currentVersion: '1.0.0',
                latestVersion: '1.2.0',
                canSelfUpdate: true,
            }),
            applyUpdate: async () => {
                updateApplied = true;
                return {
                    previousVersion: '1.0.0',
                    binaryPath: '/path/to/bin',
                    updatedVersion: '1.2.0',
                    restarting: true,
                };
            },
        });

        const coordinator = new UpdateCoordinator({
            activeNotifications: notifications,
            statusBarService: statusBar,
            host: mockHost,
        });

        await coordinator.performCheckForUpdates(true);
        expect(statusBar.state.updateAvailable?.latestVersion).toBe('1.2.0');

        await coordinator.performInstallUpdate();
        expect(updateApplied).toBe(true);
        expect(statusBar.state.updateAvailable).toBeUndefined();
    });

    it('handles install update failure by resetting updating flag and showing error toast', async () => {
        const notifications = new NotificationService();
        const statusBar = new StatusBarService();

        statusBar.setUpdateAvailable({
            currentVersion: '1.0.0',
            latestVersion: '1.2.0',
            updating: false,
        });

        const mockHost = createMock<RemoteHostSystem>({
            applyUpdate: async () => {
                throw new Error('Network timeout during download');
            },
        });

        const coordinator = new UpdateCoordinator({
            activeNotifications: notifications,
            statusBarService: statusBar,
            host: mockHost,
        });

        await coordinator.performInstallUpdate();
        expect(statusBar.state.updateAvailable?.updating).toBe(false);
        expect(notifications.items.some((item) => item.message.includes('Self-update failed'))).toBe(true);
    });
});
