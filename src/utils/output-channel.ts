/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as vscode from 'vscode';

export type JjLoggerChannel = Omit<vscode.LogOutputChannel, 'appendLine' | 'append'>;

export class JjOutputChannel {
    private readonly delegateChannel: JjLoggerChannel;
    private readonly prefixes: string[] = [];

    constructor(delegate: JjLoggerChannel, prefix?: string) {
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

    get logLevel(): vscode.LogLevel {
        return this.delegateChannel.logLevel;
    }

    get onDidChangeLogLevel(): vscode.Event<vscode.LogLevel> {
        return this.delegateChannel.onDidChangeLogLevel;
    }

    private formatPrefixes(): string {
        return this.prefixes.length > 0 ? `[${this.prefixes.join('][')}] ` : '';
    }

    trace(message: string, ...args: unknown[]): void {
        this.delegateChannel.trace(this.formatPrefixes() + message, ...args);
    }

    debug(message: string, ...args: unknown[]): void {
        this.delegateChannel.debug(this.formatPrefixes() + message, ...args);
    }

    info(message: string, ...args: unknown[]): void {
        this.delegateChannel.info(this.formatPrefixes() + message, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        this.delegateChannel.warn(this.formatPrefixes() + message, ...args);
    }

    error(message: string | Error, ...args: unknown[]): void {
        const prefix = this.formatPrefixes();
        if (typeof message === 'string') {
            this.delegateChannel.error(prefix + message, ...args);
        } else {
            // Pass the prefixed message but forward the original Error object to preserve
            // stack traces, identity, and any custom properties (e.g. error codes).
            this.delegateChannel.error(prefix + message.message, message, ...args);
        }
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
