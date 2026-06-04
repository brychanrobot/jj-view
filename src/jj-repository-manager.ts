/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CodeForgeRegistry } from './code-forge-registry';
import { JjRepository } from './jj-repository';
import { JjService } from './jj-service';
import { JjOutputChannel } from './utils/output-channel';

/**
 * Discovers and manages multiple Jujutsu repositories within the workspace.
 */
export class JjRepositoryManager implements vscode.Disposable {
    private _repositories: JjRepository[] = [];
    private _focusedRepository: JjRepository | undefined;
    private _binaryPath: string | undefined;
    private _disposables: vscode.Disposable[] = [];
    private readonly _dirToRepoRoot = new Map<string, string | null>();
    private readonly _ignoredAbsolutePaths = new Set<string>();
    private readonly _pendingRegistrations = new Map<string, Promise<JjRepository | undefined>>();

    private readonly _onDidOpenRepository = new vscode.EventEmitter<JjRepository>();
    readonly onDidOpenRepository = this._onDidOpenRepository.event;

    private readonly _onDidCloseRepository = new vscode.EventEmitter<JjRepository>();
    readonly onDidCloseRepository = this._onDidCloseRepository.event;

    private readonly _onDidChangeFocusedRepository = new vscode.EventEmitter<JjRepository | undefined>();
    readonly onDidChangeFocusedRepository = this._onDidChangeFocusedRepository.event;

    private readonly _onDidChangeRepositories = new vscode.EventEmitter<JjRepository[]>();
    readonly onDidChangeRepositories = this._onDidChangeRepositories.event;

    private static readonly LAST_FOCUSED_REPO_KEY = 'jj-view.lastFocusedRepoPath';
    private static readonly DISCOVERED_REPOS_KEY = 'jj-view.discoveredRepoPaths';

    constructor(
        private readonly _codeForgeRegistry: CodeForgeRegistry,
        private readonly _outputChannel: vscode.OutputChannel,
        private readonly _workspaceState: vscode.Memento,
        initialBinaryPath?: string,
    ) {
        this._binaryPath = initialBinaryPath;
        this.updateIgnoredPaths();
        // Track active tab changes across all editor groups and tab changes
        let lastActiveTab: vscode.Tab | undefined;
        const handleActiveTabChange = async () => {
            const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
            if (activeTab && activeTab !== lastActiveTab) {
                lastActiveTab = activeTab;
                const uri = this.getUriFromTab(activeTab);
                if (uri) {
                    try {
                        await this.checkAndRegisterUri(uri);
                        this.tryAutoSwitch(uri);
                    } catch (err) {
                        this._outputChannel.appendLine(`[RepositoryManager] Error checking active tab URI: ${err}`);
                    }
                }
            }
        };

        this._disposables.push(
            vscode.window.tabGroups.onDidChangeTabs(handleActiveTabChange),
            vscode.window.tabGroups.onDidChangeTabGroups(handleActiveTabChange),
        );

        // Also check already visible text editors at start
        for (const editor of vscode.window.visibleTextEditors) {
            this.checkAndRegisterUri(editor.document.uri)
                .then(() => {
                    if (editor === vscode.window.activeTextEditor) {
                        this.tryAutoSwitch(editor.document.uri);
                    }
                })
                .catch((err) => {
                    this._outputChannel.appendLine(
                        `[RepositoryManager] Error checking visible editor URI at start: ${err}`,
                    );
                });
        }
    }

    get repositories(): readonly JjRepository[] {
        return this._repositories;
    }

    get focusedRepository(): JjRepository | undefined {
        return this._focusedRepository;
    }

    /**
     * Updates the Jujutsu binary path for all managed repositories and stores it
     * for future discovered repositories.
     */
    setBinaryPath(binPath: string): void {
        this._binaryPath = binPath;
        this._dirToRepoRoot.clear();
        for (const repo of this._repositories) {
            repo.jj.binaryPath = binPath;
            repo.refresh({ reason: 'binary path set' }).catch((err) => {
                this._outputChannel.appendLine(
                    `[RepositoryManager] Failed to refresh repo ${repo.rootUri.fsPath} on binary path change: ${err}`,
                );
            });
        }
    }

    /**
     * Set the focused repository. Fires `onDidChangeFocusedRepository` if changed.
     */
    setFocusedRepository(repo: JjRepository | undefined): void {
        if (this._focusedRepository?.rootUri.fsPath === repo?.rootUri.fsPath) {
            return;
        }

        this._focusedRepository = repo;
        this._outputChannel.appendLine(`[RepositoryManager] Focused repository: ${repo?.rootUri.fsPath ?? 'none'}`);
        this._onDidChangeFocusedRepository.fire(repo);

        if (repo) {
            this._workspaceState.update(JjRepositoryManager.LAST_FOCUSED_REPO_KEY, repo.rootUri.fsPath);
        }
    }

    private persistRepositories(): void {
        const data = this._repositories.map((r) => ({
            rootPath: r.rootUri.fsPath,
            storePath: r.storePath,
        }));
        this._workspaceState.update(JjRepositoryManager.DISCOVERED_REPOS_KEY, data);
    }

    async initializeFromCache(): Promise<void> {
        const stored = this._workspaceState.get<Array<{ rootPath: string; storePath: string }>>(
            JjRepositoryManager.DISCOVERED_REPOS_KEY,
            [],
        );

        if (!stored || stored.length === 0) {
            return;
        }

        this._outputChannel.appendLine(`[RepositoryManager] Loading ${stored.length} cached repositories...`);

        const loaded: JjRepository[] = [];
        for (const item of stored) {
            try {
                const stats = await fs.stat(item.rootPath);
                if (!stats.isDirectory()) {
                    continue;
                }

                const repoPrefix = path.basename(item.rootPath);
                const repoOutputChannel = new JjOutputChannel(this._outputChannel, repoPrefix);
                const repo = new JjRepository(
                    vscode.Uri.file(item.rootPath),
                    item.storePath,
                    this._codeForgeRegistry,
                    repoOutputChannel,
                );
                if (this._binaryPath) {
                    repo.jj.binaryPath = this._binaryPath;
                }
                loaded.push(repo);
            } catch (err) {
                this._outputChannel.appendLine(
                    `[RepositoryManager] Failed to restore cached repo ${item.rootPath}: ${err}`,
                );
            }
        }

        if (loaded.length > 0) {
            this._repositories = loaded;
            for (const repo of loaded) {
                this._onDidOpenRepository.fire(repo);
            }
            this._onDidChangeRepositories.fire(this._repositories);

            const lastPath = this._workspaceState.get<string>(JjRepositoryManager.LAST_FOCUSED_REPO_KEY);
            const matched = loaded.find((r) => r.rootUri.fsPath === lastPath) || loaded[0];
            this.setFocusedRepository(matched);
        }
    }

    /**
     * Scan the workspace for repositories according to configurations.
     */
    async scan(): Promise<void> {
        const config = vscode.workspace.getConfiguration('jj-view');
        const autoDetect = config.get<boolean | string>('autoRepositoryDetection', true);
        const scanPaths = config.get<string[]>('scanRepositories', []);

        const candidates: JjRepository[] = [];
        const seenRoots = new Set<string>();

        // 1. Resolve ignore list absolute paths
        this.updateIgnoredPaths();

        // Helper to check if a path is ignored
        const isIgnored = (testPath: string): boolean => {
            return this._ignoredAbsolutePaths.has(testPath);
        };

        // Pre-populate candidates with valid cached/discovered repositories
        for (const repo of this._repositories) {
            const rootPath = repo.rootUri.fsPath;
            if (!isIgnored(rootPath)) {
                try {
                    const stats = await fs.stat(rootPath);
                    if (stats.isDirectory() && (await repo.isValid())) {
                        await this.addCandidate(rootPath, candidates, seenRoots, isIgnored);
                    }
                } catch {
                    // Directory doesn't exist anymore, let it be cleaned up
                }
            }
        }

        // discover via auto-detection setting
        const folders = vscode.workspace.workspaceFolders || [];
        for (const folder of folders) {
            const rootPath = folder.uri.fsPath;
            const rootReal = await fs.realpath(rootPath).catch(() => rootPath);

            if (autoDetect !== 'openEditors') {
                const rootDir = await this.findRepoRoot(rootReal);
                if (rootDir) {
                    await this.addCandidate(rootDir, candidates, seenRoots, isIgnored);
                }
            }

            if (autoDetect === true) {
                // Recursively search all subfolders
                const pattern = new vscode.RelativePattern(folder, '**/.jj/working_copy/type');
                const files = await vscode.workspace.findFiles(pattern, null, 1000);
                for (const file of files) {
                    const rootDir = path.dirname(path.dirname(path.dirname(file.fsPath)));
                    await this.addCandidate(rootDir, candidates, seenRoots, isIgnored);
                }
            } else if (autoDetect === 'subFolders') {
                // Search immediate subfolders only
                const pattern = new vscode.RelativePattern(folder, '*/.jj/working_copy/type');
                const files = await vscode.workspace.findFiles(pattern, null, 1000);
                for (const file of files) {
                    const rootDir = path.dirname(path.dirname(path.dirname(file.fsPath)));
                    await this.addCandidate(rootDir, candidates, seenRoots, isIgnored);
                }
            }
        }

        // 3. Scan explicit paths
        for (const p of scanPaths) {
            let absPath = p;
            if (!path.isAbsolute(p) && folders.length > 0) {
                absPath = path.resolve(folders[0].uri.fsPath, p);
            }
            try {
                const realAbs = await fs.realpath(absPath);
                const selfCheck = path.join(realAbs, '.jj', 'working_copy', 'type');
                await fs.access(selfCheck);
                await this.addCandidate(realAbs, candidates, seenRoots, isIgnored);
            } catch {
                // Path not accessible or not a repo
            }
        }

        // 3.5. Also include repositories of currently visible text editors (so they aren't closed)
        const editorRoots = await Promise.all(
            vscode.window.visibleTextEditors
                .filter(
                    (editor) => editor.document.uri.scheme === 'file' || editor.document.uri.scheme.startsWith('jj-'),
                )
                .map((editor) => this.findRepoRoot(this.getPathForUri(editor.document.uri))),
        );
        for (const rootDir of editorRoots) {
            if (rootDir) {
                await this.addCandidate(rootDir, candidates, seenRoots, isIgnored);
            }
        }

        // 4. Reconcile repositories
        const filtered = await this.filterRepositories(candidates);
        const oldRepos = this._repositories;
        this._repositories = filtered;
        this.persistRepositories();

        // Track repositories to dispose
        const toDispose = new Set<JjRepository>();

        // Any candidate that is not in the final filtered list must be disposed
        for (const repo of candidates) {
            if (!filtered.some((r) => r.rootUri.fsPath === repo.rootUri.fsPath)) {
                toDispose.add(repo);
            }
        }

        // Any previously registered repository that is not in the filtered list must be disposed
        for (const repo of oldRepos) {
            if (!filtered.some((r) => r.rootUri.fsPath === repo.rootUri.fsPath)) {
                toDispose.add(repo);
            }
        }

        // Dispose and fire close events for closed/filtered-out repositories
        for (const repo of toDispose) {
            const wasRegistered = oldRepos.some((r) => r.rootUri.fsPath === repo.rootUri.fsPath);
            if (wasRegistered) {
                this._onDidCloseRepository.fire(repo);
            }
            await repo.dispose();
        }

        // Find opened
        const opened = filtered.filter(
            (newRepo) => !oldRepos.some((oldRepo) => oldRepo.rootUri.fsPath === newRepo.rootUri.fsPath),
        );
        for (const repo of opened) {
            this._onDidOpenRepository.fire(repo);
        }

        this._onDidChangeRepositories.fire(this._repositories);
        this._outputChannel.appendLine(
            `[RepositoryManager] Total registered repositories: ${this._repositories.length}`,
        );

        // 5. Update focus
        if (this._repositories.length > 0) {
            if (
                !this._focusedRepository ||
                !this._repositories.some((r) => r.rootUri.fsPath === this._focusedRepository?.rootUri.fsPath)
            ) {
                const activeUri = vscode.window.activeTextEditor?.document.uri;
                const matched = activeUri ? this.getRepositoryForUri(activeUri) : undefined;
                this.setFocusedRepository(matched ?? this._repositories[0]);
            }
        } else {
            this.setFocusedRepository(undefined);
        }
    }

    private async addCandidate(
        rootDir: string,
        candidates: JjRepository[],
        seenRoots: Set<string>,
        isIgnored: (p: string) => boolean,
    ): Promise<void> {
        try {
            const realRoot = await fs.realpath(rootDir);
            if (seenRoots.has(realRoot) || isIgnored(realRoot)) {
                return;
            }

            // Verify .jj/working_copy/type exists to ensure it's a valid, initialized repository
            try {
                await fs.access(path.join(realRoot, '.jj', 'working_copy', 'type'));
            } catch {
                return; // Not a valid repository
            }

            const existing = this._repositories.find((r) => r.rootUri.fsPath === realRoot);
            if (existing) {
                if (this._binaryPath) {
                    existing.jj.binaryPath = this._binaryPath;
                }
                candidates.push(existing);
                seenRoots.add(realRoot);
                return;
            }

            const repoFilePath = path.join(realRoot, '.jj', 'repo');
            const storePath = await this.resolveStorePath(repoFilePath);
            const repoPrefix = path.basename(realRoot);
            const repoOutputChannel = new JjOutputChannel(this._outputChannel, repoPrefix);
            const repo = new JjRepository(
                vscode.Uri.file(realRoot),
                storePath,
                this._codeForgeRegistry,
                repoOutputChannel,
            );
            if (this._binaryPath) {
                repo.jj.binaryPath = this._binaryPath;
            }

            candidates.push(repo);
            seenRoots.add(realRoot);
        } catch {
            // Ignore
        }
    }

    /**
     * Filters out secondary workspaces if their main workspace is already registered.
     */
    private async filterRepositories(candidates: JjRepository[]): Promise<JjRepository[]> {
        const storePathToRepo = new Map<string, JjRepository>();
        const mainStores = new Set<string>();

        // First pass: Identify main repositories
        for (const repo of candidates) {
            const expectedMainStore = path.join(repo.rootUri.fsPath, '.jj', 'repo');
            try {
                const realExpected = await fs.realpath(expectedMainStore);
                if (realExpected === repo.storePath || expectedMainStore === repo.storePath) {
                    mainStores.add(repo.storePath);
                    storePathToRepo.set(repo.storePath, repo);
                }
            } catch {
                // Not a main store
            }
        }

        const filtered: JjRepository[] = [];
        const seenRoots = new Set<string>();

        // Second pass: Filter and deduplicate
        for (const repo of candidates) {
            if (seenRoots.has(repo.rootUri.fsPath)) {
                continue;
            }

            if (mainStores.has(repo.storePath) && storePathToRepo.get(repo.storePath) !== repo) {
                this._outputChannel.appendLine(
                    `[RepositoryManager] Skipping secondary workspace: ${repo.rootUri.fsPath}`,
                );
                continue;
            }

            filtered.push(repo);
            seenRoots.add(repo.rootUri.fsPath);
        }

        return filtered;
    }

    /**
     * Resolve the store path for a `.jj/repo` entry.
     */
    private async resolveStorePath(repoPath: string): Promise<string> {
        try {
            const stats = await fs.lstat(repoPath);
            if (stats.isFile()) {
                // Secondary workspace: file contains relative path to main store
                const content = await fs.readFile(repoPath, 'utf8');
                return path.resolve(path.dirname(repoPath), content.trim());
            }
            return await fs.realpath(repoPath);
        } catch {
            return repoPath;
        }
    }

    /**
     * Finds the repository root by running `jj root` in the directory of the given path.
     */
    private async findRepoRoot(fsPath: string): Promise<string | undefined> {
        let dir = fsPath;
        try {
            const stats = await fs.stat(fsPath);
            if (!stats.isDirectory()) {
                dir = path.dirname(fsPath);
            }
        } catch {
            dir = path.dirname(fsPath);
        }

        if (this._dirToRepoRoot.has(dir)) {
            const cached = this._dirToRepoRoot.get(dir);
            return cached === null ? undefined : cached;
        }

        // Find the closest existing parent directory
        let existingDir = dir;
        while (existingDir) {
            try {
                await fs.access(existingDir);
                break;
            } catch {
                const parent = path.dirname(existingDir);
                // Guard against infinite loops on Windows/UNC roots where path.dirname('C:\\') === 'C:\\'
                if (parent === existingDir) {
                    break;
                }
                existingDir = parent;
            }
        }

        const realDir = await fs.realpath(existingDir).catch(() => existingDir);

        const jj = new JjService(realDir, () => {}, this._binaryPath || 'jj');
        try {
            const resolvedRoot = await jj.getRepoRoot();
            const realRoot = await fs.realpath(resolvedRoot).catch(() => resolvedRoot);
            this._dirToRepoRoot.set(dir, realRoot);
            return realRoot;
        } catch {
            this._dirToRepoRoot.set(dir, null);
            return undefined;
        }
    }

    /**
     * Walk up from a file URI to dynamically register a repository if found.
     */
    async checkAndRegisterUri(uri: vscode.Uri): Promise<JjRepository | undefined> {
        if (uri.scheme !== 'file' && !uri.scheme.startsWith('jj-')) {
            return undefined;
        }

        // Longest prefix match check first
        const existing = this.getRepositoryForUri(uri);
        if (existing) {
            return existing;
        }

        const fsPath = this.getPathForUri(uri);
        const realRoot = await this.findRepoRoot(fsPath);
        if (!realRoot || this._ignoredAbsolutePaths.has(realRoot)) {
            return undefined;
        }

        // Check if already registered (concurrency check)
        const existingRepo = this._repositories.find((r) => r.rootUri.fsPath === realRoot);
        if (existingRepo) {
            return existingRepo;
        }

        // Check if there is already a pending registration for this root
        const pending = this._pendingRegistrations.get(realRoot);
        if (pending) {
            return pending;
        }

        const registrationPromise = (async () => {
            // Check if already registered (concurrency check)
            const existingRepo = this._repositories.find((r) => r.rootUri.fsPath === realRoot);
            if (existingRepo) {
                return existingRepo;
            }

            const repoFilePath = path.join(realRoot, '.jj', 'repo');
            const storePath = await this.resolveStorePath(repoFilePath);
            // Filter out secondary workspaces if their main workspace is already registered
            const expectedMainStore = path.join(realRoot, '.jj', 'repo');
            const realExpected = await fs.realpath(expectedMainStore).catch(() => expectedMainStore);
            const isMain = realExpected === storePath || expectedMainStore === storePath;
            if (!isMain) {
                const hasMain = this._repositories.some(
                    (r) => r.storePath === storePath && r.rootUri.fsPath !== realRoot,
                );
                if (hasMain) {
                    return undefined;
                }
            }
            const repoPrefix = path.basename(realRoot);
            const repoOutputChannel = new JjOutputChannel(this._outputChannel, repoPrefix);
            const repo = new JjRepository(
                vscode.Uri.file(realRoot),
                storePath,
                this._codeForgeRegistry,
                repoOutputChannel,
            );
            if (this._binaryPath) {
                repo.jj.binaryPath = this._binaryPath;
            }

            this._repositories.push(repo);
            this.persistRepositories();
            this._onDidOpenRepository.fire(repo);
            this._onDidChangeRepositories.fire(this._repositories);
            this._outputChannel.appendLine(`[RepositoryManager] Dynamically registered repo: ${realRoot}`);

            return repo;
        })();

        this._pendingRegistrations.set(realRoot, registrationPromise);
        try {
            return await registrationPromise;
        } finally {
            this._pendingRegistrations.delete(realRoot);
        }
    }

    private getPathForUri(uri: vscode.Uri): string {
        let rawPath = uri.fsPath;
        if (uri.scheme === 'jj-commit') {
            try {
                const query = new URLSearchParams(uri.query);
                const repoRoot = query.get('repoRoot');
                if (repoRoot) {
                    rawPath = decodeURIComponent(repoRoot);
                }
            } catch {
                // Ignore parsing errors
            }
        }
        return rawPath;
    }

    /**
     * Find the repository that contains the given URI.
     * Uses longest-prefix matching.
     */
    getRepositoryForUri(uri: vscode.Uri): JjRepository | undefined {
        if (uri.scheme !== 'file' && !uri.scheme.startsWith('jj-')) {
            return undefined;
        }

        const rawPath = this.getPathForUri(uri);
        const bestMatch = this.findMatch(rawPath);
        if (bestMatch) {
            return bestMatch;
        }

        let fsPath = rawPath;
        try {
            // Try resolving the directory path instead of the file path, since the file might not exist yet
            const dir = path.dirname(rawPath);
            const realDir = realpathSync(dir);
            fsPath = path.join(realDir, path.basename(rawPath));
        } catch {
            try {
                fsPath = realpathSync(rawPath);
            } catch {
                // Path might not exist, use original fsPath
            }
        }

        return this.findMatch(fsPath);
    }

    private findMatch(fsPath: string): JjRepository | undefined {
        let bestMatch: JjRepository | undefined;
        let bestLength = 0;

        for (const repo of this._repositories) {
            const repoRoot = repo.rootUri.fsPath;
            if (
                fsPath.startsWith(repoRoot) &&
                (fsPath.length === repoRoot.length || fsPath[repoRoot.length] === path.sep)
            ) {
                if (repoRoot.length > bestLength) {
                    bestMatch = repo;
                    bestLength = repoRoot.length;
                }
            }
        }

        return bestMatch;
    }

    private updateIgnoredPaths(): void {
        const config = vscode.workspace.getConfiguration('jj-view');
        const ignoredPaths = config.get<string[]>('ignoredRepositories', []);
        const folders = vscode.workspace.workspaceFolders || [];

        this._ignoredAbsolutePaths.clear();
        for (const p of ignoredPaths) {
            const abs = !path.isAbsolute(p) && folders.length > 0 ? path.resolve(folders[0].uri.fsPath, p) : p;
            try {
                const real = realpathSync(abs);
                this._ignoredAbsolutePaths.add(real);
            } catch {
                this._ignoredAbsolutePaths.add(abs);
            }
        }
    }

    /**
     * Attempt to switch active repository based on a file URI.
     */
    tryAutoSwitch(uri: vscode.Uri): boolean {
        const repo = this.getRepositoryForUri(uri);
        if (repo && repo.rootUri.fsPath !== this._focusedRepository?.rootUri.fsPath) {
            this.setFocusedRepository(repo);
            return true;
        }
        return false;
    }

    private getUriFromTab(tab: vscode.Tab): vscode.Uri | undefined {
        const input = tab.input;
        if (input instanceof vscode.TabInputText) {
            return input.uri;
        }
        if (input instanceof vscode.TabInputCustom) {
            return input.uri;
        }
        if (input instanceof vscode.TabInputNotebook) {
            return input.uri;
        }
        if (input instanceof vscode.TabInputTextDiff) {
            return input.modified;
        }
        if (input instanceof vscode.TabInputNotebookDiff) {
            return input.modified;
        }
        return undefined;
    }

    async dispose(): Promise<void> {
        this._onDidOpenRepository.dispose();
        this._onDidCloseRepository.dispose();
        this._onDidChangeFocusedRepository.dispose();
        this._onDidChangeRepositories.dispose();

        for (const repo of this._repositories) {
            await repo.dispose();
        }
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
