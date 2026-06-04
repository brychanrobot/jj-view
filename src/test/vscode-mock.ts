/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { vi } from 'vitest';

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

    const base: Record<string, unknown> = {
        ProgressLocation: { Notification: 15 },
        Position,
        Range,
        Selection,
        Disposable,
        EventEmitter,
        Uri: class MockUri {
            constructor(
                public fsPath: string,
                public scheme: string = 'file',
                public query: string = '',
                public path: string = fsPath,
            ) {}
            static file(fsPath: string) {
                return new MockUri(fsPath);
            }
            static from(components: { scheme: string; path: string; query?: string }) {
                return new MockUri(components.path, components.scheme, components.query || '', components.path);
            }
            static parse(uriString: string) {
                return { _isUriBaseCtorMock: true, value: uriString };
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
                dispose: vi.fn(),
            }),
            withProgress: vi.fn().mockImplementation(async (_: unknown, task: () => Promise<unknown>) => task()),
            setStatusBarMessage: vi.fn(),
            createOutputChannel: vi.fn().mockReturnValue({ appendLine: vi.fn() }),
        },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: '/root' } }],
            getConfiguration: vi.fn().mockReturnValue({
                get: vi.fn().mockImplementation((_key: string, defaultValue: unknown) => defaultValue),
            }),
        },
        commands: {
            executeCommand: vi.fn(),
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
