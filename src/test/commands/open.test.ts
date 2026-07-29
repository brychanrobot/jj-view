/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { openChangesCommand, openFileCommand, registerOpenSyncTracking } from '../../commands/open';
import type { JjResourceState } from '../../scm-resource-state';
import { createMock } from '../test-utils';
import { fireDidChangeActiveTextEditor, setActiveTextEditor } from '../vscode-mock';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        TextEditorRevealType: {
            Default: 0,
            InCenter: 1,
            InCenterIfOutsideViewport: 2,
            AtTop: 3,
        },
    });
});

function setActiveEditor(
    uri: vscode.Uri,
    text: string,
    selection: vscode.Selection,
    visibleRanges: vscode.Range[] = [],
    selections: readonly vscode.Selection[] = [selection],
): vscode.TextEditor {
    const editor = createMock<vscode.TextEditor>({
        document: createMock<vscode.TextDocument>({
            uri,
            getText: vi.fn().mockReturnValue(text),
        }),
        selection,
        selections,
        visibleRanges,
        revealRange: vi.fn(),
    });
    vscode.window.activeTextEditor = editor;
    return editor;
}

function setOpenTarget(uri: vscode.Uri, text: string): vscode.TextEditor {
    const editor = createMock<vscode.TextEditor>({
        document: createMock<vscode.TextDocument>({
            uri,
            getText: vi.fn().mockReturnValue(text),
        }),
        selections: [],
        revealRange: vi.fn(),
    });
    (vscode.window.showTextDocument as ReturnType<typeof vi.fn>).mockResolvedValue(editor);
    return editor;
}

describe('openFileCommand', () => {
    afterEach(() => {
        vi.clearAllMocks();
        setActiveTextEditor(undefined);
        vscode.window.visibleTextEditors = [];
    });

    test('does nothing if no args and no active text editor', async () => {
        await openFileCommand();
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('executes vscode.open from SourceControlResourceState', async () => {
        const resourceState = createMock<vscode.SourceControlResourceState>({
            resourceUri: vscode.Uri.file('/foo').with({ query: 'jj-revision=rev123' }),
        });

        await openFileCommand(resourceState);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/foo',
                query: '',
            }),
        );
    });

    test('opens on-disk file even when the resource state has a revision-backed uri', async () => {
        const rightUri = vscode.Uri.file('/foo').with({
            scheme: 'jj-edit',
            query: 'revision=rev123',
        });
        const resourceUri = vscode.Uri.file('/foo').with({ query: 'jj-revision=rev123' });
        const resourceState = createMock<JjResourceState>({
            resourceUri,
            rightUri,
            revision: 'rev123',
        });

        await openFileCommand(resourceState);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/foo',
                query: '',
            }),
        );
    });

    test('syncs all cursors and scroll position to the opened target editor', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({
            scheme: 'jj-edit',
            query: 'revision=rev123',
        });
        const resourceUri = vscode.Uri.file('/foo').with({ query: 'jj-revision=rev123' });
        const primary = new vscode.Selection(new vscode.Position(7, 3), new vscode.Position(7, 3));
        const secondary = new vscode.Selection(new vscode.Position(4, 6), new vscode.Position(3, 2));
        const content = Array.from({ length: 10 }, (_, line) => `line-${line}`).join('\n');
        setActiveEditor(revisionUri, content, primary, [new vscode.Range(6, 0, 9, 0)], [primary, secondary]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), content);
        const resourceState = createMock<JjResourceState>({
            resourceUri,
            rightUri: revisionUri,
            revision: 'rev123',
        });

        await openFileCommand(resourceState);

        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({ scheme: 'file', path: '/foo', query: '' }),
        );
        expect(targetEditor.selections).toEqual([primary, secondary]);
        expect(targetEditor.revealRange).toHaveBeenCalledWith(
            expect.objectContaining({ start: expect.objectContaining({ line: 7, character: 0 }) }),
            vscode.TextEditorRevealType.InCenter,
        );
    });

    test('maps cursor and viewport through inserted lines using unchanged anchors', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({
            scheme: 'jj-edit',
            query: 'revision=revB',
        });
        const selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 0));
        setActiveEditor(revisionUri, 'line1\nline2\nline5', selection, [new vscode.Range(2, 0, 2, 0)]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'line1\nline2\ninserted\nline3\nline4\nline5');
        const resourceState = createMock<JjResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
            revision: '@',
        });

        await openFileCommand(resourceState);

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(5, 0), new vscode.Position(5, 0)),
        ]);
        expect(targetEditor.revealRange).toHaveBeenCalledWith(
            expect.objectContaining({ start: expect.objectContaining({ line: 5, character: 0 }) }),
            vscode.TextEditorRevealType.InCenter,
        );
    });

    test('remaps from the left side of a working-copy diff', async () => {
        const diffUri = vscode.Uri.parse('jj-view:///foo?base=%40&side=left');
        const selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 0));
        setActiveEditor(diffUri, 'line1\nline2\nline5', selection, [new vscode.Range(2, 0, 2, 0)]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'line1\nline2\ninserted\nline3\nline4\nline5');

        await openFileCommand(diffUri);

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(5, 0), new vscode.Position(5, 0)),
        ]);
        expect(targetEditor.revealRange).toHaveBeenCalledWith(
            expect.objectContaining({ start: expect.objectContaining({ line: 5, character: 0 }) }),
            vscode.TextEditorRevealType.InCenter,
        );
    });

    test('remaps stale content from the right side of a working-copy diff', async () => {
        const diffUri = vscode.Uri.parse('jj-view:///foo?base=%40&side=right');
        const selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 0));
        setActiveEditor(diffUri, 'line1\nline2\nline5', selection, [new vscode.Range(2, 0, 2, 0)]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'line1\nline2\ninserted\nline3\nline4\nline5');

        await openFileCommand(diffUri);

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(5, 0), new vscode.Position(5, 0)),
        ]);
        expect(targetEditor.revealRange).toHaveBeenCalledWith(
            expect.objectContaining({ start: expect.objectContaining({ line: 5, character: 0 }) }),
            vscode.TextEditorRevealType.InCenter,
        );
    });

    test('maps replacement lines proportionally between unchanged anchors', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({
            scheme: 'jj-edit',
            query: 'revision=revB',
        });
        const selection = new vscode.Selection(new vscode.Position(1, 2), new vscode.Position(3, 2));
        setActiveEditor(revisionUri, 'before\nold1\nold2\nold3\nafter', selection, [new vscode.Range(1, 0, 3, 0)]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'before\nnew1\nnew2\nafter');
        const resourceState = createMock<JjResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
            revision: '@',
        });

        await openFileCommand(resourceState);

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(1, 2), new vscode.Position(2, 2)),
        ]);
        expect(targetEditor.revealRange).toHaveBeenCalledWith(
            expect.objectContaining({ start: expect.objectContaining({ line: 2, character: 0 }) }),
            vscode.TextEditorRevealType.InCenter,
        );
    });

    test('maps deleted lines to the deletion boundary', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({ scheme: 'jj-edit', query: 'revision=revB' });
        const selection = new vscode.Selection(new vscode.Position(2, 2), new vscode.Position(2, 2));
        setActiveEditor(revisionUri, 'before\nremoved1\nremoved2\nafter', selection);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'before\nafter');

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo'), revision: '@' }));

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0)),
        ]);
    });

    test('shrinks selections with one endpoint in a deletion without collapsing them', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({ scheme: 'jj-edit', query: 'revision=revB' });
        const deletedActive = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(3, 5));
        const deletedAnchor = new vscode.Selection(new vscode.Position(3, 4), new vscode.Position(4, 2));
        setActiveEditor(
            revisionUri,
            'before\nkept\nremoved1\nremoved2\nafter',
            deletedActive,
            [],
            [deletedActive, deletedAnchor],
        );
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'before\nkept\nafter');

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo'), revision: '@' }));

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(2, 0)),
            new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 2)),
        ]);
    });

    test('clamps a trailing deletion to the final target line', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({ scheme: 'jj-edit', query: 'revision=revB' });
        const selection = new vscode.Selection(new vscode.Position(2, 2), new vscode.Position(2, 2));
        setActiveEditor(revisionUri, 'before\nremoved1\nremoved2', selection);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'before');

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo'), revision: '@' }));

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(0, 6), new vscode.Position(0, 6)),
        ]);
    });

    test('maps against the live target editor content', async () => {
        const revisionUri = vscode.Uri.file('/foo').with({ scheme: 'jj-edit', query: 'revision=revB' });
        const selection = new vscode.Selection(new vscode.Position(5, 100), new vscode.Position(3, 100));
        setActiveEditor(revisionUri, 'line1\nline2\nline3\nline4\nline5\nline6', selection, [
            new vscode.Range(4, 0, 5, 0),
        ]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'short\nlast');

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo'), revision: '@' }));

        expect(targetEditor.selections).toEqual([
            new vscode.Selection(new vscode.Position(1, 4), new vscode.Position(1, 4)),
        ]);
        expect(targetEditor.revealRange).toHaveBeenCalledWith(
            expect.objectContaining({ start: expect.objectContaining({ line: 1, character: 0 }) }),
            vscode.TextEditorRevealType.InCenter,
        );
    });

    test('skips remapping when the active editor already shows the target revision', async () => {
        const selection = new vscode.Selection(new vscode.Position(1, 2), new vscode.Position(1, 2));
        setActiveEditor(vscode.Uri.file('/foo'), 'one\ntwo', selection);
        const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'one\ntwo');

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo'), revision: '@' }));

        expect(targetEditor.selections).toEqual([selection]);
    });

    test('opens normally without synchronization when the active editor is another file', async () => {
        const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
        setActiveEditor(vscode.Uri.file('/other'), 'line1\nline2', selection);

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo'), revision: '@' }));

        expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({ scheme: 'file', path: '/foo', query: '' }),
        );
    });

    test('does not sync files whose paths differ only by case', async () => {
        const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
        setActiveEditor(vscode.Uri.file('/Foo.ts'), 'line1\nline2', selection);

        await openFileCommand(createMock<JjResourceState>({ resourceUri: vscode.Uri.file('/foo.ts'), revision: '@' }));

        expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({ scheme: 'file', path: '/foo.ts', query: '' }),
        );
    });

    test('syncs from a previously active tab when the menu supplies its uri', async () => {
        const revisionUri = vscode.Uri.parse('jj-view:///foo?revision=revB');
        const selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 0));
        setActiveTextEditor(undefined);
        const tracking = registerOpenSyncTracking();

        try {
            const revisionEditor = setActiveEditor(revisionUri, 'line1\nline2\nline5', selection, [
                new vscode.Range(2, 0, 2, 0),
            ]);
            fireDidChangeActiveTextEditor(revisionEditor);
            const otherSelection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
            setActiveEditor(vscode.Uri.file('/other'), 'other', otherSelection);
            const targetEditor = setOpenTarget(vscode.Uri.file('/foo'), 'line1\nline2\ninserted\nline3\nline4\nline5');

            await openFileCommand(revisionUri);

            expect(targetEditor.selections).toEqual([
                new vscode.Selection(new vscode.Position(5, 0), new vscode.Position(5, 0)),
            ]);
            expect(targetEditor.revealRange).toHaveBeenCalledWith(
                expect.objectContaining({ start: expect.objectContaining({ line: 5, character: 0 }) }),
                vscode.TextEditorRevealType.InCenter,
            );
        } finally {
            tracking.dispose();
        }
    });

    test('no active editor: opens without selection', async () => {
        const resourceState = createMock<JjResourceState>({
            resourceUri: vscode.Uri.parse('file:///foo?jj-revision=@'),
            rightUri: vscode.Uri.file('/foo').with({
                scheme: 'jj-edit',
                query: 'revision=rev123',
            }),
            revision: 'rev123',
        });

        await openFileCommand(resourceState);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/foo',
                query: '',
            }),
        );
    });

    test('executes vscode.open from a historical URI (jj-view scheme)', async () => {
        const uri = vscode.Uri.parse('jj-view:///foo/bar.txt?base=c123&side=left');

        await openFileCommand(uri);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/foo/bar.txt',
                query: '',
            }),
        );
    });

    test('syncs from activeTextEditor fallback when args are empty', async () => {
        const revisionUri = vscode.Uri.parse('jj-edit:///baz/qux.ts?revision=rev123');
        const selection = new vscode.Selection(new vscode.Position(1, 2), new vscode.Position(1, 2));
        setActiveEditor(revisionUri, 'first\nsecond', selection, [new vscode.Range(0, 0, 1, 0)]);
        const targetEditor = setOpenTarget(vscode.Uri.file('/baz/qux.ts'), 'first\nsecond');

        await openFileCommand();

        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                scheme: 'file',
                path: '/baz/qux.ts',
                query: '',
            }),
        );
        expect(targetEditor.selections).toEqual([selection]);
        expect(targetEditor.revealRange).toHaveBeenCalledWith(
            expect.objectContaining({ start: expect.objectContaining({ line: 0, character: 0 }) }),
            vscode.TextEditorRevealType.InCenter,
        );
    });
});

describe('openChangesCommand', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    test('does nothing if no resource state', async () => {
        await openChangesCommand(undefined);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('does nothing if resource state has no leftUri or rightUri', async () => {
        const resourceState = createMock<JjResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
            revision: '@',
        });

        await openChangesCommand(resourceState);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('executes the diffCommand with its URIs and title', async () => {
        const leftUri = vscode.Uri.file('/left');
        const rightUri = vscode.Uri.file('/right');
        const resourceState = createMock<JjResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
            revision: '@',
            leftUri,
            rightUri,
            diffTitle: 'foo.txt (Working Copy)',
        });

        await openChangesCommand(resourceState);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.diff',
            leftUri,
            rightUri,
            'foo.txt (Working Copy)',
        );
    });
});
