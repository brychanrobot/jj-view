/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { VirtualFsUriTracker } from '../core/virtual-fs-uri-tracker';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('VirtualFsUriTracker Unit Tests', () => {
    let repo: TestRepo;
    let host: FakeHostEnvironment;
    let repoManager: JjRepositoryManager;
    let tracker: VirtualFsUriTracker;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));
        const codeForgeRegistry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        repoManager = new JjRepositoryManager(codeForgeRegistry, outputChannel, host);
        await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));

        tracker = new VirtualFsUriTracker(repoManager);
    });

    afterEach(async () => {
        tracker.dispose();
        await repoManager.dispose();
        await repo.dispose();
    });

    it('records accessed URIs and notifies on fireChangeEvents', () => {
        const events: Uri[][] = [];
        tracker.onDidChangeFile((uris) => events.push(uris));

        const uri = Uri.file(`${repo.path}/file.txt`);
        tracker.recordAccess(uri);

        const notified = tracker.fireChangeEvents();
        expect(notified.length).toBe(1);
        expect(notified[0].fsPath).toBeSameFsPath(uri.fsPath);
        expect(events.length).toBe(1);

        // Subsequent fireChangeEvents without access should not notify (knownUris cleared)
        const secondNotified = tracker.fireChangeEvents();
        expect(secondNotified.length).toBe(0);
        expect(events.length).toBe(1);
    });

    it('manages watcher reference counting across multiple watch tokens', () => {
        const uri = Uri.file(`${repo.path}/file.txt`);
        let fireCount = 0;
        tracker.onDidChangeFile(() => fireCount++);

        const watcher1 = tracker.watch(uri);
        const watcher2 = tracker.watch(uri);

        tracker.fireChangeEvents();
        expect(fireCount).toBe(1);

        // Disposing watcher1 leaves watcher2 active
        watcher1.dispose();
        tracker.fireChangeEvents();
        expect(fireCount).toBe(2);

        // Disposing watcher2 removes the URI from watched set
        watcher2.dispose();
        tracker.fireChangeEvents();
        expect(fireCount).toBe(2); // No new fire
    });

    it('disposal of watcher token is idempotent', () => {
        const uri = Uri.file(`${repo.path}/file.txt`);
        const watcher = tracker.watch(uri);

        expect(() => {
            watcher.dispose();
            watcher.dispose();
        }).not.toThrow();
    });

    it('fires direct change events immediately', () => {
        const events: Uri[][] = [];
        tracker.onDidChangeFile((uris) => events.push(uris));

        const uri = Uri.file(`${repo.path}/direct.txt`);
        tracker.fireDirectChangeEvents([uri]);

        expect(events.length).toBe(1);
        expect(events[0][0].fsPath).toBeSameFsPath(uri.fsPath);
    });

    it('ignores operations when disposed', () => {
        tracker.dispose();

        const uri = Uri.file(`${repo.path}/file.txt`);
        tracker.recordAccess(uri);
        const watcher = tracker.watch(uri);
        expect(() => watcher.dispose()).not.toThrow();

        const notified = tracker.fireChangeEvents();
        expect(notified.length).toBe(0);
    });

    it('deduplicates URIs in fireDirectChangeEvents', () => {
        const events: Uri[][] = [];
        tracker.onDidChangeFile((uris) => events.push(uris));

        const uri = Uri.file(`${repo.path}/direct.txt`);
        tracker.fireDirectChangeEvents([uri, uri, Uri.file(`${repo.path}/direct.txt`)]);

        expect(events.length).toBe(1);
        expect(events[0].length).toBe(1);
        expect(events[0][0].fsPath).toBeSameFsPath(uri.fsPath);
    });

    it('disposing watcher token after tracker disposal does not throw', () => {
        const uri = Uri.file(`${repo.path}/file.txt`);
        const watcher = tracker.watch(uri);
        tracker.dispose();

        expect(() => watcher.dispose()).not.toThrow();
    });

    it('filters out URIs that do not belong to any registered repository', () => {
        const outsideUri = Uri.file('/outside/non-existent-repo/file.txt');
        tracker.recordAccess(outsideUri);

        const notified = tracker.fireChangeEvents();
        expect(notified.length).toBe(0);
    });
});
