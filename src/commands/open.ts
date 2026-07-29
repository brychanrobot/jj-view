/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { diffArrays } from 'diff';
import * as vscode from 'vscode';
import type { JjResourceState } from '../scm-resource-state';
import { extractFileUri } from './command-utils';

// Exact lines are anchors; unmatched lines retain their relative position inside the intervening hunk.
function mapHunkLine(sourceOffset: number, sourceCount: number, targetStart: number, targetCount: number): number {
    if (targetCount === 0 || sourceCount === 1) {
        return targetStart;
    }
    return targetStart + Math.round((sourceOffset * (targetCount - 1)) / (sourceCount - 1));
}

interface LineMapping {
    lines: Map<number, number>;
    deletedSourceLines: Set<number>;
}

function computeLineMapping(sourceLines: string[], targetLines: string[]): LineMapping {
    const lines = new Map<number, number>();
    const deletedSourceLines = new Set<number>();
    let sourceIndex = 0;
    let targetIndex = 0;
    let hunkSourceStart = 0;
    let hunkTargetStart = 0;
    let hunkSourceCount = 0;
    let hunkTargetCount = 0;

    const flushHunk = () => {
        for (let offset = 0; offset < hunkSourceCount; offset++) {
            const sourceLine = hunkSourceStart + offset;
            lines.set(sourceLine, mapHunkLine(offset, hunkSourceCount, hunkTargetStart, hunkTargetCount));
            if (hunkTargetCount === 0) {
                deletedSourceLines.add(sourceLine);
            }
        }
        hunkSourceCount = 0;
        hunkTargetCount = 0;
    };

    for (const change of diffArrays(sourceLines, targetLines)) {
        if (!change.added && !change.removed) {
            flushHunk();
            for (let offset = 0; offset < change.count; offset++) {
                lines.set(sourceIndex + offset, targetIndex + offset);
            }
            sourceIndex += change.count;
            targetIndex += change.count;
            continue;
        }

        if (hunkSourceCount === 0 && hunkTargetCount === 0) {
            hunkSourceStart = sourceIndex;
            hunkTargetStart = targetIndex;
        }
        if (change.removed) {
            sourceIndex += change.count;
            hunkSourceCount += change.count;
        } else {
            targetIndex += change.count;
            hunkTargetCount += change.count;
        }
    }
    flushHunk();

    return { lines, deletedSourceLines };
}

function getVisibleCenterLine(editor: vscode.TextEditor): number | undefined {
    const ranges = editor.visibleRanges;
    if (!ranges || ranges.length === 0) {
        return undefined;
    }
    return Math.floor((ranges[0].start.line + ranges[0].end.line) / 2);
}

interface OpenSync {
    selections: readonly vscode.Selection[];
    scrollCenterLine?: number;
    sourceContent: string;
}

interface TrackedEditorState {
    document: vscode.TextDocument;
    selections: readonly vscode.Selection[];
    scrollCenterLine?: number;
}

// Editor menu commands can target hidden tabs by URI, but VS Code exposes no TextEditor for their
// selection or viewport. Retain the last visible state until the backing document is closed.
const trackedEditorStates = new Map<string, TrackedEditorState>();

function uriKey(uri: vscode.Uri): string {
    return uri.toString();
}

function captureEditorState(editor: vscode.TextEditor): TrackedEditorState {
    return {
        document: editor.document,
        selections: [...editor.selections],
        scrollCenterLine: getVisibleCenterLine(editor),
    };
}

function rememberEditorState(editor: vscode.TextEditor): void {
    trackedEditorStates.set(uriKey(editor.document.uri), captureEditorState(editor));
}

export function registerOpenSyncTracking(): vscode.Disposable {
    trackedEditorStates.clear();
    for (const editor of vscode.window.visibleTextEditors) {
        rememberEditorState(editor);
    }
    if (vscode.window.activeTextEditor) {
        rememberEditorState(vscode.window.activeTextEditor);
    }

    const disposables = [
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                rememberEditorState(editor);
            }
        }),
        vscode.window.onDidChangeTextEditorSelection((event) => rememberEditorState(event.textEditor)),
        vscode.window.onDidChangeTextEditorVisibleRanges((event) => rememberEditorState(event.textEditor)),
        vscode.workspace.onDidCloseTextDocument((document) => trackedEditorStates.delete(uriKey(document.uri))),
    ];

    return new vscode.Disposable(() => {
        for (const disposable of disposables) {
            disposable.dispose();
        }
        trackedEditorStates.clear();
    });
}

function mapPosition(mapping: LineMapping, position: vscode.Position, targetLines: string[]): vscode.Position {
    const targetLine = mapping.lines.get(position.line) ?? targetLines.length - 1;
    if (mapping.deletedSourceLines.has(position.line)) {
        if (targetLine >= targetLines.length) {
            const lastLine = targetLines.length - 1;
            return new vscode.Position(lastLine, targetLines[lastLine].length);
        }
        return new vscode.Position(targetLine, 0);
    }
    const clampedLine = Math.min(targetLine, Math.max(0, targetLines.length - 1));
    return new vscode.Position(clampedLine, Math.min(position.character, targetLines[clampedLine].length));
}

function mapSelection(mapping: LineMapping, selection: vscode.Selection, targetLines: string[]): vscode.Selection {
    return new vscode.Selection(
        mapPosition(mapping, selection.anchor, targetLines),
        mapPosition(mapping, selection.active, targetLines),
    );
}

function clampPosition(position: vscode.Position, targetLines: string[]): vscode.Position {
    const line = Math.min(position.line, Math.max(0, targetLines.length - 1));
    return new vscode.Position(line, Math.min(position.character, targetLines[line].length));
}

function findLiveEditor(uri: vscode.Uri): vscode.TextEditor | undefined {
    const key = uriKey(uri);
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && uriKey(activeEditor.document.uri) === key) {
        return activeEditor;
    }
    return vscode.window.visibleTextEditors.find((editor) => uriKey(editor.document.uri) === key);
}

function getSourceEditorState(args: unknown[]): TrackedEditorState | undefined {
    const explicitSourceUri = args[0] instanceof vscode.Uri ? args[0] : undefined;
    if (explicitSourceUri) {
        // Prefer current state when the tab is visible; context menus on hidden tabs use the remembered state.
        const liveEditor = findLiveEditor(explicitSourceUri);
        return liveEditor ? captureEditorState(liveEditor) : trackedEditorStates.get(uriKey(explicitSourceUri));
    }

    const activeEditor = vscode.window.activeTextEditor;
    return activeEditor ? captureEditorState(activeEditor) : undefined;
}

function computeOpenSync(args: unknown[], openUri: vscode.Uri): OpenSync | undefined {
    const source = getSourceEditorState(args);
    if (!source || source.document.uri.fsPath !== openUri.fsPath) {
        return undefined;
    }

    return {
        selections: source.selections,
        scrollCenterLine: source.scrollCenterLine,
        sourceContent: source.document.getText(),
    };
}

// Opens the file on disk (working copy version).
// Extracts the file URI from command arguments (or active text editor),
// converts the scheme to 'file', and strips query parameters.
export async function openFileCommand(...args: unknown[]) {
    const resourceUri = extractFileUri(args);
    if (!resourceUri) {
        return;
    }
    const uri = resourceUri.with({ scheme: 'file', query: '' });
    const sync = computeOpenSync(args, uri);
    if (!sync) {
        await vscode.commands.executeCommand('vscode.open', uri);
        return;
    }

    const editor = await vscode.window.showTextDocument(uri);
    const targetContent = editor.document.getText();
    const targetLines = targetContent.split(/\r?\n/);
    const mapping =
        sync.sourceContent === targetContent
            ? undefined
            : computeLineMapping(sync.sourceContent.split(/\r?\n/), targetLines);
    editor.selections = sync.selections.map((selection) => {
        const mappedSelection = mapping === undefined ? selection : mapSelection(mapping, selection, targetLines);
        return new vscode.Selection(
            clampPosition(mappedSelection.anchor, targetLines),
            clampPosition(mappedSelection.active, targetLines),
        );
    });
    if (sync.scrollCenterLine !== undefined) {
        const mappedLine =
            mapping === undefined
                ? sync.scrollCenterLine
                : mapPosition(mapping, new vscode.Position(sync.scrollCenterLine, 0), targetLines).line;
        const pos = clampPosition(new vscode.Position(mappedLine, 0), targetLines);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
}

// Opens the diff view for the given resource state.
// Uses the pre-calculated left and right URIs stored on the JjResourceState.
export async function openChangesCommand(resourceState: JjResourceState | undefined) {
    if (!resourceState?.leftUri || !resourceState?.rightUri) {
        return;
    }
    await vscode.commands.executeCommand(
        'vscode.diff',
        resourceState.leftUri,
        resourceState.rightUri,
        resourceState.diffTitle ?? 'Diff',
    );
}
