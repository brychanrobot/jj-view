/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mount } from 'svelte';
import { CodeForgeAuthManager } from '../../src/core/code-forge-auth';
import type { CodeForgeProvider } from '../../src/core/code-forge-provider';
import { CodeForgeRegistry } from '../../src/core/code-forge-registry';
import { CommentsManager } from '../../src/core/comments-manager';
import { LogViewController } from '../../src/core/controllers/log-view-controller';
import { GerritProvider } from '../../src/core/gerrit-provider';
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
import { LAYOUT_STORAGE_KEY, parsePersistedLayout } from './layout/layout-state';
import './styles/vscode-theme.css';
import '../../media/themes.generated.css';
import '../../media/main.css';

declare global {
    interface Window {
        __JJ_VIEW_ENV__?: WebHostEnvironment;
        __JJ_VIEW_REPO_MANAGER__?: JjRepositoryManager;
    }
}

/**
 * Logs a startup phase boundary with its offset from navigation start.
 * Bootstrap is a serial chain and nothing is on screen until it finishes, so
 * these markers are what attribute "startup feels slow" to a concrete phase.
 */
function markStartup(label: string): void {
    if (typeof console === 'undefined' || !console.log) {
        return;
    }
    console.log(`[Perf:Startup] ${label} at +${performance.now().toFixed(0)}ms`);
}

function ms(value: number): string {
    return `${value.toFixed(0)}ms`;
}

function resourceName(url: string): string {
    try {
        const u = new URL(url);
        return u.pathname;
    } catch {
        return url;
    }
}

/**
 * Attributes the time between the iframe's navigation start and the first
 * line of bootstrap(). Nothing we control runs in that window, so the only
 * way to see it is the browser's own timeline: the HTML request itself
 * (daemon spawn / proxy path), each render-blocking subresource (stylesheets,
 * the sync preload.js and app.js), and script evaluation (the gap between
 * app.js responseEnd and bootstrap begin). Long tasks are logged when the
 * buffer has them; Chrome only buffers a bounded number.
 */
function logPreBootstrapTiming(): void {
    if (typeof console === 'undefined' || !console.log || typeof performance === 'undefined') {
        return;
    }
    const bootstrapAt = performance.now();
    const origin = new Date(performance.timeOrigin).toISOString();

    const [nav] = performance.getEntriesByType('navigation');
    if (nav instanceof PerformanceNavigationTiming) {
        console.log(
            `[Perf:Startup:nav] origin=${origin} type=${nav.type} redirects=${nav.redirectCount} ` +
                `proto=${nav.nextHopProtocol || '?'} ` +
                `fetchStart=+${ms(nav.fetchStart)} ` +
                `connect=${ms(nav.connectEnd - nav.connectStart)} ` +
                `requestStart=+${ms(nav.requestStart)} ttfb=${ms(nav.responseStart - nav.requestStart)} ` +
                `responseStart=+${ms(nav.responseStart)} responseEnd=+${ms(nav.responseEnd)} ` +
                `domInteractive=+${ms(nav.domInteractive)} ` +
                `transfer=${nav.transferSize}B`,
        );
    }

    const resources = performance
        .getEntriesByType('resource')
        .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
        .filter((entry) => entry.startTime < bootstrapAt)
        .sort((a, b) => a.startTime - b.startTime);
    for (const r of resources) {
        const queued = r.requestStart > 0 ? r.requestStart - r.startTime : Number.NaN;
        const ttfb = r.requestStart > 0 ? r.responseStart - r.requestStart : Number.NaN;
        console.log(
            `[Perf:Startup:res] ${resourceName(r.name)} (${r.initiatorType}) ` +
                `start=+${ms(r.startTime)} end=+${ms(r.responseEnd)} dur=${ms(r.duration)} ` +
                `queued=${Number.isNaN(queued) ? '?' : ms(queued)} ttfb=${Number.isNaN(ttfb) ? '?' : ms(ttfb)} ` +
                `proto=${r.nextHopProtocol || '?'} transfer=${r.transferSize}B ` +
                `${r.transferSize === 0 && r.decodedBodySize > 0 ? '(cache)' : ''}`,
        );
    }

    const appJs = resources.find((r) => resourceName(r.name).endsWith('/app.js'));
    if (appJs) {
        console.log(
            `[Perf:Startup:eval] app.js responseEnd=+${ms(appJs.responseEnd)} -> bootstrap begin=+${ms(bootstrapAt)} ` +
                `(script parse+eval+module init ≈ ${ms(bootstrapAt - appJs.responseEnd)})`,
        );
    }

    if (typeof PerformanceObserver === 'undefined') {
        return;
    }
    try {
        const observer = new PerformanceObserver((list) => {
            for (const task of list.getEntries()) {
                if (task.startTime >= bootstrapAt) {
                    continue;
                }
                console.log(`[Perf:Startup:longtask] ${ms(task.duration)} at +${ms(task.startTime)}`);
            }
            observer.disconnect();
        });
        observer.observe({ type: 'longtask', buffered: true });
    } catch {
        // longtask not supported; nothing to log
    }
}

/**
 * Returns the repository restored from cache that the UI can mount on
 * immediately, or undefined if there is none or it no longer looks like a
 * repository. The validity probe is a single `fs.exists`, memoized on the
 * repository so the subsequent scan does not repeat it.
 */
async function pickRestoredRepository(repoManager: JjRepositoryManager): Promise<JjRepository | undefined> {
    const candidate = repoManager.focusedRepository ?? repoManager.repositories[0];
    if (!candidate) {
        return undefined;
    }
    const valid = await candidate.isValid().catch(() => false);
    return valid ? candidate : undefined;
}

export async function bootstrap(): Promise<void> {
    const target = document.getElementById('app');
    if (!target) {
        return;
    }
    markStartup('bootstrap begin');
    logPreBootstrapTiming();

    try {
        const hostSystem = new RemoteHostSystem();
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error('Connection timed out. JJ View host daemon is unreachable.'));
            }, 15000);
        });
        await Promise.race([hostSystem.ready, timeoutPromise]);
        markStartup('host ready (SSE open + system.info)');

        const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
        if (typeof window !== 'undefined' && urlParams?.has('token')) {
            const tokenVal = urlParams.get('token');
            if (tokenVal && window.sessionStorage) {
                try {
                    window.sessionStorage.setItem('jj_view_token', tokenVal);
                } catch {
                    // Ignore storage access restrictions
                }
            }
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
                            await hostSystem.addAllowedRoot(folder.uri.fsPath);
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
        if (repoRoot && repoRoot !== '.' && repoRoot !== hostSystem.repoRoot) {
            try {
                await hostSystem.addAllowedRoot(repoRoot);
            } catch (err) {
                NO_OP_LOGGER.warn(`Failed to add allowed root for repoRoot: ${toError(err).message}`);
            }
        }
        markStartup('workspace roots resolved (sidecar.getWorkspaceUris + addAllowedRoot)');

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
            create: (outputChannel, host) => new GitHubProvider(authManager, outputChannel, host),
        });
        codeForgeRegistry.register({
            id: 'gitlab',
            create: (outputChannel, host) => new GitLabProvider(authManager, outputChannel, host),
        });
        codeForgeRegistry.register({
            id: 'gerrit',
            create: (outputChannel, host) => new GerritProvider(outputChannel, host),
        });

        const repoManager = new JjRepositoryManager(codeForgeRegistry, NO_OP_LOGGER, webHostEnv);
        if (typeof window !== 'undefined') {
            window.__JJ_VIEW_REPO_MANAGER__ = repoManager;
        }

        webHostEnv.workspace.onDidChangeWorkspaceFolders(() => {
            const firstFolder = webHostEnv.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (firstFolder && firstFolder !== hostSystem.repoRoot) {
                hostSystem.setWorkspaceRoot(firstFolder);
                void webHostEnv.config.reload();
            }
        });

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
                const currentFolders = webHostEnv.workspace.workspaceFolders;
                const unchanged =
                    folders.length === currentFolders.length &&
                    folders.every((f, idx) => f.uri.fsPath === currentFolders[idx]?.uri.fsPath);
                if (unchanged) {
                    return;
                }
                for (const folder of folders) {
                    try {
                        await hostSystem.addAllowedRoot(folder.uri.fsPath);
                    } catch (e) {
                        NO_OP_LOGGER.warn(`Failed to add allowed root for workspace: ${toError(e).message}`);
                    }
                }
                if (folders[0] && folders[0].uri.fsPath !== hostSystem.repoRoot) {
                    hostSystem.setWorkspaceRoot(folders[0].uri.fsPath);
                    await webHostEnv.config.reload();
                }
                webHostEnv.workspace.setWorkspaceFolders(folders);
                await repoManager.restoreCachedRepositories();
                for (const folder of folders) {
                    await repoManager.maybeRegisterWorkspaceRoot(folder.uri);
                }
                const focusMatchedRepo = () => {
                    const matchedRepo = repoManager.repositories.find((r) =>
                        folders.some(
                            (f) =>
                                r.rootUri.fsPath === f.uri.fsPath ||
                                f.uri.fsPath.startsWith(`${r.rootUri.fsPath}/`) ||
                                r.rootUri.fsPath.startsWith(`${f.uri.fsPath}/`),
                        ),
                    );
                    if (matchedRepo) {
                        repoManager.setFocusedRepository(matchedRepo);
                    }
                };
                focusMatchedRepo();
                void repoManager
                    .scanForRepositories()
                    .then(() => {
                        focusMatchedRepo();
                    })
                    .catch((e: unknown) => {
                        NO_OP_LOGGER.error('Failed to scan repositories on workspace change', toError(e));
                    });
            });
        }

        // Read in parallel with the repository restore so the first paint uses
        // the persisted panel sizes without adding a round trip to startup.
        const layoutLoad = webHostEnv.storage
            .get<unknown>(LAYOUT_STORAGE_KEY)
            .then(parsePersistedLayout)
            .catch((err: unknown) => {
                NO_OP_LOGGER.error('Failed to load persisted layout', toError(err));
                return parsePersistedLayout(undefined);
            });

        await webHostEnv.config.waitForInit();
        await repoManager.restoreCachedRepositories();
        markStartup('restoreCachedRepositories done');

        // A cached repository that still looks valid is enough to mount on.
        // Without a cache, resolve the workspace root via `jj root` first so
        // nested sub-repository discovery (`findFiles`) can run in the background.
        let repo: JjRepository | undefined = await pickRestoredRepository(repoManager);
        if (!repo) {
            repo = await repoManager.maybeRegisterWorkspaceRoot(Uri.file(repoRoot));
        }
        let backgroundScan: Promise<void> | undefined;
        if (repo) {
            backgroundScan = repoManager.scanForRepositories();
        } else {
            await repoManager.scanForRepositories();
            markStartup('scanForRepositories done (blocking: no cached repository)');
            repo = repoManager.focusedRepository ?? repoManager.repositories[0];
        }
        if (!repo) {
            const storePath = `${repoRoot}/.jj/repo`;
            repo = new JjRepository(Uri.file(repoRoot), storePath, codeForgeRegistry, NO_OP_LOGGER, webHostEnv);
        }
        repoManager.registerRepositoryInstance(repo);
        markStartup('repository registered');

        const scmModel = new ScmModel(repo, NO_OP_LOGGER);
        const initialRefresh = scmModel.refresh({ reason: 'initial' });
        initialRefresh
            .then(() => markStartup('initial scm refresh done'))
            .catch((err: unknown) => {
                NO_OP_LOGGER.error('Initial SCM refresh failed', toError(err));
            });
        backgroundScan
            ?.then(() => markStartup('background scanForRepositories done'))
            .catch((err: unknown) => {
                NO_OP_LOGGER.error('Background repository scan failed', toError(err));
            });

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

        // Same wiring as the extension host: the SCM pane subscribes to status
        // changes itself, but the log controller only refreshes on its own
        // mutations, so watcher-driven and external `jj` changes would otherwise
        // never reach the graph. The controller coalesces bursts.
        let repoStatusSub = repo.onDidStatusChange((event) => {
            logController?.refresh(event.reason).catch((err: unknown) => {
                NO_OP_LOGGER.error('Log refresh on status change failed', toError(err));
            });
        });

        // Same as the extension host: one manager that follows the focused
        // repository and the working copy, and is retargeted by showComments.
        const commentsManager = new CommentsManager(repoManager, webHostEnv);

        registerWebCommands({
            repositoryManager: repoManager,
            hostEnvironment: webHostEnv,
            logger: NO_OP_LOGGER,
            scmModel,
            logViewController: logController,
            authManager,
            commentsManager,
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
                // Detection already started in the service constructor; wait
                // for it rather than forcing a second `jj git remote list`.
                activeRepo.codeForge
                    .awaitReady()
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
            if (!r) {
                return;
            }
            repoStatusSub.dispose();
            repoStatusSub = r.onDidStatusChange((event) => {
                logController?.refresh(event.reason).catch((err: unknown) => {
                    NO_OP_LOGGER.error('Log refresh on status change failed', toError(err));
                });
            });
            scmModel.setRepository(r);
            if (logController) {
                logController.repository = r;
            }
        });
        updateCodeForgeContext(repo);

        const initialLayout = await layoutLoad;

        mount(App, {
            target,
            props: {
                host: hostSystem,
                webHostEnv,
                scmModel,
                initialSnapshot: scmModel.snapshot,
                workspaceRoot: repo.rootUri.fsPath || repoRoot,
                viewFs,
                editFs,
                logTransport: logBridge.transport,
                initialLayout,
                commentsManager,
            },
        });
        markStartup('App mounted (first visible UI)');
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
