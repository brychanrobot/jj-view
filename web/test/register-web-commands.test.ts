/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { HostFs } from '../../src/core/host/host-system';
import type { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import type { JjRepository } from '../../src/core/jj-repository';
import type { JjRepositoryManager } from '../../src/core/jj-repository-manager';
import { JjService, NO_OP_LOGGER } from '../../src/core/jj-service';
import type { ScmModel } from '../../src/core/scm-model';
import { Uri } from '../../src/core/uri-utils';
import { buildGraph, TestRepo } from '../../src/test/test-repo';
import type { LoggerChannel } from '../../src/utils/output-channel';
import { createShowDetailsPayload } from '../src/commands/payloads/details.payload';
import { createRestoreFileFromRevisionPayload } from '../src/commands/payloads/restore-file-from-revision.payload';
import { createSimplifyParentsPayload } from '../src/commands/payloads/simplify-parents.payload';
import { createSquashRevisionIntoParentPayload } from '../src/commands/payloads/squash-revision.payload';
import { createSquashSelectionIntoParentPayload } from '../src/commands/payloads/squash-selection.payload';
import { registerWebCommands } from '../src/commands/register-web-commands';
import { WebHostEnvironment } from '../src/host/web-host-environment';
import { DEFAULT_PACKAGE_JSON_CONTRIBUTES } from '../src/menu/default-menus';
import { createMock } from './test-mock';

describe('registerWebCommands', () => {
    function setupTestEnvironment() {
        const openedCommitDetails: string[] = [];
        const mockRemoteHost = createMock<RemoteHostSystem>({
            fs: createMock<HostFs>({
                readTextFile: vi.fn(),
                writeTextFile: vi.fn(),
            }),
            platform: 'linux',
            checkUpdate: vi.fn(async () => ({
                currentVersion: '3.0.0',
                latestVersion: '3.1.0',
                canSelfUpdate: true,
                updateAvailable: true,
            })),
            applyUpdate: vi.fn(async () => ({
                previousVersion: '3.0.0',
                updatedVersion: '3.1.0',
                binaryPath: '/tmp/jj-view',
                restarting: true,
            })),
        });

        const hostEnvironment = new WebHostEnvironment(mockRemoteHost, '/test/workspace', {
            onOpenCommitDetails: (changeId: string) => {
                openedCommitDetails.push(changeId);
            },
        });

        const refreshCalls: unknown[] = [];
        const commitCalls: string[] = [];
        const abandonCalls: string[][] = [];

        const mockJj = createMock<JjService>({
            workspaceRoot: '/test/workspace',
            getLog: vi.fn(async () => [
                {
                    change_id: 'my-change-id',
                    change_id_shortest: 'myc',
                    commit_id: 'commit123',
                    description: 'test',
                    author: { name: 'A', email: 'a@a.com', timestamp: '' },
                    committer: { name: 'A', email: 'a@a.com', timestamp: '' },
                    parents: [],
                    bookmarks: [],
                },
            ]),
            commit: vi.fn(async (msg: string): Promise<void> => {
                commitCalls.push(msg);
            }),
            abandon: vi.fn(async (revs: string[]) => {
                abandonCalls.push(revs);
                return 'abandoned';
            }),
        });

        const mockRepo = createMock<JjRepository>({
            jj: mockJj,
            rootUri: Uri.file('/test/workspace'),
            refresh: vi.fn(async (options?: unknown) => {
                refreshCalls.push(options);
            }),
        });

        const mockRepoManager = createMock<JjRepositoryManager>({
            repositories: [mockRepo],
            focusedRepository: mockRepo,
        });

        const mockScmModel = createMock<ScmModel>({
            jj: mockJj,
            refresh: vi.fn(async (options?: unknown) => {
                refreshCalls.push(options);
            }),
            snapshot: {
                description: 'current draft message',
                conflictedPaths: [],
                workingCopyChanges: [],
                workingCopyStatuses: new Map(),
                workingCopyLabel: 'Working Copy',
                workingCopyContextValue: 'working-copy',
                ancestors: [],
                parentMutable: false,
                hasChild: false,
                workingCopyCount: 0,
                currentEntry: {
                    change_id: 'qpv1234',
                    commit_id: 'rev123456',
                    description: 'current draft message',
                    author: {
                        name: 'Test Author',
                        email: 'author@example.com',
                        timestamp: '2026-09-25T00:00:00Z',
                    },
                    committer: {
                        name: 'Test Committer',
                        email: 'committer@example.com',
                        timestamp: '2026-09-25T00:00:00Z',
                    },
                    parents: [],
                    bookmarks: [],
                },
            },
        });

        const mockLogger = createMock<LoggerChannel>({
            info: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
        });

        registerWebCommands({
            repositoryManager: mockRepoManager,
            hostEnvironment,
            logger: mockLogger,
            scmModel: mockScmModel,
        });

        return {
            hostEnvironment,
            mockRemoteHost,
            mockRepo,
            mockScmModel,
            mockJj,
            refreshCalls,
            commitCalls,
            abandonCalls,
            openedCommitDetails,
        };
    }

    it('registers essential commands at startup', async () => {
        const { hostEnvironment } = setupTestEnvironment();

        const commands = [
            'jj-view.new',
            'jj-view.commit',
            'jj-view.describe',
            'jj-view.setDescription',
            'jj-view.refresh',
            'jj-view.refreshGraph',
            'jj-view.abandon',
            'jj-view.simplifyParents',
            'jj-view.restore',
            'jj-view.restoreFileFrom',
            'jj-view.absorb',
            'jj-view.squashRevisionIntoParent',
            'jj-view.squashRevisionIntoParentKeepMessage',
            'jj-view.squashRevisionIntoAncestor',
            'jj-view.squashRevisionIntoAncestorKeepMessage',
            'jj-view.showDetails',
            'jj-view.openChanges',
            'jj-view.sync',
            'jj-view.prev',
            'jj-view.next',
            'jj-view.checkForUpdates',
            'jj-view.installUpdate',
        ];

        for (const cmd of commands) {
            expect(hostEnvironment.commands.hasCommand(cmd)).toBe(true);
        }
    });

    it('delegates jj-view.checkForUpdates and jj-view.installUpdate to host system', async () => {
        const { hostEnvironment, mockRemoteHost } = setupTestEnvironment();

        const checkRes = await hostEnvironment.commands.executeCommand('jj-view.checkForUpdates');
        expect(mockRemoteHost.checkUpdate).toHaveBeenCalledWith({ force: true });
        expect(checkRes).toEqual({
            currentVersion: '3.0.0',
            latestVersion: '3.1.0',
            canSelfUpdate: true,
            updateAvailable: true,
        });

        const applyRes = await hostEnvironment.commands.executeCommand('jj-view.installUpdate');
        expect(mockRemoteHost.applyUpdate).toHaveBeenCalled();
        expect(applyRes).toEqual({
            previousVersion: '3.0.0',
            updatedVersion: '3.1.0',
            binaryPath: '/tmp/jj-view',
            restarting: true,
        });
    });

    it('executes jj-view.refresh through commands.executeCommand', async () => {
        const { hostEnvironment, mockRepo } = setupTestEnvironment();

        await hostEnvironment.commands.executeCommand('jj-view.refresh');
        expect(mockRepo.refresh).toHaveBeenCalled();
    });

    it('executes jj-view.commit with passed message', async () => {
        const { hostEnvironment, commitCalls } = setupTestEnvironment();

        await hostEnvironment.commands.executeCommand('jj-view.commit', 'feat: awesome feature');
        expect(commitCalls).toContain('feat: awesome feature');
    });

    it('executes jj-view.commit falling back to draft message when omitted', async () => {
        const { hostEnvironment, commitCalls } = setupTestEnvironment();

        await hostEnvironment.commands.executeCommand('jj-view.commit');
        expect(commitCalls).toContain('current draft message');
    });

    it('executes jj-view.showDetails and triggers onOpenCommitDetails callback', async () => {
        const { hostEnvironment, openedCommitDetails } = setupTestEnvironment();

        await hostEnvironment.commands.executeCommand('jj-view.showDetails', 'my-change-id');
        expect(openedCommitDetails).toContain('my-change-id');
    });

    it('creates showDetails payload without hardcoding @ and resolves custom or cancelled quick-pick input', async () => {
        expect(createShowDetailsPayload([])).toEqual({ revision: undefined });
        expect(createShowDetailsPayload(['abc'])).toEqual({ revision: 'abc' });

        const { hostEnvironment, openedCommitDetails } = setupTestEnvironment();

        // 1. User cancels the QuickInput prompt
        const cancelSessionSeen = new Promise<void>((resolve) => {
            const sub = hostEnvironment.quickInput.onDidChangeSession((session) => {
                if (session?.type === 'quick-pick') {
                    expect(session.options.placeHolder).toBe('Select or enter a revision to view details');
                    expect(session.options.acceptCustomValue).toBe(true);
                    sub.dispose();
                    hostEnvironment.quickInput.cancel();
                    resolve();
                }
            });
        });

        await Promise.all([hostEnvironment.commands.executeCommand('jj-view.showDetails'), cancelSessionSeen]);
        expect(openedCommitDetails).toHaveLength(0);

        // 2. User submits a custom arbitrary revision expression through QuickInputService.acceptCustomValue
        const customSessionSeen = new Promise<void>((resolve) => {
            const sub = hostEnvironment.quickInput.onDidChangeSession((session) => {
                if (session?.type === 'quick-pick') {
                    sub.dispose();
                    hostEnvironment.quickInput.acceptCustomValue('custom-sha-123');
                    resolve();
                }
            });
        });

        await Promise.all([hostEnvironment.commands.executeCommand('jj-view.showDetails'), customSessionSeen]);
        expect(openedCommitDetails).toEqual(['my-change-id']);

        // 3. User picks an existing list item (even when wrapped in a Proxy)
        const existingSessionSeen = new Promise<void>((resolve) => {
            const sub = hostEnvironment.quickInput.onDidChangeSession((session) => {
                if (session?.type === 'quick-pick') {
                    sub.dispose();
                    hostEnvironment.quickInput.accept(new Proxy(session.options.items[0], {}));
                    resolve();
                }
            });
        });

        await Promise.all([hostEnvironment.commands.executeCommand('jj-view.showDetails'), existingSessionSeen]);
        expect(openedCommitDetails).toEqual(['my-change-id', 'my-change-id']);
    });

    it('creates squashSelectionIntoParent payload from arguments or host documents fallback', () => {
        const directPayload = createSquashSelectionIntoParentPayload([
            {
                uri: Uri.file('/test.txt'),
                ranges: [{ startLine: 1, endLine: 3 }],
                revision: '@',
            },
        ]);
        expect(directPayload.uri?.toString()).toBe(Uri.file('/test.txt').toString());
        expect(directPayload.ranges).toEqual([{ startLine: 1, endLine: 3 }]);

        // With empty arguments but active host document and selections
        const { hostEnvironment } = setupTestEnvironment();
        const activeUri = Uri.file('/active.txt');
        hostEnvironment.documents.setDelegate({
            getActiveDocumentUri: () => activeUri,
            getActiveDocumentSelections: () => [{ startLine: 10, endLine: 15 }],
        });

        const fallbackPayload = createSquashSelectionIntoParentPayload([], hostEnvironment);
        expect(fallbackPayload.uri).toBe(activeUri);
        expect(fallbackPayload.ranges).toEqual([{ startLine: 10, endLine: 15 }]);

        // Without arguments and without selections
        const emptyPayload = createSquashSelectionIntoParentPayload([]);
        expect(emptyPayload).toEqual({});
    });

    it('creates simplifyParents payload for single, multi-selected, SCM group, and empty inputs', () => {
        expect(createSimplifyParentsPayload([{ id: 'jj.group.workingCopy', resourceStates: [] }])).toEqual({
            revisions: ['@'],
        });
        expect(createSimplifyParentsPayload([{ changeId: 'rev1' }], ['sel1', 'sel2'])).toEqual({
            revisions: ['rev1'],
        });
        expect(createSimplifyParentsPayload([{ changeId: 'sel1' }], ['sel1', 'sel2'])).toEqual({
            revisions: ['sel1', 'sel2'],
        });
        expect(createSimplifyParentsPayload([], ['sel1', 'sel2'])).toEqual({
            revisions: ['sel1', 'sel2'],
        });
        expect(createSimplifyParentsPayload([], [])).toEqual({
            revisions: [],
        });
    });

    it('executes jj-view.simplifyParents against a real repository using argument or selected commits', async () => {
        const testRepo = new TestRepo();
        let hostEnvironment: WebHostEnvironment | undefined;

        try {
            testRepo.init();
            const realJj = new JjService(testRepo.path, NO_OP_LOGGER);

            const graph = await buildGraph(testRepo, [
                { label: 'C', description: 'C' },
                { label: 'B', parents: ['C'], description: 'B' },
                { label: 'A1', parents: ['B', 'C'], description: 'A1' },
                { label: 'A2', parents: ['B', 'C'], description: 'A2', isCurrentWorkingCopy: true },
            ]);

            const mockRemoteHost = createMock<RemoteHostSystem>({
                fs: createMock<HostFs>({
                    readTextFile: vi.fn(),
                    writeTextFile: vi.fn(),
                }),
                platform: 'linux',
            });
            hostEnvironment = new WebHostEnvironment(mockRemoteHost, testRepo.path);

            let selectedCommitIds: string[] = [];
            const realRepo = createMock<JjRepository>({
                jj: realJj,
                rootUri: Uri.file(testRepo.path),
                refresh: vi.fn(async () => {}),
            });
            const repoManager = createMock<JjRepositoryManager>({
                repositories: [realRepo],
                focusedRepository: realRepo,
            });
            const scmModel = createMock<ScmModel>({
                jj: realJj,
                getSelectedCommitIds: () => selectedCommitIds,
                refresh: vi.fn(async () => {}),
            });
            const logger = createMock<LoggerChannel>({
                info: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
                warn: vi.fn(),
            });

            registerWebCommands({
                repositoryManager: repoManager,
                hostEnvironment,
                logger,
                scmModel,
            });

            await hostEnvironment.commands.executeCommand('jj-view.simplifyParents', { changeId: graph.A1.changeId });
            const logsA1 = await realJj.getLog({ revision: graph.A1.changeId, omitChanges: true });
            expect(logsA1[0].parents.map((p) => p.change_id)).toEqual([graph.B.changeId]);

            const graph2 = await buildGraph(testRepo, [
                { label: 'C2', description: 'C2' },
                { label: 'B2', parents: ['C2'], description: 'B2' },
                { label: 'M1', parents: ['B2', 'C2'], description: 'M1' },
                { label: 'M2', parents: ['B2', 'C2'], description: 'M2' },
            ]);
            selectedCommitIds = [graph2.M1.changeId, graph2.M2.changeId];
            await hostEnvironment.commands.executeCommand('jj-view.simplifyParents', { changeId: graph2.M1.changeId });
            const logsM1 = await realJj.getLog({ revision: graph2.M1.changeId, omitChanges: true });
            const logsM2 = await realJj.getLog({ revision: graph2.M2.changeId, omitChanges: true });
            expect(logsM1[0].parents.map((p) => p.change_id)).toEqual([graph2.B2.changeId]);
            expect(logsM2[0].parents.map((p) => p.change_id)).toEqual([graph2.B2.changeId]);
        } finally {
            hostEnvironment?.notifications.clearAll();
            hostEnvironment?.dispose();
            await testRepo.dispose();
        }
    });

    it('executes squash keep-message commands with real JjService via web command registry', async () => {
        const testRepo = new TestRepo();
        testRepo.init();
        const jj = new JjService(testRepo.path, NO_OP_LOGGER);

        const ids = await buildGraph(testRepo, [
            { label: 'base', description: 'Base', files: { 'base.txt': 'base' } },
            { label: 'grandparent', parents: ['base'], description: 'Grandparent Desc', files: { 'gp.txt': 'gp' } },
            { label: 'parent', parents: ['grandparent'], description: 'Parent Desc', files: { 'p.txt': 'p' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'Child Desc',
                files: { 'c.txt': 'c' },
                isCurrentWorkingCopy: true,
            },
        ]);
        testRepo.config('revset-aliases."immutable_heads()"', `commit_id("${ids.base.commitId}")`);

        const mockRemoteHost = createMock<RemoteHostSystem>({
            fs: createMock<HostFs>({
                readTextFile: vi.fn(),
                writeTextFile: vi.fn(),
            }),
            platform: 'linux',
        });
        const hostEnvironment = new WebHostEnvironment(mockRemoteHost, testRepo.path);
        const mockRepo = createMock<JjRepository>({
            jj,
            rootUri: Uri.file(testRepo.path),
            refresh: vi.fn(async () => {}),
        });
        const mockRepoManager = createMock<JjRepositoryManager>({
            repositories: [mockRepo],
            focusedRepository: mockRepo,
        });
        const mockScmModel = createMock<ScmModel>({
            jj,
            refresh: vi.fn(async () => {}),
        });
        const mockLogger = createMock<LoggerChannel>({
            info: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
        });

        registerWebCommands({
            repositoryManager: mockRepoManager,
            hostEnvironment,
            logger: mockLogger,
            scmModel: mockScmModel,
        });

        await hostEnvironment.commands.executeCommand('jj-view.squashRevisionIntoParentKeepMessage', {
            changeId: ids.child.changeId,
        });
        expect(testRepo.getDescription(ids.parent.changeId)).toBe('Parent Desc');
        expect(testRepo.getFileContent(ids.parent.changeId, 'c.txt')).toBe('c');

        await hostEnvironment.commands.executeCommand('jj-view.squashRevisionIntoAncestorKeepMessage', {
            changeId: ids.parent.changeId,
            ancestorRevision: ids.grandparent.changeId,
        });
        expect(testRepo.getDescription(ids.grandparent.changeId)).toBe('Grandparent Desc');
        expect(testRepo.getFileContent(ids.grandparent.changeId, 'c.txt')).toBe('c');
    });

    it('extracts targetParent and empty ancestor group revision in web squash payload creators', () => {
        expect(createSquashRevisionIntoParentPayload([{ revision: 'rev1', targetParent: 'p2' }])).toEqual({
            revision: 'rev1',
            targetParent: 'p2',
        });

        const scmWithAncestor = createMock<ScmModel>({
            snapshot: createMock<NonNullable<ScmModel['snapshot']>>({
                ancestors: [
                    {
                        entry: {
                            change_id: 'ancestor-change',
                            commit_id: 'ancestor-commit',
                            description: 'Ancestor',
                            author: { name: 'A', email: 'a@a.com', timestamp: '' },
                            committer: { name: 'A', email: 'a@a.com', timestamp: '' },
                            parents: [],
                            bookmarks: [],
                        },
                        prefix: 'Parent',
                        isMutable: true,
                        canSquash: true,
                        changes: [],
                        label: 'Parent: ancestor',
                        contextValue: 'jj.group.allowSquash',
                    },
                ],
            }),
        });
        const emptyAncestorGroup = { id: 'ancestor-0', label: 'Parent', resourceStates: [] };
        expect(createSquashRevisionIntoParentPayload([emptyAncestorGroup], undefined, scmWithAncestor)).toEqual({
            revision: 'ancestor-change',
            targetParent: undefined,
        });
    });

    it('creates restoreFileFrom payload from arguments or active host document fallback', () => {
        const uri = Uri.file('/test/workspace/file.txt');
        const payload = createRestoreFileFromRevisionPayload([{ resourceUri: uri, revision: 'main' }]);
        expect(payload.fileUri?.toString()).toBe(uri.toString());
        expect(payload.revision).toBe('main');

        const uriOnlyPayload = createRestoreFileFromRevisionPayload([uri]);
        expect(uriOnlyPayload.fileUri?.toString()).toBe(uri.toString());
        expect(uriOnlyPayload.revision).toBeUndefined();

        const { hostEnvironment } = setupTestEnvironment();
        const activeUri = Uri.file('/test/workspace/active.txt');
        hostEnvironment.documents.setDelegate({
            getActiveDocumentUri: () => activeUri,
        });
        const fallbackPayload = createRestoreFileFromRevisionPayload([], hostEnvironment);
        expect(fallbackPayload.fileUri).toBe(activeUri);
        expect(fallbackPayload.revision).toBeUndefined();

        const overridePayload = createRestoreFileFromRevisionPayload([{ resourceUri: uri }], hostEnvironment);
        expect(overridePayload.fileUri?.toString()).toBe(uri.toString());

        const emptyPayload = createRestoreFileFromRevisionPayload([]);
        expect(emptyPayload).toEqual({ fileUri: undefined, revision: undefined });
    });

    describe('jj-view.pickChange web command and menu parity', () => {
        async function withRealRepoEnv(
            fn: (env: {
                repo: TestRepo;
                hostEnvironment: WebHostEnvironment;
                repoRefreshSpy: ReturnType<typeof vi.fn<() => Promise<void>>>;
            }) => Promise<void>,
        ) {
            const repo = new TestRepo();
            let hostEnvironment: WebHostEnvironment | undefined;
            try {
                repo.init();
                const jj = new JjService(repo.path, NO_OP_LOGGER);

                const mockRemoteHost = createMock<RemoteHostSystem>({
                    fs: createMock<HostFs>({
                        readTextFile: vi.fn(),
                        writeTextFile: vi.fn(),
                    }),
                    platform: 'linux',
                });
                hostEnvironment = new WebHostEnvironment(mockRemoteHost, repo.path);
                const repoRefreshSpy = vi.fn(async () => {});
                const mockRepo = createMock<JjRepository>({
                    jj,
                    rootUri: Uri.file(repo.path),
                    refresh: repoRefreshSpy,
                });

                const mockLogger = createMock<LoggerChannel>({
                    info: vi.fn(),
                    error: vi.fn(),
                    debug: vi.fn(),
                    warn: vi.fn(),
                });

                const mockRepoManager = createMock<JjRepositoryManager>({
                    repositories: [mockRepo],
                    focusedRepository: mockRepo,
                    outputChannel: mockLogger,
                });
                const mockScmModel = createMock<ScmModel>({
                    jj,
                    repo: mockRepo,
                    getSelectedCommitIds: () => [],
                });

                registerWebCommands({
                    repositoryManager: mockRepoManager,
                    hostEnvironment,
                    logger: mockLogger,
                    scmModel: mockScmModel,
                });

                await fn({ repo, hostEnvironment, repoRefreshSpy });
            } finally {
                hostEnvironment?.notifications.clearAll();
                hostEnvironment?.dispose();
                await repo.dispose();
            }
        }

        it('registers jj-view.pickChange and marks it hidden in commandPalette', () => {
            const { hostEnvironment } = setupTestEnvironment();

            expect(hostEnvironment.commands.hasCommand('jj-view.pickChange')).toBe(true);
            const commandDef = DEFAULT_PACKAGE_JSON_CONTRIBUTES.commands?.find(
                (cmd) => cmd.command === 'jj-view.pickChange',
            );
            expect(commandDef).toEqual({
                command: 'jj-view.pickChange',
                title: 'Pick Change',
                category: 'JJ View',
            });
            const paletteRule = DEFAULT_PACKAGE_JSON_CONTRIBUTES.menus?.commandPalette?.find(
                (rule) => rule.command === 'jj-view.pickChange',
            );
            expect(paletteRule).toEqual({
                command: 'jj-view.pickChange',
                when: 'false',
            });
        });

        it('lists matching changes, returns selected ID, and skips repo.refresh', async () => {
            await withRealRepoEnv(async ({ repo, hostEnvironment, repoRefreshSpy }) => {
                repo.new(undefined, 'other');

                const quickPickSpy = vi
                    .spyOn(hostEnvironment.ui, 'showQuickPick')
                    .mockImplementation(async (items) => items[0]);

                const result = await hostEnvironment.commands.executeCommand<string | undefined>('jj-view.pickChange', {
                    revset: 'root()',
                });

                expect(quickPickSpy).toHaveBeenCalledTimes(1);
                const passedItems = quickPickSpy.mock.calls[0][0];
                expect(passedItems).toHaveLength(1);
                expect(result).toBe(String(passedItems[0].value));
                expect(repoRefreshSpy).not.toHaveBeenCalled();
            });
        });

        it('returns undefined when prompt is cancelled', async () => {
            await withRealRepoEnv(async ({ repo, hostEnvironment, repoRefreshSpy }) => {
                repo.new(undefined, 'candidate');

                vi.spyOn(hostEnvironment.ui, 'showQuickPick').mockResolvedValue(undefined);

                const result = await hostEnvironment.commands.executeCommand<string | undefined>('jj-view.pickChange');

                expect(result).toBeUndefined();
                expect(repoRefreshSpy).not.toHaveBeenCalled();
            });
        });

        it('trims custom revision accepted through hostEnvironment.quickInput', async () => {
            await withRealRepoEnv(async ({ repo, hostEnvironment }) => {
                repo.new(undefined, 'candidate');

                const commandPromise = hostEnvironment.commands.executeCommand<string | undefined>(
                    'jj-view.pickChange',
                );
                await vi.waitFor(() => {
                    expect(hostEnvironment.quickInput.activeSession?.type).toBe('quick-pick');
                });
                hostEnvironment.quickInput.acceptCustomValue('  @-  ');

                expect(await commandPromise).toBe('@-');
            });
        });
    });
});
