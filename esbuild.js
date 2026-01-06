// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const esbuild = require('esbuild');
const { execSync } = require('child_process');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',

    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log('[watch] build finished');
        });
    },
};

function formatFile(filePath) {
    try {
        execSync(`npx prettier --write "${filePath}"`, { stdio: 'inherit' });
        console.log(`[build] Formatted ${filePath}`);
    } catch (e) {
        console.error(`[build] Failed to format ${filePath}: ${e.message}`);
    }
}

async function main() {
    const extensionCtx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'dist/extension.js',
        external: ['vscode'],
        logLevel: 'silent',
        plugins: [esbuildProblemMatcherPlugin],
    });

    const webviewCtx = await esbuild.context({
        entryPoints: ['src/webview/index.tsx'],
        bundle: true,
        format: 'iife',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'browser',
        outfile: 'dist/webview/index.js',
        logLevel: 'silent',
        define: {
            'process.env.NODE_ENV': production ? '"production"' : '"development"',
        },
        plugins: [esbuildProblemMatcherPlugin],
        banner: {
            js: 'var process = { env: { NODE_ENV: ' + (production ? '"production"' : '"development"') + ' } };',
        },
    });

    if (watch) {
        await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
    } else {
        await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
        await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
    }
}

async function copyAssets() {
    const fs = require('fs');
    const path = require('path');

    console.log('[build] Copying assets...');

    const assets = [
        {
            src: 'node_modules/@vscode/codicons/dist/codicon.css',
            dest: 'media/codicons/codicon.css',
        },
        {
            src: 'node_modules/@vscode/codicons/dist/codicon.ttf',
            dest: 'media/codicons/codicon.ttf',
        },
    ];

    for (const asset of assets) {
        const srcPath = path.join(__dirname, asset.src);
        const destPath = path.join(__dirname, asset.dest);

        // Ensure destination directory exists
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        fs.copyFileSync(srcPath, destPath);
        console.log(`[build] Copied ${asset.src} to ${asset.dest}`);

        if (destPath.endsWith('.css') || destPath.endsWith('.ts') || destPath.endsWith('.js')) {
            formatFile(destPath);
        }
    }
}

// Run copyAssets and generateMenuActions before main logic
copyAssets()
    .then(main)
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
