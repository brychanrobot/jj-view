/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { SystemUpdateInfo } from '../../../src/core/host/host-system';
import type { RemoteHostSystem } from '../../../src/core/host/remote-host-system';
import { Uri } from '../../../src/core/uri-utils';
import { toError } from '../../../src/utils/error-utils';
import type { WebHostEnvironment } from '../host/web-host-environment';
import type { NotificationService } from '../notifications/notification-service';
import type { StatusBarService } from '../status/status-bar-service';

export interface UpdateCoordinatorDeps {
    webHostEnv?: WebHostEnvironment;
    activeNotifications: NotificationService;
    statusBarService: StatusBarService;
    host?: RemoteHostSystem;
}

export class UpdateCoordinator {
    private promptedUpdateVersion: string | undefined;

    constructor(readonly deps: UpdateCoordinatorDeps) {}

    handleUpdateInfo(info: SystemUpdateInfo, interactive: boolean): void {
        const { statusBarService, activeNotifications, webHostEnv } = this.deps;
        if (info.updateAvailable) {
            const existing = statusBarService.state.updateAvailable;
            statusBarService.setUpdateAvailable({
                currentVersion: info.currentVersion,
                latestVersion: info.latestVersion,
                releaseUrl: info.releaseUrl,
                releaseNotes: info.releaseNotes,
                prerelease: info.prerelease,
                updating: Boolean(existing && existing.latestVersion === info.latestVersion && existing.updating),
            });

            if (interactive || this.promptedUpdateVersion !== info.latestVersion) {
                this.promptedUpdateVersion = info.latestVersion;
                for (const item of activeNotifications.items) {
                    if (item.message.startsWith('JJ View v') && item.message.includes('is available')) {
                        activeNotifications.dismiss(item.id);
                    }
                }
                void activeNotifications
                    .showInformation(
                        `JJ View v${info.latestVersion} is available (current: v${info.currentVersion}).`,
                        'Update & Restart',
                        'Release Notes',
                    )
                    .then((choice) => {
                        if (choice === 'Update & Restart') {
                            void this.performInstallUpdate();
                        } else if (choice === 'Release Notes' && info.releaseUrl) {
                            void webHostEnv?.nav.openExternal(Uri.parse(info.releaseUrl));
                        }
                    });
            }
            return;
        }

        statusBarService.setUpdateAvailable(undefined);
        if (interactive) {
            if (!info.canSelfUpdate) {
                void activeNotifications.showInformation(
                    `JJ View is at v${info.currentVersion} (self-update is not enabled for development builds).`,
                );
            } else {
                void activeNotifications.showInformation(`JJ View v${info.currentVersion} is up to date.`);
            }
        }
    }

    async performCheckForUpdates(interactive: boolean): Promise<void> {
        const targetHost = this.deps.host ?? this.deps.webHostEnv?.system;
        if (!targetHost?.checkUpdate) {
            return;
        }
        try {
            const info = await targetHost.checkUpdate({ force: interactive });
            this.handleUpdateInfo(info, interactive);
        } catch (err) {
            if (interactive) {
                void this.deps.activeNotifications.showErrorMessage(
                    `Failed to check for updates: ${toError(err).message}`,
                );
            }
        }
    }

    async performInstallUpdate(): Promise<void> {
        const targetHost = this.deps.host ?? this.deps.webHostEnv?.system;
        const applyUpdate = targetHost?.applyUpdate?.bind(targetHost);
        if (!applyUpdate) {
            return;
        }
        const currentUpdate = this.deps.statusBarService.state.updateAvailable;
        if (currentUpdate?.updating) {
            return;
        }
        for (const item of this.deps.activeNotifications.items) {
            if (item.message.startsWith('JJ View v') && item.message.includes('is available')) {
                this.deps.activeNotifications.dismiss(item.id);
            }
        }
        if (currentUpdate) {
            this.deps.statusBarService.setUpdateAvailable({
                ...currentUpdate,
                updating: true,
            });
        }
        const targetLabel = currentUpdate ? `v${currentUpdate.latestVersion}` : 'latest release';
        try {
            const res = await this.deps.statusBarService.withProgress(
                `Updating JJ View to ${targetLabel}...`,
                async () => {
                    return await applyUpdate({
                        prerelease: currentUpdate?.prerelease,
                    });
                },
            );
            this.deps.statusBarService.setUpdateAvailable(undefined);
            const statusMsg = res.restarting
                ? `Updated to v${res.updatedVersion}. Restarting daemon...`
                : `Updated to v${res.updatedVersion}.`;
            this.deps.statusBarService.setMessage(statusMsg, 10000);
        } catch (err) {
            if (currentUpdate) {
                this.deps.statusBarService.setUpdateAvailable({
                    ...currentUpdate,
                    updating: false,
                });
            }
            void this.deps.activeNotifications.showErrorMessage(`Self-update failed: ${toError(err).message}`);
        }
    }
}
