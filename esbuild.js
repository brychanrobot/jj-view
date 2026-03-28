/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const esbuild = require('esbuild');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
        execSync(`pnpm prettier --write "${filePath}"`, { stdio: 'inherit' });
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

/**
 * Install all platform-specific @parcel/watcher binaries so the VSIX is universal.
 * We download tarballs directly from the npm registry for all platforms and
 * place them in dist/node_modules so they are bundled in the VSIX.
 */
async function installNativeDeps() {
    const watcherPkg = require('@parcel/watcher/package.json');
    const optionalDeps = watcherPkg.optionalDependencies || {};
    const distNodeModules = path.join(__dirname, 'dist', 'node_modules');

    for (const [name, version] of Object.entries(optionalDeps)) {
        const destDir = path.join(distNodeModules, name);
        const cleanVersion = version.replace(/^[\^~>=<]+/, '');

        // Check if the dependency is already installed with the correct version
        const pkgPath = path.join(destDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                if (pkg.version === cleanVersion) {
                    console.log(`[build] Skipping ${name}@${cleanVersion} (already installed)`);
                    continue;
                }
            } catch (e) {
                console.warn(`[build] Failed to read ${pkgPath}, re-installing...`);
            }
        }

        const unscoped = name.split('/').pop();
        const tarballUrl = `https://registry.npmjs.org/${name}/-/${unscoped}-${cleanVersion}.tgz`;

        console.log(`[build] Downloading ${name}@${cleanVersion}...`);
        try {
            const response = await fetch(tarballUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            const tarballPath = path.join(os.tmpdir(), `${unscoped}-${cleanVersion}.tgz`);
            fs.writeFileSync(tarballPath, buffer);

            fs.rmSync(destDir, { recursive: true, force: true });
            fs.mkdirSync(destDir, { recursive: true });

            execSync(`tar xzf "${tarballPath}" --strip-components=1 -C "${destDir}"`, {
                stdio: 'inherit',
            });
            fs.unlinkSync(tarballPath);
            console.log(`[build] Installed ${name}@${cleanVersion}`);
        } catch (e) {
            console.warn(`[build] Failed to install ${name}@${cleanVersion}: ${e.message}`);
        }
    }
}

async function buildIcons() {
    console.log('[build] Building icons...');
    const inputDir = path.join(__dirname, 'media/custom-icons-src');
    console.log(`[build] Icon input dir: ${inputDir}`);

    if (fs.existsSync(inputDir)) {
        const files = fs.readdirSync(inputDir);
        console.log(`[build] Contents of input dir: ${files.join(', ')}`);
    } else {
        console.error(`[build] Icon input dir does not exist: ${inputDir}`);
    }

    const iconDir = path.join(__dirname, 'media/custom-icons');
    if (!fs.existsSync(iconDir)) {
        fs.mkdirSync(iconDir, { recursive: true });
    }
    execSync('pnpm run build:icons', { stdio: 'inherit' });
}

// Run prerequisite tasks before main build
Promise.all([buildIcons(), copyAssets(), installNativeDeps()])
    .then(main)
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
