/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { hydrate, mount } from 'svelte';
import { initBridge } from '../transport/bridge.svelte';
import CommitDetailsApp from './CommitDetailsApp.svelte';

const rootElement = document.getElementById('root');
if (rootElement) {
    initBridge();
    if (rootElement.hasChildNodes()) {
        hydrate(CommitDetailsApp, { target: rootElement });
    } else {
        mount(CommitDetailsApp, { target: rootElement });
    }
}
