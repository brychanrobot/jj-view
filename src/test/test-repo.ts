/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { Buffer } from 'node:buffer';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { match, P } from 'ts-pattern';
import which from 'which';
import { recordCommandTrace } from './perf-trace';

function memoize<T>(fn: () => T): () => T {
    let cached: T | undefined;
    let computed = false;
    return () => {
        if (!computed) {
            cached = fn();
            computed = true;
        }
        return cached as T;
    };
}

const tempDirs = new Set<string>();
const defaultTestConfigFile = path.join(os.tmpdir(), `jj-view-default-config-${process.pid}.toml`);
try {
    fs.writeFileSync(
        defaultTestConfigFile,
        `user.name = "Test User"
user.email = "test@example.com"
signing.backend = "none"
ui.merge-editor = "builtin"
`,
        'utf-8',
    );
    tempDirs.add(defaultTestConfigFile);
} catch {}

function getUserJjDir(): string {
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'jj');
    }
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(configHome, 'jj');
}

function createMetadataBinpb(repoPath: string): Buffer {
    const strBuf = Buffer.from(repoPath, 'utf-8');
    const len = strBuf.length;
    const varintBuf: number[] = [];
    let v = len;
    while (v > 0x7f) {
        varintBuf.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    varintBuf.push(v);
    return Buffer.concat([Buffer.from([0x0a]), Buffer.from(varintBuf), strBuf]);
}

function formatTomlValue(val: string): string {
    const trimmed = val.trim();
    if (trimmed === '') {
        return '""';
    }
    if (
        trimmed === 'true' ||
        trimmed === 'false' ||
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)
    ) {
        return trimmed;
    }
    return JSON.stringify(val);
}

function cleanup() {
    for (const dir of tempDirs) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
    }
    tempDirs.clear();
}

process.on('exit', cleanup);
process.once('SIGINT', () => {
    cleanup();
    process.kill(process.pid, 'SIGINT');
});
process.once('SIGTERM', () => {
    cleanup();
    process.kill(process.pid, 'SIGTERM');
});

export class TestRepo {
    static readonly getJjBinary = memoize((): string => which.sync('jj'));

    static readonly getGitBinary = memoize((): string => which.sync('git'));

    public readonly path: string;
    private configId?: string;

    private ensureRepoConfig(): { configId: string; repoConfigDir: string; configPath: string } {
        const start = process.hrtime.bigint();
        if (!this.configId) {
            const configIdFile = path.join(this.path, '.jj', 'repo', 'config-id');
            if (fs.existsSync(configIdFile)) {
                this.configId = fs.readFileSync(configIdFile, 'utf-8').trim();
            } else {
                this.configId = crypto.randomBytes(10).toString('hex');
                fs.mkdirSync(path.dirname(configIdFile), { recursive: true });
                fs.writeFileSync(configIdFile, this.configId, 'utf-8');
            }
        }
        const userJjDir = getUserJjDir();
        const repoConfigDir = path.join(userJjDir, 'repos', this.configId);
        const configPath = path.join(repoConfigDir, 'config.toml');
        const metadataPath = path.join(repoConfigDir, 'metadata.binpb');
        if (!fs.existsSync(repoConfigDir)) {
            fs.mkdirSync(repoConfigDir, { recursive: true });
        }
        if (!fs.existsSync(metadataPath)) {
            const fullRepoPath = path.resolve(this.path, '.jj', 'repo');
            fs.writeFileSync(metadataPath, createMetadataBinpb(fullRepoPath));
        }
        tempDirs.add(repoConfigDir);
        const duration = Math.max(0, Number(process.hrtime.bigint() - start) / 1_000_000);
        recordCommandTrace('TestRepo', ['repo-config-write'], duration);
        return { configId: this.configId, repoConfigDir, configPath };
    }

    constructor(tmpDir?: string) {
        const rawPath = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-test-'));
        if (tmpDir) {
            fs.mkdirSync(rawPath, { recursive: true });
        }
        this.path = fs.realpathSync.native ? fs.realpathSync.native(rawPath) : fs.realpathSync(rawPath);
        tempDirs.add(this.path);
    }

    dispose() {
        if (!this.configId) {
            const configIdFile = path.join(this.path, '.jj', 'repo', 'config-id');
            if (fs.existsSync(configIdFile)) {
                try {
                    this.configId = fs.readFileSync(configIdFile, 'utf-8').trim();
                } catch {}
            }
        }

        const repoPath = this.path;
        fs.promises
            .rm(repoPath, { recursive: true, force: true })
            .catch(() => {})
            .finally(() => {
                tempDirs.delete(repoPath);
            });

        if (this.configId) {
            const userJjDir = getUserJjDir();
            const repoConfigDir = path.join(userJjDir, 'repos', this.configId);
            const gcStart = process.hrtime.bigint();
            fs.promises
                .rm(repoConfigDir, { recursive: true, force: true })
                .then(() => {
                    const duration = Math.max(0, Number(process.hrtime.bigint() - gcStart) / 1_000_000);
                    recordCommandTrace('TestRepo', ['repo-config-gc'], duration);
                })
                .catch(() => {})
                .finally(() => {
                    tempDirs.delete(repoConfigDir);
                });
        }
    }

    // POLICY: This method is intentionally private. Do not expose it publicly.
    // Instead, create specific methods for each operation to ensure strictly typed usage
    // and prevent arbitrary command execution in tests.
    private exec(args: string[], options: { trim?: boolean } = {}): { stdout: string; stderr: string } {
        const env = { ...process.env, JJ_CONFIG: '' };
        const jjBinary = TestRepo.getJjBinary();
        const start = process.hrtime.bigint();
        const res = cp.spawnSync(jjBinary, args, {
            cwd: this.path,
            encoding: 'utf-8',
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const durationMs = Math.max(0, Number(process.hrtime.bigint() - start) / 1_000_000);
        recordCommandTrace('TestRepo', args, durationMs);

        if (res.error) {
            if ('code' in res.error && res.error.code === 'ENOENT') {
                const pathEnv = process.env.PATH || 'undefined';
                throw new Error(
                    `Could not find '${jjBinary}' binary in PATH.\n` +
                        `Current PATH: ${pathEnv}\n` +
                        `Check if jj is installed and available in the environment.`,
                );
            }
            throw res.error;
        }

        const stderr = res.stderr || '';

        // If the working copy is stale, try again with --ignore-working-copy
        // if we haven't already tried it.
        if (
            res.status !== 0 &&
            stderr.toLowerCase().includes('working copy is stale') &&
            !args.includes('--ignore-working-copy')
        ) {
            return this.exec(['--ignore-working-copy', ...args], options);
        }

        if (res.status !== 0) {
            const stdout = res.stdout || 'undefined';
            throw new Error(
                `Command failed: jj ${args.join(' ')}\n` +
                    `Status: ${res.status}\n` +
                    `Stdout: ${stdout}\n` +
                    `Stderr: ${stderr}`,
            );
        }

        const stdout = options.trim !== false ? (res.stdout || '').trim() : res.stdout || '';
        const finalStderr = options.trim !== false ? stderr.trim() : stderr;
        return { stdout, stderr: finalStderr };
    }

    config(name: string, value: string) {
        const { configPath } = this.ensureRepoConfig();
        fs.appendFileSync(configPath, `${name} = ${formatTomlValue(value)}\n`, 'utf-8');
    }

    configBatch(configs: Record<string, string>) {
        const { configPath } = this.ensureRepoConfig();
        let content = '';
        for (const [key, val] of Object.entries(configs)) {
            content += `${key} = ${formatTomlValue(val)}\n`;
        }
        fs.appendFileSync(configPath, content, 'utf-8');
    }

    metaedit(options: { updateAuthor?: boolean; revision?: string } = {}) {
        const args = ['metaedit'];
        if (options.updateAuthor) {
            args.push('--update-author');
        }
        if (options.revision) {
            args.push('-r', options.revision);
        }
        this.exec(args);
    }

    init() {
        this.exec(['--config-file', defaultTestConfigFile, 'git', 'init']);
        const { configPath } = this.ensureRepoConfig();
        if (!fs.existsSync(configPath)) {
            fs.copyFileSync(defaultTestConfigFile, configPath);
        } else {
            const existing = fs.readFileSync(configPath, 'utf-8');
            const defaultContent = fs.readFileSync(defaultTestConfigFile, 'utf-8');
            fs.writeFileSync(configPath, `${defaultContent}\n${existing}`, 'utf-8');
        }
    }

    new(parents?: string[], message?: string): { changeId: string; commitId: string } {
        const args = ['--color=never', 'new'];
        if (parents && parents.length > 0) {
            args.push(...parents);
        }
        if (message !== undefined) {
            args.push('-m', message);
        }
        const { stderr } = this.exec(args);
        const match = stderr.match(/Working copy\s+\(@\)\s+now at:\s+([a-z0-9]+)\s+([a-z0-9]+)/i);
        if (match) {
            return { changeId: match[1], commitId: match[2] };
        }
        return this.getChangeAndCommitId('@');
    }

    snapshot() {
        this.exec(['status']);
    }

    describe(message: string, revision?: string) {
        const args = ['describe', '-m', message];
        if (revision) {
            args.push('-r', revision);
        }
        this.exec(args);
    }

    getDescription(revision: string): string {
        return this.exec(['log', '--ignore-working-copy', '-r', revision, '-T', 'description', '--no-graph']).stdout;
    }

    edit(revision: string) {
        this.exec(['edit', revision]);
    }

    getWorkingCopyId(): string {
        return this.exec(['log', '--ignore-working-copy', '-r', '@', '-T', 'change_id', '--no-graph']).stdout;
    }

    getDiffSummary(revision: string = '@'): string {
        return this.exec(['diff', '-r', revision, '--summary']).stdout;
    }

    getDiff(revision: string = '@', options: { git?: boolean } = {}): string {
        const args = ['diff', '-r', revision];
        if (options.git) {
            args.push('--git');
        }
        return this.exec(args).stdout;
    }

    untrack(path: string | string[]): void {
        const paths = Array.isArray(path) ? path : [path];
        this.exec(['file', 'untrack', ...paths]);
    }

    getFiles(revision: string = '@'): string[] {
        const output = this.exec(['file', 'list', '--ignore-working-copy', '-r', revision]).stdout;
        return output
            .split('\n')
            .map((f) => f.trim())
            .filter((f) => f.length > 0);
    }

    bookmark(name: string, revision: string) {
        this.exec(['bookmark', 'create', '--ignore-working-copy', name, '-r', revision]);
    }

    bookmarkMove(name: string, revision: string) {
        this.exec(['bookmark', 'set', '--ignore-working-copy', name, '-r', revision]);
    }

    tag(name: string, revision: string) {
        this.exec(['tag', 'set', '--ignore-working-copy', name, '-r', revision]);
    }

    abandon(revision: string) {
        this.exec(['abandon', revision]);
    }

    squash(revision?: string, destination?: string) {
        const args = ['squash'];
        if (revision) {
            args.push('-r', revision);
        }
        if (destination) {
            args.push('-d', destination);
        }
        this.exec(args);
    }

    rebase(options: { revision?: string; destination?: string; source?: string } = {}) {
        const args = ['rebase'];
        if (options.revision) {
            args.push('-r', options.revision);
        }
        if (options.source) {
            args.push('-s', options.source);
        }
        if (options.destination) {
            args.push('-d', options.destination);
        }
        this.exec(args);
    }

    writeFile(relativePath: string, content: string) {
        const fullPath = path.join(this.path, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
        this.snapshot();
    }

    async writeFiles(files: Record<string, string>): Promise<void> {
        await Promise.all(
            Object.entries(files).map(async ([file, content]) => {
                const fullPath = path.join(this.path, file);
                await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.promises.writeFile(fullPath, content);
            }),
        );
        this.snapshot();
    }

    moveFile(oldPath: string, newPath: string) {
        const fullOldPath = path.join(this.path, oldPath);
        const fullNewPath = path.join(this.path, newPath);
        fs.mkdirSync(path.dirname(fullNewPath), { recursive: true });
        fs.renameSync(fullOldPath, fullNewPath);
        this.snapshot();
    }

    deleteFile(relativePath: string) {
        fs.rmSync(path.join(this.path, relativePath));
        this.snapshot();
    }

    readFile(relativePath: string): string {
        return fs.readFileSync(path.join(this.path, relativePath), 'utf-8');
    }

    getFileContent(revision: string, relativePath: string): string {
        return this.exec(['file', 'show', '--ignore-working-copy', '-r', revision, relativePath], { trim: false })
            .stdout;
    }

    getChangeId(revision: string): string {
        return this.exec(['log', '--ignore-working-copy', '-r', revision, '-T', 'change_id', '--no-graph']).stdout;
    }

    getCommitId(revision: string): string {
        return this.exec(['log', '--ignore-working-copy', '-r', revision, '-T', 'commit_id', '--no-graph']).stdout;
    }

    getChangeAndCommitId(revision: string): { changeId: string; commitId: string } {
        const output = this.exec([
            'log',
            '--ignore-working-copy',
            '-r',
            revision,
            '-T',
            'change_id ++ " " ++ commit_id',
            '--no-graph',
        ]).stdout;
        const [changeId = '', commitId = ''] = output.trim().split(/\s+/);
        return { changeId, commitId };
    }

    getChangeAndCommitIds(): Map<string, string> {
        const output = this.exec([
            'log',
            '--ignore-working-copy',
            '-r',
            'all()',
            '-T',
            'change_id ++ " " ++ commit_id ++ "\n"',
            '--no-graph',
        ]).stdout;
        const map = new Map<string, string>();
        for (const line of output.split('\n')) {
            const [changeId, commitId] = line.trim().split(/\s+/);
            if (changeId && commitId) {
                map.set(changeId, commitId);
            }
        }
        return map;
    }

    batchMetadata(ops: { type: 'bookmark' | 'tag'; name: string; revision: string }[], workingCopyChangeId?: string) {
        if (ops.length === 0 && !workingCopyChangeId) {
            return;
        }
        for (const op of ops) {
            if (op.type === 'bookmark') {
                this.exec(['bookmark', 'create', '--ignore-working-copy', op.name, '-r', op.revision]);
            } else if (op.type === 'tag') {
                this.exec(['tag', 'set', '--ignore-working-copy', op.name, '-r', op.revision]);
            }
        }
        if (workingCopyChangeId) {
            this.exec(['edit', workingCopyChangeId]);
        }
    }

    diff(relativePath: string, revision?: string): string {
        const args = ['diff', '--git'];
        if (revision) {
            args.push('-r', revision);
        }
        args.push(relativePath);
        return this.exec(args).stdout;
    }
    getParents(revision: string): string[] {
        const output = this.exec([
            'log',
            '--ignore-working-copy',
            '-r',
            revision,
            '-T',
            "parents.map(|p| p.change_id()).join(' ')",
            '--no-graph',
        ]).stdout;
        if (!output) {
            return [];
        }
        return output.split(' ');
    }

    getChildren(revision: string): string[] {
        const output = this.exec([
            'log',
            '--ignore-working-copy',
            '-r',
            `children(${revision})`,
            '-T',
            'change_id ++ "\\n"',
            '--no-graph',
        ]).stdout;
        if (!output) {
            return [];
        }
        return output.trim().split('\n').filter(Boolean);
    }

    track(relativePath: string) {
        this.exec(['file', 'track', relativePath]);
    }

    addRemote(name: string, url: string) {
        this.exec(['git', 'remote', 'add', name, url]);
    }

    getBookmarks(revision: string): string[] {
        const output = this.exec([
            'log',
            '--ignore-working-copy',
            '-r',
            revision,
            '-T',
            "bookmarks.map(|b| b.name()).join(' ')",
            '--no-graph',
        ]).stdout;
        if (!output) {
            return [];
        }
        return output.split(' ');
    }

    listFiles(revision: string): string[] {
        const output = this.exec(['file', 'list', '--ignore-working-copy', '-r', revision]).stdout;
        if (!output) {
            return [];
        }
        return output.split('\n');
    }

    log(): string {
        return this.exec(['log', '--ignore-working-copy']).stdout;
    }

    getLogOutput(template: string): string {
        return this.exec(['log', '--ignore-working-copy', '-T', template, '--color', 'never']).stdout;
    }

    getLog(revision: string, template: string): string {
        return this.exec([
            'log',
            '--ignore-working-copy',
            '-r',
            revision,
            '-T',
            template,
            '--no-graph',
            '--color',
            'never',
        ]).stdout;
    }

    isImmutable(revision: string): boolean {
        const output = this.exec([
            'log',
            '--ignore-working-copy',
            '-r',
            revision,
            '-T',
            'immutable',
            '--no-graph',
            '--color',
            'never',
        ]).stdout;
        return output.trim() === 'true';
    }

    workspaceAdd(name: string, revision?: string, workspacePath?: string): TestRepo {
        const resolvedPath = workspacePath || path.join(this.path, name);
        fs.mkdirSync(resolvedPath, { recursive: true });
        const args = ['workspace', 'add', resolvedPath];
        if (revision) {
            args.push('-r', revision);
        }
        if (workspacePath) {
            args.push('--name', name);
        }
        this.exec(args);
        return new TestRepo(resolvedPath);
    }

    gitImport() {
        this.exec(['git', 'import']);
    }

    gitPush(bookmarkName: string) {
        this.exec(['git', 'push', '--bookmark', bookmarkName]);
    }

    listWorkspaces(): string {
        return this.exec(['workspace', 'list']).stdout;
    }

    hasGitRef(ref: string): boolean {
        const gitBinary = TestRepo.getGitBinary();
        try {
            cp.execFileSync(gitBinary, ['show-ref', '--verify', ref], {
                cwd: this.path,
                stdio: 'ignore',
                windowsHide: true,
            });
            return true;
        } catch {
            return false;
        }
    }

    getGitRefSha(ref: string): string {
        const gitBinary = TestRepo.getGitBinary();
        const output = cp.execFileSync(gitBinary, ['rev-parse', ref], {
            cwd: this.path,
            encoding: 'utf-8',
            windowsHide: true,
        });
        return output.trim();
    }

    listGitRefs(prefix?: string): string[] {
        const gitBinary = TestRepo.getGitBinary();
        try {
            const output = cp.execFileSync(gitBinary, ['show-ref'], {
                cwd: this.path,
                encoding: 'utf-8',
                windowsHide: true,
            });
            const refs = output
                .split('\n')
                .map((line) => line.trim().split(/\s+/)[1])
                .filter(Boolean);
            if (prefix) {
                return refs.filter((ref) => ref.startsWith(prefix));
            }
            return refs;
        } catch {
            return [];
        }
    }

    getCurrentOperationId(): string {
        return this.exec(['op', 'log', '-T', 'id', '--limit', '1', '--no-graph']).stdout;
    }

    getOperationsSince(opId: string): { id: string; description: string }[] {
        const output = this.exec(['op', 'log', '--no-graph', '-T', 'id ++ " " ++ description ++ "\\n"']).stdout;
        const lines = output
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        const ops: { id: string; description: string }[] = [];
        for (const line of lines) {
            const spaceIdx = line.indexOf(' ');
            const id = spaceIdx !== -1 ? line.substring(0, spaceIdx) : line;
            const description = spaceIdx !== -1 ? line.substring(spaceIdx + 1) : '';
            if (id.startsWith(opId) || opId.startsWith(id)) {
                break;
            }
            ops.push({ id, description });
        }
        return ops;
    }

    expectTree(expected: ExpectedTreeItem[]): void {
        expectTree(this, expected);
    }
}

export const ROOT_ID = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

export interface TreeEntrySpec {
    changeId?: string;
    description: string;
    parents?: string | string[];
    files?: Record<string, string>;
    isWorkingCopy?: boolean;
}

export interface CustomAsymmetricMatcher {
    asymmetricMatch?(other: string): boolean;
    [key: string]: string | boolean | RegExp | ((other: string) => boolean) | undefined;
}

export type ExpectedTreeItem = string | TreeEntrySpec | RegExp | CustomAsymmetricMatcher;

function matchesLine(exp: ExpectedTreeItem, act: string): boolean {
    return match(exp)
        .with(P.string, (str) => {
            if (str.includes('*')) {
                const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[a-z0-9]+');
                return new RegExp(`^${escaped}$`).test(act);
            }
            return act === str;
        })
        .with(P.instanceOf(RegExp), (r) => r.test(act))
        .with(
            P.when((val): val is CustomAsymmetricMatcher =>
                Boolean(
                    val &&
                        typeof val === 'object' &&
                        'asymmetricMatch' in val &&
                        typeof (val as CustomAsymmetricMatcher).asymmetricMatch === 'function',
                ),
            ),
            (matcher) => matcher.asymmetricMatch?.(act) ?? false,
        )
        .otherwise(() => String(exp) === act);
}

function getExpectedLine(item: ExpectedTreeItem): ExpectedTreeItem {
    return match(item)
        .with(P.string, (s) => s)
        .with(P.instanceOf(RegExp), (r) => r)
        .with({ description: P.string }, (spec) => {
            const changeId = spec.changeId ?? '*';
            const p = Array.isArray(spec.parents) ? spec.parents.join(',') : spec.parents || '';
            const prefix = spec.isWorkingCopy ? '@ ' : '';
            return `${prefix}${changeId} [${p}] ${spec.description}`;
        })
        .otherwise(() => item);
}

function fetchActualTree(repo: TestRepo): string[] {
    const template =
        'if(current_working_copy, "@ ", "") ++ change_id ++ " [" ++ parents.map(|p| p.change_id()).join(",") ++ "] " ++ if(description, description.first_line(), "(empty)") ++ "\\n"';
    const log = repo.getLog('all()', template);
    return log
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('zzzzzzzz'));
}

function verifyTreeLines(expectedLines: ExpectedTreeItem[], actualLines: string[]): void {
    if (actualLines.length !== expectedLines.length) {
        throw new Error(`Length mismatch: expected ${expectedLines.length} lines, got ${actualLines.length}`);
    }

    for (let i = 0; i < expectedLines.length; i++) {
        const exp = expectedLines[i];
        const act = actualLines[i];
        if (!matchesLine(exp, act)) {
            throw new Error(`Line ${i} mismatch: expected "${String(exp)}", got "${act}"`);
        }
    }
}

function verifyEntryFiles(repo: TestRepo, item: ExpectedTreeItem, actualLine: string): void {
    const files = match(item)
        .with({ files: P.select(P.not(P.nullish)) }, (f) => f)
        .otherwise(() => undefined);

    if (!files) {
        return;
    }

    const matchResult = actualLine.match(/^(?:@\s+)?([a-z0-9]+)\s+\[/);
    const actualChangeId = matchResult
        ? matchResult[1]
        : match(item)
              .with({ changeId: P.select(P.string) }, (id) => id)
              .otherwise(() => undefined);

    if (!actualChangeId || actualChangeId === '*') {
        return;
    }

    for (const [filePath, expectedContent] of Object.entries(files)) {
        const actualContent = repo.getFileContent(actualChangeId, filePath);
        if (actualContent !== expectedContent) {
            throw new Error(
                `File content mismatch for ${filePath} at change ${actualChangeId}: expected "${expectedContent}", got "${actualContent}"`,
            );
        }
    }
}

function formatTreeLine(item: ExpectedTreeItem): string {
    return match(item)
        .with(P.string, (s) => s)
        .with(P.instanceOf(RegExp), (r) => String(r))
        .with({ description: P.string }, (spec) => {
            const changeId = spec.changeId ?? '*';
            const p = Array.isArray(spec.parents) ? spec.parents.join(',') : spec.parents || '';
            const prefix = spec.isWorkingCopy ? '@ ' : '';
            return `${prefix}${changeId} [${p}] ${spec.description}`;
        })
        .otherwise((val) => String(val));
}

/**
 * Asserts that the repo log matches the expected structure, and optionally verifies file contents.
 */
export function expectTree(repo: TestRepo, expected: ExpectedTreeItem[]): void {
    const expectedLines = expected.map(getExpectedLine);
    const actualLines = fetchActualTree(repo);

    try {
        verifyTreeLines(expectedLines, actualLines);

        for (let i = 0; i < expected.length; i++) {
            verifyEntryFiles(repo, expected[i], actualLines[i]);
        }
    } catch (err: unknown) {
        const lastError = err as Error;
        const formatTree = (tree: ExpectedTreeItem[]) => tree.map((line) => `  ${formatTreeLine(line)}`).join('\n');
        throw new Error(
            `expectTree failed (${lastError.message})\n\nExpected Tree:\n${formatTree(expectedLines)}\n\nActual Tree:\n${formatTree(actualLines)}`,
        );
    }
}

export interface CommitDefinition {
    label?: string;
    parents?: string[];
    description?: string;
    files?: Record<string, string>;
    bookmarks?: string[];
    tags?: string[];
    isCurrentWorkingCopy?: boolean;
}

export interface CommitId {
    changeId: string;
    commitId: string;
}

export async function buildGraph(repo: TestRepo, commits: CommitDefinition[]): Promise<Record<string, CommitId>> {
    if (commits.length === 0) {
        return {};
    }

    const labelToId: Record<string, CommitId> = {};
    const metadataOps: { type: 'bookmark' | 'tag'; name: string; revision: string }[] = [];
    let workingCopyChangeId: string | undefined;
    let anyFilesWritten = false;

    // Helper to resolve parents
    const resolveParents = (parents?: string[]): string[] => {
        if (!parents || parents.length === 0) {
            return [];
        }
        return parents.map((p) => labelToId[p]?.changeId || p);
    };

    for (const commit of commits) {
        const parents = resolveParents(commit.parents);
        const description = commit.description !== undefined ? commit.description : commit.label;

        const { changeId, commitId } = repo.new(parents, description);

        if (commit.label) {
            labelToId[commit.label] = { changeId, commitId };
        }

        // Apply file changes directly to the working directory without intermediate snapshots
        if (commit.files && Object.keys(commit.files).length > 0) {
            anyFilesWritten = true;
            for (const [filePath, content] of Object.entries(commit.files)) {
                const fullPath = path.join(repo.path, filePath);
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, content);
            }
        }

        // Collect bookmarks for later batched application
        if (commit.bookmarks) {
            for (const bookmark of commit.bookmarks) {
                metadataOps.push({ type: 'bookmark', name: bookmark, revision: changeId });
            }
        }

        // Collect tags for later batched application
        if (commit.tags) {
            for (const tag of commit.tags) {
                metadataOps.push({ type: 'tag', name: tag, revision: changeId });
            }
        }

        if (commit.isCurrentWorkingCopy) {
            workingCopyChangeId = changeId;
        }
    }

    if (anyFilesWritten) {
        repo.snapshot();
    }

    // Batch all metadata operations (bookmarks, tags, edit) in a single shell invocation
    if (metadataOps.length > 0 || workingCopyChangeId) {
        repo.batchMetadata(metadataOps, workingCopyChangeId);
    }

    // Resolve full 32-character change IDs and final commit IDs in a single log call
    const allIds = repo.getChangeAndCommitIds();
    for (const entry of Object.values(labelToId)) {
        for (const [fullChangeId, fullCommitId] of allIds.entries()) {
            if (fullChangeId.startsWith(entry.changeId)) {
                entry.changeId = fullChangeId;
                entry.commitId = fullCommitId;
                break;
            }
        }
    }

    return labelToId;
}

export class ScopedTestRepo extends TestRepo implements Disposable {
    [Symbol.dispose]() {
        this.dispose();
    }
}
