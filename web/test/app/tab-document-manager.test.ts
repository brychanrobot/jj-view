/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { HostFs } from '../../../src/core/host/host-system';
import type { RemoteHostSystem } from '../../../src/core/host/remote-host-system';
import type { JjEditFsService } from '../../../src/core/jj-edit-fs-service';
import type { ScmModel } from '../../../src/core/scm-model';
import type { JjResourceState } from '../../../src/core/scm-resource-state';
import { Uri } from '../../../src/core/uri-utils';
import { type CommitDetailsSession, TabDocumentManager } from '../../src/app/tab-document-manager.svelte';
import type { InMemoryBridge } from '../../src/bridge/in-memory-bridge';
import type { WebHostDocuments, WebHostEnvironment } from '../../src/host/web-host-environment';
import { NotificationService } from '../../src/notifications/notification-service';
import { createMock } from '../test-mock';

describe('TabDocumentManager', () => {
    it('opens, previews, pins, reorders, and closes tabs', () => {
        const manager = new TabDocumentManager({
            webHostEnv: undefined,
            notificationService: new NotificationService(),
            fsEditService: undefined,
            fsViewService: undefined,
            remoteHostSystem: undefined,
            resolveScmModelForUri: () => undefined,
            getCurrentSnapshot: () => undefined,
            getWorkspaceRoot: () => '/repo',
            openFileDiffForChange: async () => {},
            handleAction: async () => {},
        });

        const fileUri1 = Uri.file('/repo/file1.ts');
        const fileUri2 = Uri.file('/repo/file2.ts');
        const fileUri3 = Uri.file('/repo/file3.ts');

        // Open preview tab
        manager.openOrActivateTab(
            { type: 'file', uri: fileUri1, title: 'file1.ts', content: 'content 1' },
            { preview: true },
        );
        expect(manager.tabs.length).toBe(1);
        expect(manager.tabs[0].preview).toBe(true);
        expect(manager.activeTabId).toBe(manager.tabs[0].id);

        // Opening another preview tab replaces the existing preview tab
        manager.openOrActivateTab(
            { type: 'file', uri: fileUri2, title: 'file2.ts', content: 'content 2' },
            { preview: true },
        );
        expect(manager.tabs.length).toBe(1);
        expect(manager.tabs[0].title).toBe('file2.ts');
        expect(manager.tabs[0].preview).toBe(true);

        // Pin current tab
        manager.pinTab(manager.tabs[0].id);
        expect(manager.tabs[0].preview).toBe(false);

        // Now opening another preview tab does not replace the pinned tab
        manager.openOrActivateTab(
            { type: 'file', uri: fileUri3, title: 'file3.ts', content: 'content 3' },
            { preview: true },
        );
        expect(manager.tabs.length).toBe(2);
        expect(manager.tabs[1].title).toBe('file3.ts');
        expect(manager.tabs[1].preview).toBe(true);

        // Reorder tabs
        const tab2Id = manager.tabs[0].id;
        const tab3Id = manager.tabs[1].id;
        manager.handleReorderTabs(tab3Id, tab2Id, 'before');
        expect(manager.tabs[0].id).toBe(tab3Id);
        expect(manager.tabs[1].id).toBe(tab2Id);

        // Close tabs to the right
        manager.openOrActivateTab(
            { type: 'file', uri: fileUri1, title: 'file1.ts', content: 'content 1' },
            { preview: false },
        );
        expect(manager.tabs.length).toBe(3);
        manager.closeTabsToTheRight(manager.tabs[0].id);
        expect(manager.tabs.length).toBe(1);
        expect(manager.tabs[0].id).toBe(tab3Id);

        // Close other tabs
        manager.openOrActivateTab(
            { type: 'file', uri: fileUri2, title: 'file2.ts', content: 'content 2' },
            { preview: false },
        );
        expect(manager.tabs.length).toBe(2);
        const activeId = manager.tabs[1].id;
        manager.closeOtherTabs(activeId);
        expect(manager.tabs.length).toBe(1);
        expect(manager.tabs[0].id).toBe(activeId);

        // Close all tabs
        manager.closeAllTabs();
        expect(manager.tabs.length).toBe(0);
        expect(manager.activeTabId).toBeUndefined();
    });

    it('manages commitDetailsSessions lifecycle on closeTabById', () => {
        const manager = new TabDocumentManager({
            webHostEnv: undefined,
            notificationService: new NotificationService(),
            fsEditService: undefined,
            fsViewService: undefined,
            remoteHostSystem: undefined,
            resolveScmModelForUri: () => undefined,
            getCurrentSnapshot: () => undefined,
            getWorkspaceRoot: () => '/repo',
            openFileDiffForChange: async () => {},
            handleAction: async () => {},
        });

        let sessionDisposed = false;
        const dummySession: CommitDetailsSession = {
            bridge: createMock<InMemoryBridge>(),
            controller: createMock(),
            disposed: false,
            dispose: () => {
                dummySession.disposed = true;
                sessionDisposed = true;
            },
        };

        const tabId = 'commit-details:rev123';
        manager.tabs.push({
            id: tabId,
            title: 'Commit rev123',
            preview: false,
            isDirty: false,
            view: { type: 'commit-details', changeId: 'rev123' },
        });
        manager.commitDetailsSessions.set(tabId, dummySession);

        expect(manager.commitDetailsSessions.has(tabId)).toBe(true);
        manager.closeTabById(tabId);
        expect(manager.commitDetailsSessions.has(tabId)).toBe(false);
        expect(sessionDisposed).toBe(true);
        expect(dummySession.disposed).toBe(true);
        expect(manager.tabs.length).toBe(0);
    });

    it('discards stale reload responses when documentReloadGeneration advances', async () => {
        let readCount = 0;
        const mockHost = createMock<RemoteHostSystem>({
            fs: createMock<HostFs>({
                readTextFile: async () => {
                    readCount++;
                    if (readCount === 1) {
                        // Artificial delay for first reload
                        await new Promise((resolve) => setTimeout(resolve, 50));
                        return 'stale content';
                    }
                    return 'fresh content';
                },
            }),
        });

        const manager = new TabDocumentManager({
            webHostEnv: undefined,
            notificationService: new NotificationService(),
            fsEditService: undefined,
            fsViewService: undefined,
            remoteHostSystem: mockHost,
            resolveScmModelForUri: () => undefined,
            getCurrentSnapshot: () => undefined,
            getWorkspaceRoot: () => '/repo',
            openFileDiffForChange: async () => {},
            handleAction: async () => {},
        });

        const fileUri = Uri.file('/repo/file.ts');
        manager.openOrActivateTab({
            type: 'file',
            uri: fileUri,
            title: 'file.ts',
            content: 'initial content',
        });

        const firstReloadPromise = manager.reloadOpenDocumentTabs();
        const secondReloadPromise = manager.reloadOpenDocumentTabs();
        await Promise.all([firstReloadPromise, secondReloadPromise]);

        const activeTab = manager.activeTab;
        expect(activeTab).toBeDefined();
        if (activeTab && activeTab.view.type === 'file') {
            expect(activeTab.view.content).toBe('fresh content');
        }
    });

    it('saves files via handleSaveFile and saveUriIfDirty', async () => {
        let savedUri: string | undefined;
        let savedContent: string | undefined;
        let didSaveNotifiedUri: Uri | undefined;
        let refreshReason: string | undefined;

        const mockHost = createMock<RemoteHostSystem>({
            fs: createMock<HostFs>({
                writeTextFile: async (filePath: string, text: string) => {
                    savedUri = filePath;
                    savedContent = text;
                },
                readTextFile: async () => 'sample text',
            }),
        });

        const mockWebHostEnv = createMock<WebHostEnvironment>({
            documents: createMock<WebHostDocuments>({
                notifyDidSaveDocument: (uri?: Uri) => {
                    didSaveNotifiedUri = uri;
                },
            }),
        });

        const mockScm = createMock<ScmModel>({
            refresh: async (options?: { reason?: string }) => {
                refreshReason = options?.reason;
            },
        });

        const manager = new TabDocumentManager({
            webHostEnv: mockWebHostEnv,
            notificationService: new NotificationService(),
            fsEditService: undefined,
            fsViewService: undefined,
            remoteHostSystem: mockHost,
            resolveScmModelForUri: () => mockScm,
            getCurrentSnapshot: () => undefined,
            getWorkspaceRoot: () => '/repo',
            openFileDiffForChange: async () => {},
            handleAction: async () => {},
        });

        const fileUri = Uri.file('/repo/test.ts');
        manager.openOrActivateTab({
            type: 'file',
            uri: fileUri,
            title: 'test.ts',
            content: 'original',
        });

        const activeTab = manager.activeTab;
        expect(activeTab).toBeDefined();
        if (!activeTab) {
            return;
        }

        activeTab.isDirty = true;
        await manager.handleSaveFile('saved by handleSaveFile');
        expect(savedContent).toBe('saved by handleSaveFile');
        expect(savedUri).toBe('/repo/test.ts');
        expect(activeTab.isDirty).toBe(false);
        expect(didSaveNotifiedUri?.fsPath).toBeSameFsPath('/repo/test.ts');
        expect(refreshReason).toBe('save-file');

        // Test saveUriIfDirty
        if (activeTab.view.type === 'file') {
            activeTab.view.content = 'modified content';
        }
        activeTab.isDirty = true;
        savedContent = undefined;
        savedUri = undefined;
        await manager.saveUriIfDirty(fileUri);
        expect(savedContent).toBe('modified content');
        expect(savedUri).toBe('/repo/test.ts');
        expect(activeTab.isDirty).toBe(false);
    });

    it('saves files via fsEditService for jj-edit scheme', async () => {
        let writtenBytes: Uint8Array | undefined;
        const mockEditFs = createMock<JjEditFsService>({
            writeFile: async (_uri: Uri, bytes: Uint8Array) => {
                writtenBytes = bytes;
            },
        });

        const manager = new TabDocumentManager({
            webHostEnv: undefined,
            notificationService: new NotificationService(),
            fsEditService: mockEditFs,
            fsViewService: undefined,
            remoteHostSystem: undefined,
            resolveScmModelForUri: () => undefined,
            getCurrentSnapshot: () => undefined,
            getWorkspaceRoot: () => '/repo',
            openFileDiffForChange: async () => {},
            handleAction: async () => {},
        });

        const editUri = Uri.parse('jj-edit:/repo/edit.txt');
        manager.openOrActivateTab({
            type: 'file',
            uri: editUri,
            title: 'edit.txt',
            content: 'initial',
        });

        await manager.handleSaveFile('saved in edit service');
        expect(writtenBytes).toBeDefined();
        if (writtenBytes) {
            expect(new TextDecoder().decode(writtenBytes)).toBe('saved in edit service');
        }
    });

    it('discards file changes with handleDiscardFile', async () => {
        let restoredActionPayload: unknown;
        let scmRefreshReason: string | undefined;

        const mockScm = createMock<ScmModel>({
            refresh: async (options?: { reason?: string }) => {
                scmRefreshReason = options?.reason;
            },
        });

        const manager = new TabDocumentManager({
            webHostEnv: undefined,
            notificationService: new NotificationService(),
            fsEditService: undefined,
            fsViewService: undefined,
            remoteHostSystem: undefined,
            resolveScmModelForUri: () => mockScm,
            getCurrentSnapshot: () => undefined,
            getWorkspaceRoot: () => '/repo',
            openFileDiffForChange: async () => {},
            handleAction: async (action: string, payload?: unknown) => {
                if (action === 'jj-view.restore') {
                    restoredActionPayload = payload;
                }
            },
        });

        const fileUri = Uri.file('/repo/discard.ts');
        const stateMock = createMock<JjResourceState>({
            resourceUri: fileUri,
            relativePath: 'discard.ts',
        });

        manager.openOrActivateTab({
            type: 'file',
            uri: fileUri,
            title: 'discard.ts',
            content: 'dirty content',
            resourceState: stateMock,
        });

        const targetTab = manager.activeTab;
        expect(targetTab).toBeDefined();
        if (!targetTab) {
            return;
        }
        targetTab.isDirty = true;
        await manager.handleDiscardFile();

        expect(restoredActionPayload).toBe(stateMock);
        expect(scmRefreshReason).toBe('discard-file');
        expect(manager.tabs.length).toBe(0);
    });
});
