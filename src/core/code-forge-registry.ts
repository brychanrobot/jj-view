/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CodeForgeProviderFactory } from './code-forge-provider-factory';
import { type Disposable, type Event, EventEmitter } from './host/events';

export class CodeForgeRegistry implements Disposable {
    private factories = new Map<string, CodeForgeProviderFactory>();
    private _onDidRegisterFactory = new EventEmitter<CodeForgeProviderFactory>();
    public readonly onDidRegisterFactory: Event<CodeForgeProviderFactory> = this._onDidRegisterFactory.event;

    public register(factory: CodeForgeProviderFactory): Disposable {
        if (this.factories.has(factory.id)) {
            throw new Error(`Factory with id '${factory.id}' is already registered.`);
        }
        this.factories.set(factory.id, factory);
        this._onDidRegisterFactory.fire(factory);

        return {
            dispose: () => {
                if (this.factories.get(factory.id) === factory) {
                    this.factories.delete(factory.id);
                }
            },
        };
    }

    public getFactories(): CodeForgeProviderFactory[] {
        return Array.from(this.factories.values());
    }

    public dispose(): void {
        this._onDidRegisterFactory.dispose();
        this.factories.clear();
    }
}
