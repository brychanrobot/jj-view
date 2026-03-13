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
        external: ['vscode', '@parcel/watcher'],
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
 * npm only installs the optional dep for the current platform, so we use
 * `npm pack` to download tarballs for missing platforms and extract them.
 */
async function installNativeDeps() {
    const watcherPkg = require('@parcel/watcher/package.json');
    const optionalDeps = watcherPkg.optionalDependencies || {};

    for (const [name, version] of Object.entries(optionalDeps)) {
        const destDir = path.join(__dirname, 'node_modules', name);
        if (fs.existsSync(destDir)) {
            continue;
        }

        const spec = `${name}@${version}`;
        console.log(`[build] Installing ${spec}...`);
        try {
            const tmpDir = os.tmpdir();
            const tarball = execSync(`npm pack ${spec} --pack-destination "${tmpDir}"`, {
                encoding: 'utf-8',
            }).trim();
            const tarballPath = path.join(tmpDir, tarball);
            fs.mkdirSync(destDir, { recursive: true });
            execSync(`tar xzf "${tarballPath}" --strip-components=1 -C "${destDir}"`, {
                stdio: 'inherit',
            });
            fs.unlinkSync(tarballPath);
            console.log(`[build] Installed ${spec}`);
        } catch (e) {
            console.warn(`[build] Failed to install ${spec}: ${e.message}`);
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
    execSync('npm run build:icons', { stdio: 'inherit' });
}

// Run prerequisite tasks before main build
Promise.all([buildIcons(), copyAssets(), installNativeDeps()])
    .then(main)
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
