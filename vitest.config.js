/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
const config_1 = require('vitest/config');
exports.default = (0, config_1.defineConfig)({
    test: {
        include: ['src/test/**/*.test.ts'],
        exclude: ['src/test/jj-scm.test.ts', 'src/test/extension.test.ts'], // Exclude integration tests
        globals: true,
    },
});
//# sourceMappingURL=vitest.config.js.map
