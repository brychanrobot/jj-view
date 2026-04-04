/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function question(query: string): Promise<string> {
    return new Promise((resolve) => rl.question(query, resolve));
}

async function main() {
    try {
        const repoConfigPath = execFileSync('jj', ['config', 'path', '--repo'], { encoding: 'utf8' }).trim();
        const sourceConfigPath = path.resolve(__dirname, 'repo-config.toml');

        console.log(`Target config location: ${repoConfigPath}`);
        console.log(`Source config location: ${sourceConfigPath}`);

        const targetDir = path.dirname(repoConfigPath);
        if (!fs.existsSync(targetDir)) {
            console.log(`Creating directory ${targetDir}`);
            fs.mkdirSync(targetDir, { recursive: true });
        }

        if (fs.existsSync(repoConfigPath)) {
            const stats = fs.lstatSync(repoConfigPath);
            if (stats.isSymbolicLink() && fs.readlinkSync(repoConfigPath) === sourceConfigPath) {
                console.log('Configuration is already correctly linked.');
                process.exit(0);
            }

            const answer = await question(
                `A configuration file already exists at ${repoConfigPath}. Replace it? (y/N) `,
            );
            if (answer.toLowerCase() !== 'y') {
                console.log('Aborting setup.');
                process.exit(0);
            }

            if (stats.isSymbolicLink()) {
                fs.unlinkSync(repoConfigPath);
            } else {
                const backupPath = `${repoConfigPath}.bak`;
                console.log(`Backing up existing config to ${backupPath}`);
                fs.renameSync(repoConfigPath, backupPath);
            }
        }

        fs.symlinkSync(sourceConfigPath, repoConfigPath);
        console.log('Successfully linked repository configuration!');
    } catch (error: unknown) {
        console.error('Setup failed:', error);
        process.exit(1);
    } finally {
        rl.close();
    }
}

main();
