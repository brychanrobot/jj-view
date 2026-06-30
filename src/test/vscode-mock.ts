/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { vi } from 'vitest';

/**
 * Helper to parse a URI string into components for MockUri.
 * Example inputs:
 * - "jj-edit:///foo/bar.txt?revision=@" -> scheme="jj-edit", path="/foo/bar.txt", query="revision=@"
 * - "jj-edit://foo/bar.txt?revision=@" -> scheme="jj-edit", path="foo/bar.txt", query="revision=@"
 * - "/foo/bar.txt" -> scheme="file", path="/foo/bar.txt", query=""
 * - "file:///foo/bar.txt#frag" -> scheme="file", path="/foo/bar.txt", query=""
 */
function parseUriString(uriString: string): { scheme: string; path: string; query: string } {
    let scheme = 'file';
    let rest = uriString;

    const schemeMatch = uriString.match(/^([a-zA-Z0-9.+-]+):\/\/(.*)$/);
    if (schemeMatch) {
        scheme = schemeMatch[1];
        rest = schemeMatch[2];
    }

    // Strip fragment
    const hashIndex = rest.indexOf('#');
    if (hashIndex !== -1) {
        rest = rest.substring(0, hashIndex);
    }

    // Parse query
    const queryIndex = rest.indexOf('?');
    let query = '';
    let pathPart = rest;
    if (queryIndex !== -1) {
        pathPart = rest.substring(0, queryIndex);
        query = rest.substring(queryIndex + 1);
    }

    let decodedPath = pathPart;
    try {
        decodedPath = decodeURIComponent(pathPart);
    } catch {
        // Fallback
    }

    return { scheme, path: decodedPath, query };
}

/**
 * Creates a base vscode mock with common properties. Override any property
 * by passing a partial object — properties are shallow-merged per namespace.
 *
 * Usage:
 *   vi.mock('vscode', () => createVscodeMock());
 *   vi.mock('vscode', () => createVscodeMock({ window: { showQuickPick: vi.fn() } }));
 */
export function createVscodeMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    class Position {
        constructor(
            public line: number,
            public character: number,
        ) {}
    }

    class Range {
        public start: Position;
        public end: Position;
        constructor(startLine: number, startColumn: number, endLine: number, endColumn: number);
        constructor(start: Position, end: Position);
        constructor(arg1: number | Position, arg2: number | Position, arg3?: number, arg4?: number) {
            if (typeof arg1 === 'number') {
                this.start = new Position(arg1, arg2 as number);
                this.end = new Position(arg3 as number, arg4 as number);
            } else {
                this.start = arg1;
                this.end = arg2 as Position;
            }
        }
    }

    class Selection extends Range {
        public anchor: Position;
        public active: Position;
        constructor(anchorLine: number, anchorColumn: number, activeLine: number, activeColumn: number);
        constructor(anchor: Position, active: Position);
        constructor(arg1: number | Position, arg2: number | Position, arg3?: number, arg4?: number) {
            if (typeof arg1 === 'number') {
                super(arg1, arg2 as number, arg3 as number, arg4 as number);
                this.anchor = this.start;
                this.active = this.end;
            } else {
                super(arg1, arg2 as Position);
                this.anchor = this.start;
                this.active = this.end;
            }
        }
    }

    class Disposable {
        static from = vi.fn();
        constructor(private callOnDispose: () => void) {}
        dispose() {
            this.callOnDispose?.();
        }
    }

    class EventEmitter<T> {
        private listeners: ((data: T) => void)[] = [];
        event = (listener: (data: T) => void) => {
            this.listeners.push(listener);
            return {
                dispose: () => {
                    this.listeners = this.listeners.filter((l) => l !== listener);
                },
            };
        };
        fire = (data: T) => {
            this.listeners.forEach((l) => {
                l(data);
            });
        };
        dispose = vi.fn();
    }

    const onDidChangeTabsEmitter = new EventEmitter<unknown>();
    const onDidChangeTabGroupsEmitter = new EventEmitter<unknown>();
    const onDidChangeWindowStateEmitter = new EventEmitter<unknown>();
    const onDidChangeConfigurationEmitter = new EventEmitter<unknown>();
    const onDidSaveTextDocumentEmitter = new EventEmitter<unknown>();
    const onDidChangeWorkspaceFoldersEmitter = new EventEmitter<unknown>();

    class FileSystemError extends Error {
        readonly code: string;
        constructor(messageOrUri?: string | object, code: string = 'Unknown') {
            const msg = messageOrUri && typeof messageOrUri !== 'string' ? String(messageOrUri) : messageOrUri || '';
            super(msg);
            this.code = code;
            this.name = 'FileSystemError';
        }
        static Unavailable(message?: string | object) {
            return new FileSystemError(message, 'Unavailable');
        }
        static FileNotFound(message?: string | object) {
            return new FileSystemError(message, 'FileNotFound');
        }
        static NoPermissions(message?: string | object) {
            return new FileSystemError(message, 'NoPermissions');
        }
        static FileExists(message?: string | object) {
            return new FileSystemError(message, 'FileExists');
        }
        static FileNotADirectory(message?: string | object) {
            return new FileSystemError(message, 'FileNotADirectory');
        }
        static FileIsADirectory(message?: string | object) {
            return new FileSystemError(message, 'FileIsADirectory');
        }
    }

    class MockUri {
        constructor(
            public fsPath: string,
            public scheme: string = 'file',
            public query: string = '',
            public path: string = fsPath,
        ) {
            if (process.platform === 'win32') {
                this.fsPath = this.fsPath.replace(/\//g, '\\');
                // Strip leading backslash if it precedes a drive letter (e.g., \C:\... -> C:\...)
                if (/^\\[a-zA-Z]:\\/.test(this.fsPath)) {
                    this.fsPath = this.fsPath.substring(1);
                }
                if (/^[a-zA-Z]:\\/.test(this.fsPath)) {
                    this.fsPath = this.fsPath[0].toLowerCase() + this.fsPath.substring(1);
                }
                // For VS Code URIs on Windows, path should always use forward slashes.
                // If it has a drive letter, it starts with a slash (e.g. /c:/...).
                let normalizedPath = this.fsPath.replace(/\\/g, '/');
                if (/^[a-zA-Z]:\//.test(normalizedPath)) {
                    normalizedPath = `/${normalizedPath}`;
                }
                this.path = normalizedPath;
            }
        }
        static file(fsPath: string) {
            return new MockUri(fsPath);
        }
        static from(components: { scheme: string; path: string; query?: string }) {
            return new MockUri(components.path, components.scheme, components.query || '', components.path);
        }
        static parse(uriString: string) {
            const parsed = parseUriString(uriString);
            return new MockUri(parsed.path, parsed.scheme, parsed.query, parsed.path);
        }
        static joinPath(base: { path: string; scheme: string }, ...paths: string[]) {
            const combined = [base.path, ...paths].join('/').replace(/\/+/g, '/');
            return new MockUri(combined, base.scheme, '', combined);
        }
        toString() {
            return `${this.scheme}://${this.fsPath}${this.query ? `?${this.query}` : ''}`;
        }
        with(change: { scheme?: string; query?: string }) {
            return new MockUri(this.fsPath, change.scheme ?? this.scheme, change.query ?? this.query, this.path);
        }
    }

    enum CommentThreadCollapsibleState {
        Collapsed = 0,
        Expanded = 1,
    }

    enum CommentThreadState {
        Unresolved = 0,
        Resolved = 1,
    }

    enum CommentMode {
        Preview = 0,
        Editing = 1,
    }

    class MockCommentThread {
        canReply = true;
        collapsibleState = CommentThreadCollapsibleState.Expanded;
        comments: readonly unknown[] = [];
        contextValue?: string;
        constructor(
            public readonly uri: unknown,
            public readonly range: unknown,
            comments: readonly unknown[],
        ) {
            this.comments = comments;
        }
        dispose = vi.fn();
    }

    class MarkdownString {
        constructor(public value: string = '') {}
        appendMarkdown(value: string): MarkdownString {
            this.value += value;
            return this;
        }
        appendCodeblock(value: string, language?: string): MarkdownString {
            this.value += `\n\`\`\`${language || ''}\n${value}\n\`\`\`\n`;
            return this;
        }
    }

    class MockCommentController {
        commentingRangeProvider?: unknown;
        constructor(
            public readonly id: string,
            public readonly label: string,
        ) {}
        createCommentThread = vi
            .fn()
            .mockImplementation((uri: unknown, range: unknown, comments: readonly unknown[]) => {
                return new MockCommentThread(uri, range, comments);
            });
        dispose = vi.fn();
    }

    let mockWorkspaceFolders: { uri: MockUri; name: string; index: number }[] = [
        {
            uri: new MockUri('/root'),
            name: 'mock-folder',
            index: 0,
        },
    ];

    const base: Record<string, unknown> = {
        ProgressLocation: { Notification: 15 },
        Position,
        Range,
        Selection,
        Disposable,
        EventEmitter,
        CommentThreadCollapsibleState,
        CommentThreadState,
        CommentMode,
        MarkdownString,
        comments: {
            createCommentController: vi.fn().mockImplementation((id: string, label: string) => {
                return new MockCommentController(id, label);
            }),
        },
        FileChangeType: {
            Changed: 1,
            Created: 2,
            Deleted: 3,
        },
        FileType: {
            Unknown: 0,
            File: 1,
            Directory: 2,
            SymbolicLink: 64,
        },
        FileSystemError,

        Uri: MockUri,
        TabInputTextDiff: class MockTabInputTextDiff {
            constructor(
                public original: unknown,
                public modified: unknown,
            ) {}
        },
        env: {
            openExternal: vi.fn(),
        },
        window: {
            showErrorMessage: vi.fn(),
            showInformationMessage: vi.fn(),
            showWarningMessage: vi.fn(),
            showInputBox: vi.fn(),
            showQuickPick: vi.fn(),
            createQuickPick: vi.fn().mockReturnValue({
                items: [],
                placeholder: '',
                matchOnDescription: false,
                matchOnDetail: false,
                value: '',
                selectedItems: [],
                activeItems: [],
                onDidChangeValue: vi.fn(),
                onDidAccept: vi.fn(),
                onDidHide: vi.fn(),
                show: vi.fn(),
                hide: vi.fn(),
                dispose: vi.fn(),
            }),
            withProgress: vi.fn().mockImplementation(async (_: unknown, task: () => Promise<unknown>) => task()),
            setStatusBarMessage: vi.fn(),
            createOutputChannel: vi.fn().mockImplementation((name: string) => ({
                name,
                append: vi.fn(),
                appendLine: vi.fn(),
                replace: vi.fn(),
                clear: vi.fn(),
                show: vi.fn(),
                hide: vi.fn(),
                dispose: vi.fn(),
                logLevel: 3, // LogLevel.Info
                onDidChangeLogLevel: vi.fn().mockReturnValue({ dispose: vi.fn() }),
                trace: vi.fn(),
                debug: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
            })),
            tabGroups: {
                all: [],
                activeTabGroup: { activeTab: undefined },
                onDidChangeTabs: onDidChangeTabsEmitter.event,
                onDidChangeTabGroups: onDidChangeTabGroupsEmitter.event,
                close: vi.fn(),
            },
            visibleTextEditors: [],
            onDidChangeWindowState: onDidChangeWindowStateEmitter.event,
            state: { focused: true },
        },
        workspace: {
            get workspaceFolders() {
                return mockWorkspaceFolders;
            },
            set workspaceFolders(val) {
                mockWorkspaceFolders = val;
            },
            updateWorkspaceFolders: vi
                .fn()
                .mockImplementation(
                    (
                        start: number,
                        deleteCount: number | undefined | null,
                        ...workspaceFoldersToAdd: { uri: MockUri; name?: string }[]
                    ) => {
                        const added = workspaceFoldersToAdd.map((f, i) => ({
                            uri: f.uri,
                            name: f.name || `folder-${start + i}`,
                            index: start + i,
                        }));
                        const removed = mockWorkspaceFolders.slice(start, start + (deleteCount ?? 0));

                        const newFolders = [...mockWorkspaceFolders];
                        newFolders.splice(start, deleteCount ?? 0, ...added);
                        newFolders.forEach((f, i) => {
                            f.index = i;
                        });
                        mockWorkspaceFolders = newFolders;

                        onDidChangeWorkspaceFoldersEmitter.fire({
                            added,
                            removed,
                        });
                        return true;
                    },
                ),
            onDidChangeWorkspaceFolders: onDidChangeWorkspaceFoldersEmitter.event,
            getWorkspaceFolder: vi.fn().mockImplementation((uri: { fsPath: string }) => {
                return mockWorkspaceFolders.find((f) => {
                    const folderPath = f.uri.fsPath.replace(/\\/g, '/').toLowerCase();
                    const filePath = uri.fsPath.replace(/\\/g, '/').toLowerCase();
                    return filePath === folderPath || filePath.startsWith(`${folderPath}/`);
                });
            }),
            getConfiguration: vi.fn().mockReturnValue({
                get: vi.fn().mockImplementation((_key: string, defaultValue: unknown) => defaultValue),
            }),
            onDidChangeConfiguration: onDidChangeConfigurationEmitter.event,
            onDidSaveTextDocument: onDidSaveTextDocumentEmitter.event,

            findFiles: vi.fn().mockResolvedValue([]),
        },
        commands: {
            executeCommand: vi.fn(),
        },
        _emitters: {
            onDidChangeTabs: onDidChangeTabsEmitter,
            onDidChangeTabGroups: onDidChangeTabGroupsEmitter,
            onDidChangeWindowState: onDidChangeWindowStateEmitter,
            onDidChangeConfiguration: onDidChangeConfigurationEmitter,
            onDidSaveTextDocument: onDidSaveTextDocumentEmitter,
            onDidChangeWorkspaceFolders: onDidChangeWorkspaceFoldersEmitter,
        },
    };

    // Shallow merge each top-level key so overrides extend rather than replace namespaces
    for (const key of Object.keys(overrides)) {
        const baseVal = base[key];
        const overrideVal = overrides[key];
        if (
            baseVal &&
            typeof baseVal === 'object' &&
            !Array.isArray(baseVal) &&
            overrideVal &&
            typeof overrideVal === 'object' &&
            !Array.isArray(overrideVal)
        ) {
            base[key] = { ...(baseVal as Record<string, unknown>), ...(overrideVal as Record<string, unknown>) };
        } else {
            base[key] = overrideVal;
        }
    }

    return base;
}
