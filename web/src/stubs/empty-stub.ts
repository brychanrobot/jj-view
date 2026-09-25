/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const thrower: unknown = new Proxy(
    {},
    {
        get(_target, prop) {
            if (prop === '__esModule') {
                return true;
            }
            if (prop === 'default') {
                return thrower;
            }
            throw new Error(`Node.js module or symbol "${String(prop)}" is not available in browser environments.`);
        },
        apply() {
            throw new Error('Node.js module function cannot be called in browser environments.');
        },
    },
);

export default thrower;
