/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { JjService } from './jj-service';
import { JjScmProvider } from './jj-scm-provider';
import { GerritService } from './gerrit-service';
import { JjDocumentContentProvider } from './jj-content-provider';
import { JjEditFileSystemProvider } from './jj-edit-fs-provider';

export interface JjRepository {
    rootUri: vscode.Uri;
    jj: JjService;
    scmProvider: JjScmProvider;
    gerritService: GerritService;
    dispose(): void;
}

export class JjRepositoryManager implements vscode.Disposable {
    private _repositories = new Map<string, JjRepository>();
    private _disposables: vscode.Disposable[] = [];
    private _activeRepository: JjRepository | undefined;
    private _clearActiveRepoTimer: NodeJS.Timeout | undefined;

    private _onDidChangeRepositories = new vscode.EventEmitter<void>();
    readonly onDidChangeRepositories = this._onDidChangeRepositories.event;

    private _onDidChangeActiveRepository = new vscode.EventEmitter<JjRepository | undefined>();
    readonly onDidChangeActiveRepository = this._onDidChangeActiveRepository.event;

    private _onDidRepositoryStateReady = new vscode.EventEmitter<JjRepository>();
    readonly onDidRepositoryStateReady = this._onDidRepositoryStateReady.event;

    private _onDidRepositoryRefresh = new vscode.EventEmitter<JjRepository>();
    readonly onDidRepositoryRefresh = this._onDidRepositoryRefresh.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly outputChannel: vscode.OutputChannel,
        private readonly contentProvider: JjDocumentContentProvider,
        private readonly editProvider: JjEditFileSystemProvider,
    ) {
        this._disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders((e: vscode.WorkspaceFoldersChangeEvent) => {
                for (const folder of e.removed) {
                    this.removeRepositoriesInFolder(folder.uri);
                }
                this.scan();
            }),
            vscode.window.onDidChangeActiveTextEditor((e: vscode.TextEditor | undefined) => {
                this.updateActiveRepository(e?.document.uri);
            }),
            vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
                if (
                    e.affectsConfiguration('jj-view.autoRepositoryDetection') ||
                    e.affectsConfiguration('jj-view.repositoryScanMaxDepth') ||
                    e.affectsConfiguration('jj-view.repositoryScanIgnoredFolders') ||
                    e.affectsConfiguration('jj-view.scanRepositories')
                ) {
                    this.scan();
                }
            }),
        );
    }

    get repositories(): JjRepository[] {
        return Array.from(this._repositories.values());
    }

    get activeRepository(): JjRepository | undefined {
        return this._activeRepository;
    }

    async scan(): Promise<void> {
        const config = vscode.workspace.getConfiguration('jj-view');
        const detection = config.get<string>('autoRepositoryDetection', 'true');
        const maxDepth = config.get<number>('repositoryScanMaxDepth', 1);

        const foundRoots = new Set<string>();

        // 1. Check scanRepositories
        const extraRepos = config.get<string[]>('scanRepositories') || [];
        for (const relOrAbs of extraRepos) {
            let p = relOrAbs;
            if (
                !path.isAbsolute(p) &&
                vscode.workspace.workspaceFolders &&
                vscode.workspace.workspaceFolders.length > 0
            ) {
                p = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, p);
            }
            if (await this.isJjRepo(p)) {
                foundRoots.add(p);
            }
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            for (const folder of workspaceFolders) {
                const folderPath = folder.uri.fsPath;

                // 2. Check workspace root
                if (await this.isJjRepo(folderPath)) {
                    foundRoots.add(folderPath);
                }
            }
        }

        const isSubfoldersEnabled = detection === 'true' || detection === 'subfolders' || detection === 'all';
        const isOpenEditorsEnabled = detection === 'true' || detection === 'openEditors' || detection === 'all';

        // 3. Check subfolders if enabled
        if (isSubfoldersEnabled) {
            const ignoredList = config.get<string[]>('repositoryScanIgnoredFolders') || ['node_modules'];
            const ignored = new Set(ignoredList);

            // Scan workspace folders
            if (workspaceFolders) {
                for (const folder of workspaceFolders) {
                    await this.scanDirectory(folder.uri.fsPath, 0, maxDepth, ignored, foundRoots);
                }
            }
        }

        // 3. Check open editors if enabled
        if (isOpenEditorsEnabled) {
            const editors = vscode.window.visibleTextEditors;
            for (const editor of editors) {
                if (editor.document.uri.scheme === 'file') {
                    const repoRoot = await this.findRepoRootUpwards(editor.document.uri.fsPath);
                    if (repoRoot) {
                        foundRoots.add(repoRoot);
                    }
                }
            }
        }

        // Add new repositories
        let changed = false;
        for (const root of foundRoots) {
            if (!this._repositories.has(root)) {
                this.addRepository(vscode.Uri.file(root));
                changed = true;
            }
        }

        // Remove old repositories
        for (const root of this._repositories.keys()) {
            if (!foundRoots.has(root)) {
                if (!(await this.isJjRepo(root))) {
                    this.removeRepository(root);
                    changed = true;
                }
            }
        }

        if (changed) {
            this._onDidChangeRepositories.fire();
            await this.updateActiveRepository(vscode.window.activeTextEditor?.document.uri);
        }
    }

    private async scanDirectory(
        dir: string,
        depth: number,
        maxDepth: number,
        ignored: Set<string>,
        foundRoots: Set<string>,
        visited = new Set<string>(),
    ): Promise<void> {
        if (maxDepth !== -1 && depth > maxDepth) {
            return;
        }

        let realDir = dir;
        try {
            realDir = await fs.realpath(dir);
        } catch {
            return; // Unreadable path or dead symlink
        }

        if (visited.has(realDir)) {
            return;
        }
        visited.add(realDir);

        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            let hasJj = false;

            for (const e of entries) {
                if (e.name === '.jj') {
                    let isDir = e.isDirectory();
                    if (e.isSymbolicLink()) {
                        try {
                            const stat = await fs.stat(path.join(dir, e.name));
                            isDir = stat.isDirectory();
                        } catch {}
                    }
                    if (isDir) {
                        hasJj = true;
                        break;
                    }
                }
            }

            if (hasJj) {
                foundRoots.add(dir);
                return; // Found a repo, stop scanning deeper on this branch
            }

            for (const entry of entries) {
                let isDir = entry.isDirectory();
                const subPath = path.join(dir, entry.name);
                if (entry.isSymbolicLink()) {
                    try {
                        const stat = await fs.stat(subPath);
                        isDir = stat.isDirectory();
                    } catch {}
                }

                if (isDir && !ignored.has(entry.name) && !entry.name.startsWith('.')) {
                    await this.scanDirectory(subPath, depth + 1, maxDepth, ignored, foundRoots, visited);
                }
            }
        } catch (e) {
            // Ignore errors for unreadable directories
        }
    }

    private async isJjRepo(dirPath: string): Promise<boolean> {
        try {
            await fs.access(path.join(dirPath, '.jj'));
            return true;
        } catch {
            return false;
        }
    }

    private async findRepoRootUpwards(filePath: string): Promise<string | undefined> {
        let current = path.dirname(filePath);
        while (current !== path.dirname(current)) {
            // Until root
            if (await this.isJjRepo(current)) {
                return current;
            }
            current = path.dirname(current);
        }
        return undefined;
    }

    private addRepository(uri: vscode.Uri) {
        const rootPath = uri.fsPath;
        if (this._repositories.has(rootPath)) return;

        this.outputChannel.appendLine(`[RepositoryManager] Adding repository at ${rootPath}`);

        const jj = new JjService(rootPath, (msg) => this.outputChannel.appendLine(msg));
        const gerritService = new GerritService(rootPath, jj, this.outputChannel);
        const scmProvider = new JjScmProvider(
            this.context,
            jj,
            rootPath,
            this.outputChannel,
            this.contentProvider,
            this.editProvider,
        );

        // Register decoration provider
        const decProvider = vscode.window.registerFileDecorationProvider(scmProvider.decorationProvider);
        this._disposables.push(decProvider);

        const repo: JjRepository = {
            rootUri: uri,
            jj,
            scmProvider,
            gerritService,
            dispose: () => {
                scmProvider.dispose();
            },
        };

        scmProvider.onRepoStateReady(() => {
            this._onDidRepositoryStateReady.fire(repo);
        });

        const refreshDisposable = scmProvider.onDidRefresh(() => {
            this._onDidRepositoryRefresh.fire(repo);
        });

        // Add to disposables so it gets cleaned up if manager disposes
        this._disposables.push(refreshDisposable);

        this._repositories.set(rootPath, repo);
    }

    private removeRepository(rootPath: string) {
        const repo = this._repositories.get(rootPath);
        if (repo) {
            this.outputChannel.appendLine(`[RepositoryManager] Removing repository at ${rootPath}`);
            repo.dispose();
            this._repositories.delete(rootPath);
            if (this._activeRepository === repo) {
                this._activeRepository = undefined;
            }
        }
    }

    private removeRepositoriesInFolder(folderUri: vscode.Uri) {
        const folderPath = folderUri.fsPath;
        for (const root of this._repositories.keys()) {
            if (root.startsWith(folderPath)) {
                this.removeRepository(root);
            }
        }
    }

    private async updateActiveRepository(uri: vscode.Uri | undefined): Promise<void> {
        if (this._clearActiveRepoTimer) {
            clearTimeout(this._clearActiveRepoTimer);
            this._clearActiveRepoTimer = undefined;
        }

        if (!uri) {
            this._clearActiveRepoTimer = setTimeout(() => {
                this._clearActiveRepoTimer = undefined;
                if (this._activeRepository !== undefined) {
                    this._activeRepository = undefined;
                    this.outputChannel.appendLine(`[RepositoryManager] Active repository cleared`);
                    this._onDidChangeActiveRepository.fire(undefined);
                }
            }, 100); // Cushion for transient editor transitions
            return;
        }

        // Find repo containing this uri
        let bestMatch: JjRepository | undefined;
        let bestLen = -1;

        for (const repo of this._repositories.values()) {
            if (uri.fsPath.startsWith(repo.rootUri.fsPath)) {
                if (repo.rootUri.fsPath.length > bestLen) {
                    bestMatch = repo;
                    bestLen = repo.rootUri.fsPath.length;
                }
            }
        }

        if (!bestMatch) {
            const config = vscode.workspace.getConfiguration('jj-view');
            const detection = config.get<string>('autoRepositoryDetection', 'true');
            const isOpenEditorsEnabled = detection === 'true' || detection === 'openEditors' || detection === 'all';

            if (isOpenEditorsEnabled) {
                const repoRoot = await this.findRepoRootUpwards(uri.fsPath);
                if (repoRoot) {
                    if (!this._repositories.has(repoRoot)) {
                        this.addRepository(vscode.Uri.file(repoRoot));
                        this._onDidChangeRepositories.fire();
                    }
                    bestMatch = this._repositories.get(repoRoot);
                }
            }
        }

        if (bestMatch !== this._activeRepository) {
            this._activeRepository = bestMatch;
            this.outputChannel.appendLine(
                `[RepositoryManager] Active repository changed to ${bestMatch ? bestMatch.rootUri.fsPath : 'none'}`,
            );
            this._onDidChangeActiveRepository.fire(bestMatch);
        }
    }

    getRepository(arg?: unknown): JjRepository | undefined {
        // Handle array arguments (e.g. from multi-select SCM menus)
        const actualArg = Array.isArray(arg) ? arg[0] : arg;

        if (actualArg instanceof vscode.Uri) {
            return this.getRepositoryForUri(actualArg);
        }

        if (actualArg && typeof actualArg === 'object') {
            const anyArg = actualArg as object;
            if ('resourceUri' in anyArg) {
                return this.getRepositoryForUri(anyArg.resourceUri as vscode.Uri);
            }
            if ('rootUri' in anyArg) {
                return this.getRepositoryForUri(anyArg.rootUri as vscode.Uri);
            }
        }

        // Fallback to active repository
        return this._activeRepository;
    }

    private getRepositoryForUri(uri: vscode.Uri): JjRepository | undefined {
        for (const repo of this._repositories.values()) {
            if (uri.fsPath.startsWith(repo.rootUri.fsPath)) {
                return repo;
            }
        }
        return undefined;
    }

    dispose() {
        for (const repo of this._repositories.values()) {
            repo.dispose();
        }
        this._repositories.clear();
        this._disposables.forEach((d) => d.dispose());
    }
}
