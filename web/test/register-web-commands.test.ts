/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { HostFs } from '../../src/core/host/host-system';
import type { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import type { JjRepository } from '../../src/core/jj-repository';
import type { JjRepositoryManager } from '../../src/core/jj-repository-manager';
import type { JjService } from '../../src/core/jj-service';
import type { ScmModel } from '../../src/core/scm-model';
import { Uri } from '../../src/core/uri-utils';
import type { LoggerChannel } from '../../src/utils/output-channel';
import { registerWebCommands } from '../src/commands/register-web-commands';
import { WebHostEnvironment } from '../src/host/web-host-environment';
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
            'jj-view.restore',
            'jj-view.absorb',
            'jj-view.showDetails',
            'jj-view.openChanges',
        ];

        for (const cmd of commands) {
            expect(hostEnvironment.commands.hasCommand(cmd)).toBe(true);
        }
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
});
