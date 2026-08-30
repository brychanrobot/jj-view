/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoggerChannel } from '../utils/output-channel';
import type { CodeForgeProvider } from './code-forge-provider';
import type { HostEnvironment } from './host/host-environment';

export interface CodeForgeProviderFactory {
    readonly id: string;
    create(outputChannel: LoggerChannel, host: HostEnvironment): CodeForgeProvider;
}
