/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const content: string = process.argv.slice(2).join(' ');
if (!content) {
    process.exit(0);
}
console.log(encodeURIComponent(content));
