/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (target) {
    mount(App, { target });
}
