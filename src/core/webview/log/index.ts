/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import '@vscode-elements/elements';
import { mount } from 'svelte';
import { initBridge } from '../transport/bridge.svelte';
import LogApp from './LogApp.svelte';

const rootElement = document.getElementById('root');
if (rootElement) {
    initBridge();
    mount(LogApp, { target: rootElement });
}
