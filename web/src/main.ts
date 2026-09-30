/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mount } from 'svelte';
import { CodeForgeAuthManager } from '../../src/core/code-forge-auth';
import type { CodeForgeProvider } from '../../src/core/code-forge-provider';
import { CodeForgeRegistry } from '../../src/core/code-forge-registry';
import { LogViewController } from '../../src/core/controllers/log-view-controller';
import { GitHubProvider } from '../../src/core/github-provider';
import { GitLabProvider } from '../../src/core/gitlab-provider';
import { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import { JjEditFsService } from '../../src/core/jj-edit-fs-service';
import { JjRepository } from '../../src/core/jj-repository';
import { JjRepositoryManager } from '../../src/core/jj-repository-manager';
import { JjViewFsService } from '../../src/core/jj-view-fs-service';
import { ScmModel } from '../../src/core/scm-model';
import { Uri } from '../../src/core/uri-utils';
import { toError } from '../../src/utils/error-utils';
import { NO_OP_LOGGER } from '../../src/utils/output-channel';
import App from './App.svelte';
import { createInMemoryBridge } from './bridge/in-memory-bridge';
import { registerWebCommands } from './commands/register-web-commands';
import { WebHostEnvironment } from './host/web-host-environment';
import './styles/vscode-theme.css';
import '../../media/themes.generated.css';
import '../../media/main.css';

declare global {
    interface Window {
        __JJ_VIEW_ENV__?: WebHostEnvironment;
        __JJ_VIEW_REPO_MANAGER__?: JjRepositoryManager;
    }
}

export async function bootstrap(): Promise<void> {
    const target = document.getElementById('app');
    if (!target) {
        return;
    }

    try {
        const hostSystem = new RemoteHostSystem();
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error('Connection timed out. JJ View host daemon is unreachable.'));
            }, 5000);
        });
        await Promise.race([hostSystem.ready, timeoutPromise]);

        const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
        if (typeof window !== 'undefined' && urlParams?.has('token')) {
            const cleanUrl = new URL(window.location.href);
            cleanUrl.searchParams.delete('token');
            window.history.replaceState({}, '', cleanUrl.toString());
        }

        function getFsPathFromUriString(uriStr: string): string {
            if (uriStr.startsWith('file://')) {
                return Uri.parse(uriStr).fsPath;
            }
            return uriStr;
        }

        const repoFromQuery = urlParams?.get('repo');
        let repoRoot =
            repoFromQuery ||
            hostSystem.repoRoot ||
            (typeof window !== 'undefined' ? window.__JJ_VIEW_CONFIG__?.repoRoot : undefined) ||
            '.';

        let initialFolders: { uri: Uri; name: string }[] | undefined;
        if (typeof window !== 'undefined' && window.sidecar?.getWorkspaceUris) {
            try {
                const uris = await window.sidecar.getWorkspaceUris();
                if (uris.length > 0) {
                    initialFolders = uris.map((rawUri) => {
                        const fsPath = getFsPathFromUriString(rawUri);
                        return {
                            uri: Uri.file(fsPath),
                            name:
                                fsPath
                                    .replace(/[/\\]+$/, '')
                                    .split(/[/\\]/)
                                    .pop() || 'Workspace',
                        };
                    });
                    for (const folder of initialFolders) {
                        try {
                            await hostSystem.request('workspace.addAllowedRoot', { path: folder.uri.fsPath });
                        } catch (err) {
                            NO_OP_LOGGER.warn(
                                `Failed to add allowed root for sidecar workspace: ${toError(err).message}`,
                            );
                        }
                    }
                    if (!repoFromQuery) {
                        const firstPath = getFsPathFromUriString(uris[0]);
                        if (firstPath) {
                            repoRoot = firstPath;
                        }
                    }
                }
            } catch (err) {
                NO_OP_LOGGER.warn(`Failed to get initial workspace URIs from sidecar: ${toError(err).message}`);
            }
        }

        const webHostEnv = new WebHostEnvironment(hostSystem, repoRoot);
        if (initialFolders && initialFolders.length > 0) {
            webHostEnv.workspace.setWorkspaceFolders(initialFolders);
        }
        if (typeof window !== 'undefined') {
            window.__JJ_VIEW_ENV__ = webHostEnv;
        }

        const codeForgeRegistry = new CodeForgeRegistry();
        const authManager = new CodeForgeAuthManager(webHostEnv, NO_OP_LOGGER);
        codeForgeRegistry.register({
            id: 'github',
            create: (outputChannel) => new GitHubProvider(authManager, outputChannel),
        });
        codeForgeRegistry.register({
            id: 'gitlab',
            create: (outputChannel, host) => new GitLabProvider(authManager, outputChannel, host),
        });

        const repoManager = new JjRepositoryManager(codeForgeRegistry, NO_OP_LOGGER, webHostEnv);
        if (typeof window !== 'undefined') {
            window.__JJ_VIEW_REPO_MANAGER__ = repoManager;
        }

        authManager.onDidAuthenticate(() => {
            for (const r of repoManager.repositories) {
                r.codeForge
                    .detectActiveProvider(true)
                    .then((changed) => {
                        if (!changed) {
                            r.codeForge.forceRefresh();
                        }
                    })
                    .catch((e: unknown) => {
                        NO_OP_LOGGER.error('Failed to refresh after authentication', toError(e));
                    });
            }
        });

        if (webHostEnv.sidecar.isAvailable) {
            webHostEnv.sidecar.onDidChangeWorkspace(async (uris) => {
                if (uris.length === 0) {
                    return;
                }
                const folders = uris.map((rawUri) => {
                    const fsPath = getFsPathFromUriString(rawUri);
                    return {
                        uri: Uri.file(fsPath),
                        name:
                            fsPath
                                .replace(/[/\\]+$/, '')
                                .split(/[/\\]/)
                                .pop() || 'Workspace',
                    };
                });
                for (const folder of folders) {
                    try {
                        await hostSystem.request('workspace.addAllowedRoot', { path: folder.uri.fsPath });
                    } catch (e) {
                        NO_OP_LOGGER.warn(`Failed to add allowed root for workspace: ${toError(e).message}`);
                    }
                    await repoManager.maybeRegisterRepositoryContainingUri(folder.uri);
                }
                webHostEnv.workspace.setWorkspaceFolders(folders);
                const matchedRepo = repoManager.repositories.find((r) =>
                    folders.some((f) => r.rootUri.fsPath === f.uri.fsPath || f.uri.fsPath.startsWith(r.rootUri.fsPath)),
                );
                if (matchedRepo) {
                    repoManager.setFocusedRepository(matchedRepo);
                }
            });
        }

        await repoManager.restoreCachedRepositories();
        await repoManager.scanForRepositories();
        let repo: JjRepository | undefined = repoManager.repositories[0];
        if (!repo) {
            repo = await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repoRoot));
        }
        if (!repo) {
            const storePath = `${repoRoot}/.jj/repo`;
            repo = new JjRepository(Uri.file(repoRoot), storePath, codeForgeRegistry, NO_OP_LOGGER, webHostEnv);
        }
        repoManager.registerRepositoryInstance(repo);

        const scmModel = new ScmModel(repo, NO_OP_LOGGER);
        await scmModel.refresh({ reason: 'initial' });

        const viewFs = new JjViewFsService(repoManager);
        const editFs = new JjEditFsService(repoManager, async () => {
            await scmModel.refresh({ reason: 'edit-fs-write' });
        });

        let logController: LogViewController | undefined;
        const logBridge = createInMemoryBridge(async (msg) => {
            if (logController) {
                await logController.handleMessage(msg);
            }
        });

        logController = new LogViewController(repo, webHostEnv, {
            messenger: logBridge.messenger,
            logger: NO_OP_LOGGER,
            onSelectionChange: (ids) => {
                scmModel.handleSelectionChange(ids);
            },
        });

        webHostEnv.nav.setHighlightDelegate((_repoRoot, changeId) => {
            logController?.setHighlightedCommit(changeId);
        });

        registerWebCommands({
            repositoryManager: repoManager,
            hostEnvironment: webHostEnv,
            logger: NO_OP_LOGGER,
            scmModel,
            logViewController: logController,
            authManager,
        });

        const updateContextKeys = (provider: CodeForgeProvider | undefined) => {
            void webHostEnv.commands.setContextKey('jj.codeForgeActive', !!provider);
            void webHostEnv.commands.setContextKey('jj.codeForgeProvider', provider?.id);
            const manageable = !!provider?.isAuthManageable;
            void webHostEnv.commands.setContextKey('jj.codeForgeAuthManageable', manageable);
            void webHostEnv.commands.setContextKey('jj.codeForgeTerm', provider?.changeTerm?.toLowerCase() || 'change');
        };

        let activeProviderSub: { dispose: () => void } | undefined;
        const updateCodeForgeContext = (activeRepo: JjRepository | undefined) => {
            activeProviderSub?.dispose();
            if (activeRepo) {
                activeProviderSub = activeRepo.codeForge.onDidActiveProviderChange((provider) => {
                    updateContextKeys(provider);
                });
                activeRepo.codeForge
                    .detectActiveProvider(true)
                    .then(() => {
                        updateContextKeys(activeRepo.codeForge.activeProvider);
                    })
                    .catch(() => {});
            } else {
                activeProviderSub = undefined;
                updateContextKeys(undefined);
            }
        };

        repoManager.onDidChangeFocusedRepository((r) => {
            updateCodeForgeContext(r);
        });
        updateCodeForgeContext(repo);

        mount(App, {
            target,
            props: {
                host: hostSystem,
                webHostEnv,
                scmModel,
                initialSnapshot: scmModel.snapshot,
                workspaceRoot: repoRoot,
                viewFs,
                editFs,
                logTransport: logBridge.transport,
            },
        });
    } catch (err) {
        console.error('Failed to bootstrap JJ View standalone web application:', err);
        if (target) {
            target.textContent = '';
            const container = document.createElement('div');
            container.style.cssText = 'padding: 24px; color: #f48771; font-family: sans-serif;';

            const heading = document.createElement('h2');
            heading.textContent = 'Failed to connect to JJ View host daemon';

            const msg = document.createElement('p');
            msg.textContent = err instanceof Error ? err.message : String(err);

            const hint = document.createElement('p');
            hint.textContent = 'Make sure the jj-view daemon is running and refresh this page.';

            const retryBtn = document.createElement('button');
            retryBtn.textContent = 'Retry Connection';
            retryBtn.style.cssText =
                'margin-top: 12px; padding: 6px 14px; background: #007acc; color: white; border: none; border-radius: 4px; cursor: pointer;';
            retryBtn.onclick = () => {
                if (typeof window !== 'undefined') {
                    window.location.reload();
                }
            };

            container.append(heading, msg, hint, retryBtn);
            target.appendChild(container);
        }
    }
}

void bootstrap();
