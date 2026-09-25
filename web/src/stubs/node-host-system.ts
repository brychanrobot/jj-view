/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HostFs, HostPlatform, HostProcess, HostSystem, HostWatcher } from '../../../src/core/host/host-system';

export class NodeHostProcess implements HostProcess {
    constructor() {
        throw new Error('NodeHostProcess is not available in browser environments. Use RemoteHostProcess instead.');
    }

    public execFile(): never {
        throw new Error('NodeHostProcess is not available in browser environments.');
    }

    public getHelperScriptPath(): never {
        throw new Error('NodeHostProcess is not available in browser environments.');
    }
}

export class NodeHostFs implements HostFs {
    public readonly tempDir = '';

    constructor() {
        throw new Error('NodeHostFs is not available in browser environments. Use RemoteHostFs instead.');
    }

    public readTextFile(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public readBinaryFile(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public writeTextFile(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public writeBinaryFile(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public exists(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public stat(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public lstat(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public mkdir(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public readdir(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public rm(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public unlink(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public realpath(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public mkdtemp(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public createTempDir(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
    public cleanupTempDir(): never {
        throw new Error('NodeHostFs is not available in browser environments.');
    }
}

export class NodeHostWatcher implements HostWatcher {
    constructor() {
        throw new Error('NodeHostWatcher is not available in browser environments. Use RemoteHostWatcher instead.');
    }

    public watch(): never {
        throw new Error('NodeHostWatcher is not available in browser environments.');
    }
}

export class NodeHostSystem implements HostSystem {
    public readonly process: HostProcess;
    public readonly fs: HostFs;
    public readonly watcher: HostWatcher;
    public readonly platform: HostPlatform = 'linux';

    constructor() {
        throw new Error('NodeHostSystem is not available in browser environments. Use RemoteHostSystem instead.');
    }
}
