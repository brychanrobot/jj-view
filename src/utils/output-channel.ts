/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface LoggerChannel {
    readonly name?: string;
    trace?(message: string): void;
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: Error): void;
    replace?(value: string): void;
    clear?(): void;
    show?(preserveFocus?: boolean): void;
    hide?(): void;
    dispose?(): void;
}

export const NO_OP_LOGGER: LoggerChannel = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

export class OutputChannel implements LoggerChannel {
    private readonly delegateChannel: LoggerChannel;
    private readonly prefixes: string[] = [];

    constructor(delegate: LoggerChannel, prefix?: string) {
        if (delegate instanceof OutputChannel) {
            this.delegateChannel = delegate.delegateChannel;
            this.prefixes = [...delegate.prefixes];
        } else {
            this.delegateChannel = delegate;
        }
        if (prefix) {
            this.prefixes.push(prefix);
        }
    }

    get name(): string | undefined {
        return this.delegateChannel.name;
    }

    private formatPrefixes(): string {
        return this.prefixes.length > 0 ? `[${this.prefixes.join('][')}] ` : '';
    }

    trace(message: string): void {
        this.delegateChannel.trace?.(`${this.formatPrefixes()}${message}`);
    }

    debug(message: string): void {
        this.delegateChannel.debug(`${this.formatPrefixes()}${message}`);
    }

    info(message: string): void {
        this.delegateChannel.info(`${this.formatPrefixes()}${message}`);
    }

    warn(message: string): void {
        this.delegateChannel.warn(`${this.formatPrefixes()}${message}`);
    }

    error(message: string, error?: Error): void {
        const prefix = this.formatPrefixes();
        if (error !== undefined) {
            this.delegateChannel.error(`${prefix}${message}`, error);
        } else {
            this.delegateChannel.error(`${prefix}${message}`);
        }
    }

    replace(value: string): void {
        this.delegateChannel.replace?.(value);
    }

    clear(): void {
        this.delegateChannel.clear?.();
    }

    show(preserveFocus?: boolean): void {
        this.delegateChannel.show?.(preserveFocus);
    }

    hide(): void {
        this.delegateChannel.hide?.();
    }

    dispose(): void {
        if (this.prefixes.length === 0) {
            this.delegateChannel.dispose?.();
        }
    }
}
