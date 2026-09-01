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
let encoded = encodeURIComponent(content);
// Encode parentheses to prevent Markdown link [text](url) syntax from terminating early
encoded = encoded.replace(/\(/g, '%28').replace(/\)/g, '%29');

console.log(encoded);
