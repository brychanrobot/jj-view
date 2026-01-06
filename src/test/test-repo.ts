// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';

export class TestRepo {
    public readonly path: string;

    constructor(tmpDir?: string) {
        this.path = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'good-juju-test-'));
    }

    dispose() {
        try {
            fs.rmSync(this.path, { recursive: true, force: true });
        } catch (e) {
            // Ignore clean up errors
        }
    }

    // POLICY: This method is intentionally private. Do not expose it publicly.
    // Instead, create specific methods for each operation to ensure strictly typed usage
    // and prevent arbitrary command execution in tests.
    private exec(args: string[]) {
        try {
            return cp
                .execFileSync('jj', ['--quiet', ...args], {
                    cwd: this.path,
                    encoding: 'utf-8',
                })
                .trim();
        } catch (e: unknown) {
            // Re-throw with stdout/stderr for easier debugging
            const err = e as { stdout?: Buffer; stderr?: Buffer };
            throw new Error(
                `Command failed: jj ${args.join(' ')}\nStdout: ${err.stdout?.toString()}\nStderr: ${err.stderr?.toString()}`,
            );
        }
    }

    init() {
        this.exec(['git', 'init']);

        // Configure repo-local settings to avoid global process.env pollution
        const configPath = path.join(this.path, '.jj', 'repo', 'config.toml');
        const configDir = path.dirname(configPath);
        fs.mkdirSync(configDir, { recursive: true });

        const configContent = `
[user]
name = "Test User"
email = "test@example.com"

[ui]
merge-editor = "builtin"
`;
        fs.writeFileSync(configPath, configContent);
    }

    new(parents?: string[], message?: string) {
        const args = ['new'];
        if (parents && parents.length > 0) {
            args.push(...parents);
        }
        if (message) {
            args.push('-m', message);
        }
        this.exec(args);
    }

    snapshot() {
        this.exec(['status']);
    }

    describe(message: string) {
        this.exec(['describe', '-m', message]);
    }

    getDescription(revision: string): string {
        return this.exec(['log', '-r', revision, '-T', 'description', '--no-graph']);
    }

    edit(revision: string) {
        this.exec(['edit', revision]);
    }

    bookmark(name: string, revision: string) {
        this.exec(['bookmark', 'create', name, '-r', revision]);
    }

    abandon(revision: string) {
        this.exec(['abandon', revision]);
    }

    writeFile(relativePath: string, content: string) {
        const fullPath = path.join(this.path, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    }

    readFile(relativePath: string): string {
        return fs.readFileSync(path.join(this.path, relativePath), 'utf-8');
    }

    getFileContent(revision: string, relativePath: string): string {
        return this.exec(['file', 'show', '-r', revision, relativePath]);
    }

    getChangeId(revision: string): string {
        return this.exec(['log', '-r', revision, '-T', 'change_id', '--no-graph']);
    }

    getCommitId(revision: string): string {
        return this.exec(['log', '-r', revision, '-T', 'commit_id', '--no-graph']);
    }

    diff(relativePath: string, revision?: string): string {
        const args = ['diff', '--git'];
        if (revision) {
            args.push('-r', revision);
        }
        args.push(relativePath);
        return this.exec(args);
    }
    getParents(revision: string): string[] {
        const output = this.exec([
            'log',
            '-r',
            revision,
            '-T',
            "parents.map(|p| p.change_id()).join(' ')",
            '--no-graph',
        ]);
        if (!output) return [];
        return output.split(' ');
    }

    track(relativePath: string) {
        this.exec(['file', 'track', relativePath]);
    }

    getBookmarks(revision: string): string[] {
        const output = this.exec(['log', '-r', revision, '-T', "bookmarks.map(|b| b.name()).join(' ')", '--no-graph']);
        if (!output) return [];
        return output.split(' ');
    }

    listFiles(revision: string): string[] {
        const output = this.exec(['file', 'list', '-r', revision]);
        if (!output) return [];
        return output.split('\n');
    }

    log(): string {
        return this.exec(['log']);
    }

    getLogOutput(template: string, revision: string = '::'): string {
        return this.exec(['log', '-r', revision, '-T', template, '--color', 'never']);
    }

    isImmutable(revision: string): boolean {
        const output = this.exec(['log', '-r', revision, '-T', 'immutable', '--no-graph', '--color', 'never']);
        return output.trim() === 'true';
    }
}

export interface CommitDefinition {
    label?: string;
    parents?: string[];
    description?: string;
    files?: Record<string, string>;
    bookmarks?: string[];
    isWorkingCopy?: boolean;
}

export interface CommitId {
    changeId: string;
    commitId: string;
}

export async function buildGraph(repo: TestRepo, commits: CommitDefinition[]): Promise<Record<string, CommitId>> {
    const labelToId: Record<string, CommitId> = {};

    // Helper to resolve parents
    const resolveParents = (parents?: string[]): string[] => {
        if (!parents || parents.length === 0) {
            return [];
        }
        return parents.map((p) => labelToId[p]?.changeId || p);
    };

    for (const commit of commits) {
        const parents = resolveParents(commit.parents);
        const description = commit.description || commit.label;

        repo.new(parents, description);

        // Apply file changes
        if (commit.files) {
            for (const [file, content] of Object.entries(commit.files)) {
                repo.writeFile(file, content);
            }
        }

        // Snapshot changes so they become part of the commit
        // 'jj new' automatically snapshots the *previous* WC, but here we are in the WC of the *current* commit we just created with 'new'

        // Capture ID
        const changeId = repo.getChangeId('@');
        const commitId = repo.getCommitId('@');
        if (commit.label) {
            labelToId[commit.label] = { changeId, commitId };
        }

        // Apply bookmarks
        if (commit.bookmarks) {
            for (const bookmark of commit.bookmarks) {
                repo.bookmark(bookmark, '@');
            }
        }
    }

    // Handle isWorkingCopy
    for (const commit of commits) {
        if (commit.isWorkingCopy && commit.label) {
            const entry = labelToId[commit.label];
            if (entry) {
                repo.edit(entry.changeId);
            }
        }
    }

    // Return map
    return labelToId;
}
