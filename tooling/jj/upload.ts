/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';

function resolveRevision(rev: string): string {
    if (rev === '@') {
        try {
            const template =
                'empty ++ "\\t" ++ if(description, "true", "false") ++ "\\t" ++ if(bookmarks, "true", "false")';
            const output = execFileSync('jj', ['log', '-r', '@', '--no-graph', '-T', template], {
                encoding: 'utf8',
            }).trim();
            const [isEmpty, hasDesc, hasBm] = output.split('\t');
            if ((isEmpty === 'true' || hasDesc !== 'true') && hasBm !== 'true') {
                console.log('Working copy @ is empty or has no description/bookmarks. Targeting parent @- instead.');
                return '@-';
            }
        } catch {
            // If check fails, return original revision
        }
    }
    return rev;
}

async function main() {
    const rawArgs = process.argv.slice(2);
    const pushArgs: string[] = [];
    const fixTargets: string[] = [];

    // Parse -r, --revision, -c, --change, and other flags
    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if ((arg === '-r' || arg === '--revision' || arg === '-c' || arg === '--change') && rawArgs[i + 1]) {
            const target = resolveRevision(rawArgs[++i]);
            pushArgs.push(arg, target);
            fixTargets.push(target);
        } else {
            pushArgs.push(arg);
        }
    }

    try {
        const hasExplicitTarget = fixTargets.length > 0;
        if (!hasExplicitTarget) {
            const revision = resolveRevision('@');
            fixTargets.push(revision);

            const bookmarksOutput = execFileSync('jj', ['log', '-r', revision, '--no-graph', '-T', 'bookmarks'], {
                encoding: 'utf8',
            }).trim();
            const bookmarks = bookmarksOutput.split(/[\s,]+/).filter(Boolean);

            if (bookmarks.length > 0) {
                console.log(`Found existing bookmarks: ${bookmarks.join(', ')}`);
                pushArgs.unshift('-r', revision);
            } else {
                console.log(`No bookmark found on ${revision}. Pushing as change...`);
                pushArgs.unshift('-c', revision);
            }
        }

        if (fixTargets.length > 0) {
            console.log(`Running jj fix on targets: ${fixTargets.join(', ')}...`);
            const fixArgs = ['fix', ...fixTargets.flatMap((t) => ['-s', t])];
            execFileSync('jj', fixArgs, { stdio: 'inherit' });
        }

        console.log(`Pushing with args: ${pushArgs.join(' ')}...`);
        execFileSync('jj', ['git', 'push', ...pushArgs], { stdio: 'inherit' });

        console.log('Upload successful!');
    } catch (error: unknown) {
        console.error('Upload failed:', error);
        process.exit(1);
    }
}

main();
