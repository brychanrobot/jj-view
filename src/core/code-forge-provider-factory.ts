/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CodeForgeProvider } from './code-forge-provider';
import type { HostEnvironment } from './common/host-environment';
import type { LoggerChannel } from './utils/output-channel';

export interface CodeForgeProviderFactory {
    readonly id: string;
    create(outputChannel: LoggerChannel, host: HostEnvironment): CodeForgeProvider;
}
