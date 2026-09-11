/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { mount } from 'svelte';
import { initBridge } from '../transport/bridge.svelte';
import ProcessMonitorApp from './ProcessMonitorApp.svelte';

const rootElement = document.getElementById('root');
if (rootElement) {
    initBridge();
    mount(ProcessMonitorApp, { target: rootElement });
}
