/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'child_process';

async function main() {
    const args = process.argv.slice(2);
    let revision = '@';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-r' && args[i + 1]) {
            revision = args[++i];
        }
    }

    try {
        console.log(`Running jj fix on ${revision}...`);
        execFileSync('jj', ['fix', '-s', revision], { stdio: 'inherit' });

        const bookmarksOutput = execFileSync('jj', ['log', '-r', revision, '--no-graph', '-T', 'bookmarks'], {
            encoding: 'utf8',
        }).trim();

        const bookmarks = bookmarksOutput.split(/[\s,]+/).filter(Boolean);

        if (bookmarks.length > 0) {
            console.log(`Found existing bookmarks: ${bookmarks.join(', ')}`);
            console.log(`Pushing revision ${revision}...`);
            execFileSync('jj', ['git', 'push', '-r', revision], { stdio: 'inherit' });
        } else {
            console.log(`No bookmark found on ${revision}. Pushing as change...`);
            execFileSync('jj', ['git', 'push', '-c', revision], { stdio: 'inherit' });
        }

        console.log('Upload successful!');
    } catch (error: unknown) {
        console.error('Upload failed:', error);
        process.exit(1);
    }
}

main();
