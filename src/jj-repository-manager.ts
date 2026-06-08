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

interface DetectedRepoInfo {
    rootPath: string;
    storePath: string;
    isMain: boolean;
}

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
    private _lastActiveTab?: vscode.Tab;
    private _activeScan: Promise<void> | undefined;
    private _scanPending = false;
    private _disposed = false;
    private _normalizedWorkspaceFolders: string[] | undefined;
    private readonly _realNormalizedPathCache = new Map<string, Promise<string>>();

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

        const { activeTab } = vscode.window.tabGroups.activeTabGroup;
        const activeUri = activeTab ? this.getUriFromTab(activeTab) : undefined;
        this._lastActiveTab = activeTab;

        // 1. Scan and register open editors at startup (only if configured to detect from open editors)
        if (this.shouldDetectFromOpenEditors()) {
            for (const uri of this.getOpenEditorUris()) {
                this.maybeRegisterRepositoryContainingUri(uri)
                    .then(() => {
                        if (activeUri && activeUri.toString() === uri.toString()) {
                            this.tryAutoSwitch(uri);
                        }
                    })
                    .catch((err) => {
                        this._outputChannel.appendLine(
                            `[RepositoryManager] Error checking open editor URI at start: ${err}`,
                        );
                    });
            }
        }

        // 2. Track active tab changes
        const handleActiveTabChange = async () => {
            const currentTab = vscode.window.tabGroups.activeTabGroup.activeTab;
            if (currentTab === this._lastActiveTab) {
                return;
            }
            this._lastActiveTab = currentTab;

            if (!currentTab) {
                return;
            }

            if (!this.shouldDetectFromOpenEditors()) {
                return;
            }

            const uri = this.getUriFromTab(currentTab);
            if (!uri) {
                return;
            }

            try {
                await this.maybeRegisterRepositoryContainingUri(uri);
                // Verify the active tab hasn't changed during the async call
                const activeTabNow = vscode.window.tabGroups.activeTabGroup.activeTab;
                if (activeTabNow && this.getUriFromTab(activeTabNow)?.toString() === uri.toString()) {
                    this.tryAutoSwitch(uri);
                }
            } catch (err) {
                this._outputChannel.appendLine(`[RepositoryManager] Error checking active tab URI: ${err}`);
            }
        };

        this._disposables.push(
            vscode.window.tabGroups.onDidChangeTabs(handleActiveTabChange),
            vscode.window.tabGroups.onDidChangeTabGroups(handleActiveTabChange),
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this._normalizedWorkspaceFolders = undefined;
                this._realNormalizedPathCache.clear();
            }),
        );
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
        const currentPath = this._focusedRepository?.rootUri.fsPath;
        const newPath = repo?.rootUri.fsPath;
        if (this.isSamePath(currentPath, newPath)) {
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

    /**
     * Restores previously cached repository configurations on startup.
     * Validates that the cached directories exist, instantiates them,
     * and registers them in bulk.
     */
    async restoreCachedRepositories(): Promise<void> {
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
            if (!(await this.isPathInOrAncestorOfWorkspace(item.rootPath))) {
                continue;
            }
            try {
                const stats = await fs.stat(item.rootPath);
                if (!stats.isDirectory()) {
                    continue;
                }

                const repo = await this.createRepository(item.rootPath, item.storePath);
                loaded.push(repo);
            } catch (err) {
                this._outputChannel.appendLine(
                    `[RepositoryManager] Failed to restore cached repo ${item.rootPath}: ${err}`,
                );
            }
        }

        if (loaded.length > 0) {
            this.registerRepositories(loaded);

            const lastPath = this._workspaceState.get<string>(JjRepositoryManager.LAST_FOCUSED_REPO_KEY);
            const matched =
                (lastPath ? loaded.find((r) => this.isSamePath(r.rootUri.fsPath, lastPath)) : undefined) || loaded[0];
            this.setFocusedRepository(matched);
        }
    }

    /**
     * Scans the workspace folders, explicit configuration paths, and open editor tabs
     * to discover and update the list of registered Jujutsu repositories.
     */
    async scanForRepositories(): Promise<void> {
        if (this._disposed) {
            return;
        }
        if (this._activeScan) {
            this._scanPending = true;
            return this._activeScan;
        }

        this._scanPending = true;
        const scanPromise = (async () => {
            while (this._scanPending && !this._disposed) {
                this._scanPending = false;
                await this.doScan();
            }
        })();

        this._activeScan = scanPromise;
        try {
            await scanPromise;
        } finally {
            if (this._activeScan === scanPromise) {
                this._activeScan = undefined;
            }
        }
    }

    private async doScan(): Promise<void> {
        const autoDetect = this.getAutoRepositoryDetectionConfig();
        const scanPaths = this.getScanRepositoriesConfig();

        const candidates: DetectedRepoInfo[] = [];
        const seenRoots = new Set<string>();

        // 1. Resolve ignore list absolute paths
        this.updateIgnoredPaths();

        const addCandidate = async (rootDir: string) => {
            const info = await this.probeRepository(rootDir);
            if (info) {
                const normalizedRoot = this.normalizePath(info.rootPath);
                if (!seenRoots.has(normalizedRoot)) {
                    candidates.push(info);
                    seenRoots.add(normalizedRoot);
                }
            }
        };

        // Pre-populate candidates with valid cached/discovered repositories
        for (const repo of this._repositories) {
            const rootPath = repo.rootUri.fsPath;
            try {
                const stats = await fs.stat(rootPath);
                if (stats.isDirectory() && (await repo.isValid())) {
                    await addCandidate(rootPath);
                }
            } catch {
                // Directory doesn't exist anymore, let it be cleaned up
            }
        }

        // discover via auto-detection setting
        const folders = vscode.workspace.workspaceFolders || [];
        for (const folder of folders) {
            const rootPath = folder.uri.fsPath;
            const rootReal = await fs.realpath(rootPath).catch(() => rootPath);

            if (this.shouldScanWorkspaceRoots()) {
                const rootDir = await this.findRepoRoot(rootReal);
                if (rootDir) {
                    await addCandidate(rootDir);
                }
            }

            if (autoDetect === true || autoDetect === 'subFolders') {
                const glob = autoDetect === true ? '**/.jj/working_copy/type' : '*/.jj/working_copy/type';
                const pattern = new vscode.RelativePattern(folder, glob);
                const files = await vscode.workspace.findFiles(pattern, null, 1000);
                for (const file of files) {
                    const rootDir = path.dirname(path.dirname(path.dirname(file.fsPath)));
                    await addCandidate(rootDir);
                }
            }
        }

        // 3. Scan explicit paths
        for (const p of scanPaths) {
            let absPath = p;
            if (!path.isAbsolute(p) && folders.length > 0) {
                absPath = path.resolve(folders[0].uri.fsPath, p);
            }
            if (!(await this.isPathInOrAncestorOfWorkspace(absPath))) {
                this._outputChannel.appendLine(
                    `[RepositoryManager] Warning: Skipping configured scan path outside workspace folders: ${p}`,
                );
                continue;
            }
            try {
                const realAbs = await fs.realpath(absPath);
                const selfCheck = path.join(realAbs, '.jj', 'working_copy', 'type');
                await fs.access(selfCheck);
                await addCandidate(realAbs);
            } catch {
                // Path not accessible or not a repo
            }
        }

        // 3.5. Also include repositories of currently open editors (so they aren't closed)
        if (this.shouldDetectFromOpenEditors()) {
            const openUris = this.getOpenEditorUris();
            const uriChecks = await Promise.all(
                openUris.map(async (uri) => ({
                    uri,
                    valid: await this.isUriInWorkspaceFolder(uri),
                })),
            );
            const validUris = uriChecks.filter((check) => check.valid).map((check) => check.uri);
            const editorRoots = await Promise.all(validUris.map((uri) => this.findRepoRoot(this.getPathForUri(uri))));
            for (const rootDir of editorRoots) {
                if (rootDir) {
                    await addCandidate(rootDir);
                }
            }
        }

        // 4. Reconcile repositories
        const filteredInfos = await this.filterRepositoryInfos(candidates);
        const oldRepos = this._repositories;
        const newRepos: JjRepository[] = [];

        // For each filtered info, either reuse existing repo or instantiate a new one
        for (const info of filteredInfos) {
            if (this._disposed) {
                break;
            }
            const existing = oldRepos.find((r) => this.isSamePath(r.rootUri.fsPath, info.rootPath));
            if (existing) {
                if (this._binaryPath) {
                    existing.jj.binaryPath = this._binaryPath;
                }
                newRepos.push(existing);
            } else {
                try {
                    const repo = await this.createRepository(info.rootPath, info.storePath);
                    newRepos.push(repo);
                } catch (err) {
                    this._outputChannel.appendLine(
                        `[RepositoryManager] Error creating repository for ${info.rootPath}: ${err}`,
                    );
                }
            }
        }

        if (this._disposed) {
            // If disposed, dispose all newly created repositories
            for (const repo of newRepos) {
                if (!oldRepos.some((r) => this.isSamePath(r.rootUri.fsPath, repo.rootUri.fsPath))) {
                    await repo.dispose();
                }
            }
            return;
        }

        this._repositories = newRepos;
        this.persistRepositories();

        // Any repository in oldRepos that is not in newRepos must be disposed
        for (const oldRepo of oldRepos) {
            if (!newRepos.some((r) => this.isSamePath(r.rootUri.fsPath, oldRepo.rootUri.fsPath))) {
                this._onDidCloseRepository.fire(oldRepo);
                await oldRepo.dispose();
            }
        }

        // Find opened (present in newRepos but not in oldRepos)
        const opened = newRepos.filter(
            (newRepo) => !oldRepos.some((oldRepo) => this.isSamePath(oldRepo.rootUri.fsPath, newRepo.rootUri.fsPath)),
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
                !this._repositories.some((r) =>
                    this.isSamePath(r.rootUri.fsPath, this._focusedRepository?.rootUri.fsPath),
                )
            ) {
                const activeUri = vscode.window.activeTextEditor?.document.uri;
                const matched = activeUri ? this.getRepositoryForUri(activeUri) : undefined;
                this.setFocusedRepository(matched ?? this._repositories[0]);
            }
        } else {
            this.setFocusedRepository(undefined);
        }
    }

    /**
     * Filters out secondary workspaces if their main workspace is already registered or candidate.
     *
     * @param candidates The list of candidate DetectedRepoInfo instances.
     * @returns A filtered array of DetectedRepoInfo instances.
     */
    private async filterRepositoryInfos(candidates: DetectedRepoInfo[]): Promise<DetectedRepoInfo[]> {
        const mainStores = new Set<string>();

        // Identify all main repositories' store paths in the active repositories list
        for (const repo of this._repositories) {
            if (await this.isMainWorkspace(repo.rootUri.fsPath, repo.storePath)) {
                mainStores.add(this.normalizePath(repo.storePath));
            }
        }
        // And also from candidates
        for (const info of candidates) {
            if (info.isMain) {
                mainStores.add(this.normalizePath(info.storePath));
            }
        }

        const filtered: DetectedRepoInfo[] = [];
        const seenRoots = new Set<string>();

        // Second pass: Filter and deduplicate
        for (const info of candidates) {
            const normalizedRoot = this.normalizePath(info.rootPath);
            if (seenRoots.has(normalizedRoot)) {
                continue;
            }

            if (!info.isMain && mainStores.has(this.normalizePath(info.storePath))) {
                this._outputChannel.appendLine(`[RepositoryManager] Skipping secondary workspace: ${info.rootPath}`);
                continue;
            }

            filtered.push(info);
            seenRoots.add(normalizedRoot);
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

        const normalizedDir = this.normalizePath(dir);
        if (this._dirToRepoRoot.has(normalizedDir)) {
            const cached = this._dirToRepoRoot.get(normalizedDir);
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
            this._dirToRepoRoot.set(normalizedDir, realRoot);
            return realRoot;
        } catch {
            this._dirToRepoRoot.set(normalizedDir, null);
            return undefined;
        }
    }

    /**
     * Conditionally detects and registers a repository containing the given file or directory URI.
     * This is used for on-demand repository registration when a file is opened or becomes active.
     *
     * @param uri The VS Code Uri of the file or directory.
     * @returns The registered JjRepository instance, or undefined if not in a valid workspace or if filtered.
     */
    async maybeRegisterRepositoryContainingUri(uri: vscode.Uri): Promise<JjRepository | undefined> {
        if (this._disposed) {
            return undefined;
        }

        if (!(await this.isUriInWorkspaceFolder(uri))) {
            return undefined;
        }

        // Longest prefix match check first
        const existing = this.getRepositoryForUri(uri);
        if (existing) {
            return existing;
        }

        if (!this.shouldDetectFromOpenEditors()) {
            return undefined;
        }

        const fsPath = this.getPathForUri(uri);

        const realRoot = await this.findRepoRoot(fsPath);
        if (!realRoot) {
            return undefined;
        }

        const info = await this.probeRepository(realRoot);
        if (!info) {
            return undefined;
        }

        return this.registerRepository(info);
    }

    /**
     * Registers a repository with the manager, handling concurrency, storage checks,
     * and workspace constraints.
     */
    private async registerRepository(info: DetectedRepoInfo): Promise<JjRepository | undefined> {
        const normalizedRoot = this.normalizePath(info.rootPath);

        // Check if already registered (concurrency check)
        const existingRepo = this._repositories.find((r) => this.isSamePath(r.rootUri.fsPath, normalizedRoot));
        if (existingRepo) {
            return existingRepo;
        }

        // Check if there is already a pending registration for this root
        const pending = this._pendingRegistrations.get(normalizedRoot);
        if (pending) {
            return pending;
        }

        const registrationPromise = (async () => {
            if (this._disposed) {
                return undefined;
            }
            // Check if already registered (concurrency check)
            const existingRepo = this._repositories.find((r) => this.isSamePath(r.rootUri.fsPath, normalizedRoot));
            if (existingRepo) {
                return existingRepo;
            }

            // Filter out secondary workspaces if their main workspace is already registered
            if (this.hasRegisteredWorkspaceForStore(info.storePath, info.rootPath) && !info.isMain) {
                return undefined;
            }

            const repo = await this.createRepository(info.rootPath, info.storePath);
            if (this._disposed) {
                await repo.dispose();
                return undefined;
            }

            this.registerRepositories([repo]);
            this._outputChannel.appendLine(`[RepositoryManager] Dynamically registered repo: ${info.rootPath}`);

            return repo;
        })();

        this._pendingRegistrations.set(normalizedRoot, registrationPromise);
        try {
            return await registrationPromise;
        } finally {
            this._pendingRegistrations.delete(normalizedRoot);
        }
    }

    /**
     * Instantiates and configures a JjRepository representation for a workspace path.
     *
     * @param rootPath The absolute path to the workspace root directory.
     * @param storePath Optional pre-resolved store path. If omitted, it will be resolved from disk.
     * @returns A Promise resolving to the configured JjRepository instance.
     */
    private async createRepository(rootPath: string, storePath?: string): Promise<JjRepository> {
        const resolvedStorePath = storePath ?? (await this.resolveStorePath(path.join(rootPath, '.jj', 'repo')));
        const repoPrefix = path.basename(rootPath);
        const repoOutputChannel = new JjOutputChannel(this._outputChannel, repoPrefix);
        const repo = new JjRepository(
            vscode.Uri.file(rootPath),
            resolvedStorePath,
            this._codeForgeRegistry,
            repoOutputChannel,
        );
        if (this._binaryPath) {
            repo.jj.binaryPath = this._binaryPath;
        }
        return repo;
    }

    /**
     * Checks if a path is inside, equivalent to, or an ancestor of any active VS Code workspace folder.
     * This allows managing repositories whose roots are ancestors of workspace folders.
     *
     * @param fsPath The absolute file path to check.
     * @returns True if the path is related to a workspace folder, false otherwise.
     */
    private getRealNormalizedPath(p: string): Promise<string> {
        const key = this.normalizePath(p);
        let promise = this._realNormalizedPathCache.get(key);
        if (!promise) {
            promise = (async () => {
                try {
                    const resolved = await fs.realpath(p);
                    return this.normalizePath(resolved);
                } catch {
                    return key;
                }
            })();
            this._realNormalizedPathCache.set(key, promise);
        }
        return promise;
    }

    private async getNormalizedWorkspaceFolders(): Promise<string[]> {
        if (this._normalizedWorkspaceFolders !== undefined) {
            return this._normalizedWorkspaceFolders;
        }
        const folders = vscode.workspace.workspaceFolders || [];
        this._normalizedWorkspaceFolders = await Promise.all(
            folders.map((folder) => this.getRealNormalizedPath(folder.uri.fsPath)),
        );
        return this._normalizedWorkspaceFolders;
    }

    private async isPathInOrAncestorOfWorkspace(fsPath: string): Promise<boolean> {
        const normalizedPath = await this.getRealNormalizedPath(fsPath);
        const normalizedFolders = await this.getNormalizedWorkspaceFolders();
        for (const normalizedFolder of normalizedFolders) {
            if (
                normalizedPath === normalizedFolder ||
                normalizedPath.startsWith(`${normalizedFolder}/`) ||
                normalizedFolder.startsWith(`${normalizedPath}/`)
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * Probes a directory path to see if it represents a valid Jujutsu repository.
     * Returns resolved metadata if valid, otherwise undefined.
     *
     * @param rootDir The directory path to check.
     * @returns The DetectedRepoInfo if valid, otherwise undefined.
     */
    private async probeRepository(rootDir: string): Promise<DetectedRepoInfo | undefined> {
        if (this._disposed) {
            return undefined;
        }
        try {
            const realRoot = await fs.realpath(rootDir);
            if (this._disposed) {
                return undefined;
            }
            const normalizedRoot = this.normalizePath(realRoot);
            if (this._ignoredAbsolutePaths.has(normalizedRoot)) {
                return undefined;
            }

            if (!(await this.isPathInOrAncestorOfWorkspace(realRoot))) {
                return undefined;
            }

            // Verify .jj/working_copy/type exists to ensure it's a valid, initialized repository
            try {
                await fs.access(path.join(realRoot, '.jj', 'working_copy', 'type'));
            } catch {
                return undefined; // Not a valid repository
            }

            const storePath = await this.resolveStorePath(path.join(realRoot, '.jj', 'repo'));
            if (this._disposed) {
                return undefined;
            }
            const isMain = await this.isMainWorkspace(realRoot, storePath);

            return {
                rootPath: realRoot,
                storePath,
                isMain,
            };
        } catch {
            return undefined;
        }
    }

    /**
     * Registers one or more repositories with the manager, appending them to the
     * active repositories list, persisting them, and firing SCM change events.
     *
     * @param repos The array of JjRepository instances to register.
     */
    private registerRepositories(repos: JjRepository[]): void {
        if (repos.length === 0) {
            return;
        }
        this._repositories.push(...repos);
        this.persistRepositories();
        for (const repo of repos) {
            this._onDidOpenRepository.fire(repo);
        }
        this._onDidChangeRepositories.fire(this._repositories);
    }

    /**
     * Determines whether the workspace at `rootPath` is the main workspace for the repository store.
     * A workspace is the main workspace if its store path is located directly inside it.
     *
     * @param rootPath The absolute path of the workspace.
     * @param storePath The absolute path of the repository's store.
     * @returns True if the workspace is the main workspace, false otherwise.
     */
    private async isMainWorkspace(rootPath: string, storePath: string): Promise<boolean> {
        const expectedMainStore = path.join(rootPath, '.jj', 'repo');
        const realExpected = await fs.realpath(expectedMainStore).catch(() => expectedMainStore);
        return this.isSamePath(realExpected, storePath) || this.isSamePath(expectedMainStore, storePath);
    }

    /**
     * Checks if there is already a registered repository/workspace in the manager
     * that shares the same underlying store (repository).
     *
     * @param storePath The store path to search for.
     * @param excludeRootPath Optional workspace root path to exclude from the check.
     * @returns True if a repository sharing the same store is registered, false otherwise.
     */
    private hasRegisteredWorkspaceForStore(storePath: string, excludeRootPath?: string): boolean {
        return this._repositories.some(
            (r) =>
                this.isSamePath(r.storePath, storePath) &&
                (!excludeRootPath || !this.isSamePath(r.rootUri.fsPath, excludeRootPath)),
        );
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

    private async isUriInWorkspaceFolder(uri: vscode.Uri): Promise<boolean> {
        if (uri.scheme !== 'file' && !uri.scheme.startsWith('jj-')) {
            return false;
        }
        const fsPath = this.getPathForUri(uri);
        const normalizedPath = await this.getRealNormalizedPath(fsPath);
        const normalizedFolders = await this.getNormalizedWorkspaceFolders();
        for (const normalizedFolder of normalizedFolders) {
            if (normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`)) {
                return true;
            }
        }
        return false;
    }

    private getOpenEditorUris(): vscode.Uri[] {
        const uris: vscode.Uri[] = [];
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                const uri = this.getUriFromTab(tab);
                if (uri) {
                    uris.push(uri);
                }
            }
        }
        return uris;
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

        const normalizedFsPath = this.normalizePath(fsPath);

        for (const repo of this._repositories) {
            const repoRoot = repo.rootUri.fsPath;
            const normalizedRepoRoot = this.normalizePath(repoRoot);
            if (
                normalizedFsPath.startsWith(normalizedRepoRoot) &&
                (normalizedFsPath.length === normalizedRepoRoot.length ||
                    normalizedFsPath[normalizedRepoRoot.length] === '/' ||
                    normalizedFsPath[normalizedRepoRoot.length] === path.sep)
            ) {
                if (normalizedRepoRoot.length > bestLength) {
                    bestMatch = repo;
                    bestLength = normalizedRepoRoot.length;
                }
            }
        }

        return bestMatch;
    }

    private updateIgnoredPaths(): void {
        const ignoredPaths = this.getIgnoredRepositoriesConfig();
        const folders = vscode.workspace.workspaceFolders || [];

        this._ignoredAbsolutePaths.clear();
        for (const p of ignoredPaths) {
            const abs = !path.isAbsolute(p) && folders.length > 0 ? path.resolve(folders[0].uri.fsPath, p) : p;
            try {
                const real = realpathSync(abs);
                this._ignoredAbsolutePaths.add(this.normalizePath(real));
            } catch {
                this._ignoredAbsolutePaths.add(this.normalizePath(abs));
            }
        }
    }

    /**
     * Attempt to switch active repository based on a file URI.
     */
    tryAutoSwitch(uri: vscode.Uri): boolean {
        const repo = this.getRepositoryForUri(uri);
        if (
            repo &&
            (!this._focusedRepository || !this.isSamePath(repo.rootUri.fsPath, this._focusedRepository.rootUri.fsPath))
        ) {
            this.setFocusedRepository(repo);
            return true;
        }
        return false;
    }

    private getUriFromTab(tab: vscode.Tab): vscode.Uri | undefined {
        const { input } = tab;
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

    /**
     * Normalizes a directory/file path by resolving dots and converting to lowercase.
     * This provides case-insensitive comparisons to avoid duplicate repository registrations.
     *
     * @param p The path to normalize.
     * @returns The normalized path string.
     */
    private normalizePath(p: string): string {
        return path.normalize(p).replace(/\\/g, '/').toLowerCase();
    }

    /**
     * Compares two paths to determine if they point to the same location, case-insensitively.
     * Supports undefined arguments for clean focused repository comparisons.
     *
     * @param pathA The first path.
     * @param pathB The second path.
     * @returns True if paths are equivalent, false otherwise.
     */
    private isSamePath(pathA: string | undefined, pathB: string | undefined): boolean {
        if (pathA === pathB) {
            return true;
        }
        if (pathA === undefined || pathB === undefined) {
            return false;
        }
        return this.normalizePath(pathA) === this.normalizePath(pathB);
    }

    /**
     * Retrieves the current configuration for automatic repository detection.
     *
     * @returns The autoRepositoryDetection configuration value:
     * - true: recursively scan subfolders.
     * - false: only scan workspace roots.
     * - 'subFolders': scan immediate subfolders.
     * - 'openEditors': only register on-demand when files are opened.
     */
    private getAutoRepositoryDetectionConfig(): boolean | string {
        const config = vscode.workspace.getConfiguration('jj-view');
        return config.get<boolean | string>('autoRepositoryDetection', true);
    }

    /**
     * Retrieves the list of paths to scan for repositories.
     *
     * @returns An array of path strings configured to scan.
     */
    private getScanRepositoriesConfig(): string[] {
        const config = vscode.workspace.getConfiguration('jj-view');
        return config.get<string[]>('scanRepositories', []);
    }

    /**
     * Retrieves the list of repository paths to ignore.
     *
     * @returns An array of path strings configured to ignore.
     */
    private getIgnoredRepositoriesConfig(): string[] {
        const config = vscode.workspace.getConfiguration('jj-view');
        return config.get<string[]>('ignoredRepositories', []);
    }

    /**
     * Determines whether open editors should be used to discover and register repositories.
     * Open editors are used for discovery only if autoRepositoryDetection is true or 'openEditors'.
     *
     * @returns True if open editors should be scanned/tracked, false otherwise.
     */
    private shouldDetectFromOpenEditors(): boolean {
        const configValue = this.getAutoRepositoryDetectionConfig();
        return configValue === true || configValue === 'openEditors';
    }

    /**
     * Determines whether workspace roots should be scanned to discover repositories.
     * Workspace roots are scanned unless autoRepositoryDetection is 'openEditors'.
     *
     * @returns True if workspace roots should be scanned, false otherwise.
     */
    private shouldScanWorkspaceRoots(): boolean {
        const autoDetect = this.getAutoRepositoryDetectionConfig();
        return autoDetect !== 'openEditors';
    }

    /**
     * Clears all registered repositories, firing didClose events and disposing of them.
     * Keeps the manager itself active for subsequent use.
     */
    async clear(): Promise<void> {
        this._outputChannel.appendLine(`[RepositoryManager] Clearing ${this._repositories.length} repositories`);

        // 1. Await any active scan
        if (this._activeScan) {
            this._outputChannel.appendLine(`[RepositoryManager] Awaiting active scan before clearing...`);
            await this._activeScan.catch(() => {});
        }

        // 2. Await any pending registrations
        const pendingPromises = Array.from(this._pendingRegistrations.values());
        this._pendingRegistrations.clear();
        const pendingRepos = await Promise.all(pendingPromises);

        // 3. Clear and dispose registered repositories
        const repos = [...this._repositories];
        this._repositories = [];
        this.setFocusedRepository(undefined);
        for (const repo of repos) {
            this._outputChannel.appendLine(
                `[RepositoryManager] Closing and disposing repository: ${repo.rootUri.fsPath}`,
            );
            this._onDidCloseRepository.fire(repo);
            await repo.dispose();
        }

        // 4. Dispose pending repositories
        for (const repo of pendingRepos) {
            if (repo) {
                this._outputChannel.appendLine(
                    `[RepositoryManager] Closing and disposing pending repository: ${repo.rootUri.fsPath}`,
                );
                await repo.dispose();
            }
        }

        await this._workspaceState.update(JjRepositoryManager.DISCOVERED_REPOS_KEY, undefined);
        await this._workspaceState.update(JjRepositoryManager.LAST_FOCUSED_REPO_KEY, undefined);
        this._onDidChangeRepositories.fire([]);
        this._outputChannel.appendLine(`[RepositoryManager] Clear complete`);
    }

    async dispose(): Promise<void> {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._outputChannel.appendLine(`[RepositoryManager] Disposing JjRepositoryManager`);

        this._onDidOpenRepository.dispose();
        this._onDidCloseRepository.dispose();
        this._onDidChangeFocusedRepository.dispose();
        this._onDidChangeRepositories.dispose();

        // 1. Await any active scan
        if (this._activeScan) {
            this._outputChannel.appendLine(`[RepositoryManager] Awaiting active scan before disposing...`);
            await this._activeScan.catch(() => {});
        }

        // 2. Await any pending registrations
        const pendingPromises = Array.from(this._pendingRegistrations.values());
        this._pendingRegistrations.clear();
        const pendingRepos = await Promise.all(pendingPromises);

        // 3. Dispose registered repositories
        for (const repo of this._repositories) {
            this._outputChannel.appendLine(`[RepositoryManager] Disposing repository: ${repo.rootUri.fsPath}`);
            await repo.dispose();
        }
        this._repositories = [];

        // 4. Dispose pending repositories
        for (const repo of pendingRepos) {
            if (repo) {
                this._outputChannel.appendLine(
                    `[RepositoryManager] Disposing pending repository: ${repo.rootUri.fsPath}`,
                );
                await repo.dispose();
            }
        }

        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables = [];
        this._outputChannel.appendLine(`[RepositoryManager] JjRepositoryManager disposed`);
    }
}
