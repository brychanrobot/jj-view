/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mount } from 'svelte';
import { CodeForgeRegistry } from '../../src/core/code-forge-registry';
import { LogViewController } from '../../src/core/controllers/log-view-controller';
import { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import { JjEditFsService } from '../../src/core/jj-edit-fs-service';
import { JjRepository } from '../../src/core/jj-repository';
import { JjRepositoryManager } from '../../src/core/jj-repository-manager';
import { JjViewFsService } from '../../src/core/jj-view-fs-service';
import { ScmModel } from '../../src/core/scm-model';
import { Uri } from '../../src/core/uri-utils';
import { NO_OP_LOGGER } from '../../src/utils/output-channel';
import App from './App.svelte';
import { createInMemoryBridge } from './bridge/in-memory-bridge';
import { registerWebCommands } from './commands/register-web-commands';
import { WebHostEnvironment } from './host/web-host-environment';
import './styles/vscode-theme.css';
import '../../media/themes.generated.css';
import '../../media/main.css';

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

        const repoRoot =
            hostSystem.repoRoot ||
            (typeof window !== 'undefined' ? window.__JJ_VIEW_CONFIG__?.repoRoot : undefined) ||
            '.';

        const webHostEnv = new WebHostEnvironment(hostSystem, repoRoot);
        const codeForgeRegistry = new CodeForgeRegistry();
        const repoManager = new JjRepositoryManager(codeForgeRegistry, NO_OP_LOGGER, webHostEnv);

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

        registerWebCommands({
            repositoryManager: repoManager,
            hostEnvironment: webHostEnv,
            logger: NO_OP_LOGGER,
            scmModel,
            logViewController: logController,
        });

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
