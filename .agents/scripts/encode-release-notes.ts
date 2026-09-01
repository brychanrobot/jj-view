/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
const content: string = args.join(' ');
if (!content) {
    process.exit(0);
}
console.log(encodeURIComponent(content));
