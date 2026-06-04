/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as vscode from 'vscode';

export class JjOutputChannel implements vscode.OutputChannel {
    private readonly delegateChannel: vscode.OutputChannel;
    private readonly prefixes: string[] = [];

    constructor(delegate: vscode.OutputChannel, prefix?: string) {
        if (delegate instanceof JjOutputChannel) {
            this.delegateChannel = delegate.delegateChannel;
            this.prefixes = [...delegate.prefixes];
            if (prefix) {
                this.prefixes.push(prefix);
            }
        } else {
            this.delegateChannel = delegate;
            if (prefix) {
                this.prefixes.push(prefix);
            }
        }
    }

    get name(): string {
        return this.delegateChannel.name;
    }

    private format(value: string): string {
        const timestamp = new Date().toISOString();
        const prefixStr = this.prefixes.length > 0 ? ` [${this.prefixes.join('][')}]` : '';
        return `[${timestamp}]${prefixStr} ${value}`;
    }

    append(value: string): void {
        this.delegateChannel.append(value);
    }

    appendLine(value: string): void {
        this.delegateChannel.appendLine(this.format(value));
    }

    replace(value: string): void {
        this.delegateChannel.replace(value);
    }

    clear(): void {
        this.delegateChannel.clear();
    }

    show(preserveFocus?: boolean): void;
    show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
    show(columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean): void {
        if (typeof columnOrPreserveFocus === 'boolean') {
            this.delegateChannel.show(columnOrPreserveFocus);
        } else if (columnOrPreserveFocus !== undefined) {
            this.delegateChannel.show(columnOrPreserveFocus as vscode.ViewColumn, preserveFocus);
        } else {
            this.delegateChannel.show();
        }
    }

    hide(): void {
        this.delegateChannel.hide();
    }

    dispose(): void {
        this.delegateChannel.dispose();
    }
}
