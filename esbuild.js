/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const esbuild = require('esbuild');
const sveltePlugin = require('esbuild-svelte');
const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const webOnly = process.argv.includes('--web');
// --metafile writes web/dist/app.meta.json (esbuild metafile) so bundle size
// can be attributed per input with `npx esbuild --analyze` or a script.
const metafile = process.argv.includes('--metafile');

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

/**
 * @type {import('esbuild').Plugin}
 */
const browserShimsPlugin = {
    name: 'browser-shims',
    setup(build) {
        build.onResolve({ filter: /^@parcel\/watcher/ }, () => {
            return { path: path.resolve(__dirname, 'web/src/stubs/parcel-watcher.ts') };
        });
        build.onResolve({ filter: /[/\\]node-host-system(?:\.[cm]?[jt]sx?)?$/ }, () => {
            return { path: path.resolve(__dirname, 'web/src/stubs/node-host-system.ts') };
        });
        build.onResolve({ filter: /[/\\]binary-utils(?:\.[cm]?[jt]sx?)?$/ }, () => {
            return { path: path.resolve(__dirname, 'web/src/stubs/binary-utils.ts') };
        });
        build.onResolve({ filter: /^(node:)?(fs|child_process|os|path)(\/promises)?$/ }, () => {
            return { path: path.resolve(__dirname, 'web/src/stubs/empty-stub.ts') };
        });
        build.onResolve({ filter: /^detect-libc$/ }, () => {
            return { path: path.resolve(__dirname, 'web/src/stubs/empty-stub.ts') };
        });
    },
};

function formatFile(filePath, { ignoreUnmatched = false } = {}) {
    try {
        const pnpmCmd = os.platform() === 'win32' ? 'pnpm.cmd' : 'pnpm';
        const args = ['biome', 'format', '--write', filePath];
        if (ignoreUnmatched) {
            args.push('--no-errors-on-unmatched');
        }
        execFileSync(pnpmCmd, args, { stdio: 'inherit' });
        console.log(`[build] Formatted ${filePath}`);
    } catch (e) {
        console.error(`[build] Failed to format ${filePath}: ${e.message}`);
    }
}

async function main() {
    const webDefine = {
        'process.env.NODE_ENV': production ? '"production"' : '"development"',
    };
    const webBanner = {
        js: `var process = { env: { NODE_ENV: ${production ? '"production"' : '"development"'} } };`,
    };
    const webPlugins = () => [
        browserShimsPlugin,
        sveltePlugin({
            compilerOptions: {
                dev: !production,
                css: 'external',
            },
        }),
        esbuildProblemMatcherPlugin,
    ];

    // The app is an ES module with code splitting. Without splitting, every
    // `import()` in the dependency graph is inlined: @pierre/diffs pulls in
    // shiki's `bundledLanguages`/theme maps, whose lazy loaders then drag all
    // ~220 grammars, every theme and the oniguruma wasm into app.js (~10 MB of
    // a 12 MB bundle) even though a diff view needs one or two of them. With
    // splitting they become hashed chunks under web/dist/chunks/ that the
    // browser fetches the first time a language or theme is actually used.
    const standaloneAppCtx = await esbuild.context({
        entryPoints: { app: 'web/src/main.ts' },
        bundle: true,
        format: 'esm',
        splitting: true,
        chunkNames: 'chunks/[name]-[hash]',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'browser',
        outdir: 'web/dist',
        logLevel: 'silent',
        define: webDefine,
        plugins: webPlugins(),
        banner: webBanner,
        metafile,
    });

    // preload.js is loaded with a synchronous <script> in <head> (it must run
    // before the body) so it stays a classic script.
    const preloadCtx = await esbuild.context({
        entryPoints: { preload: 'web/src/sidecar/preload.ts' },
        bundle: true,
        format: 'iife',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'browser',
        outdir: 'web/dist',
        logLevel: 'silent',
        define: webDefine,
        plugins: webPlugins(),
        banner: webBanner,
    });

    const webContexts = [standaloneAppCtx, preloadCtx];

    if (webOnly) {
        if (watch) {
            await Promise.all(webContexts.map((ctx) => ctx.watch()));
        } else {
            const [appResult] = await Promise.all(webContexts.map((ctx) => ctx.rebuild()));
            if (metafile && appResult.metafile) {
                const metaPath = path.join('web', 'dist', 'app.meta.json');
                fs.writeFileSync(metaPath, JSON.stringify(appResult.metafile));
                console.log(`[build] Wrote ${metaPath}`);
            }
            await Promise.all(webContexts.map((ctx) => ctx.dispose()));
        }
        return;
    }

    const extensionCtx = await esbuild.context({
        entryPoints: ['src/vscode/extension.ts'],
        bundle: true,
        format: 'cjs',
        mainFields: ['module', 'main'],
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'dist/extension.js',
        external: ['vscode'],
        logLevel: 'silent',
        plugins: [
            sveltePlugin({
                compilerOptions: {
                    dev: false,
                    generate: 'server',
                },
            }),
            esbuildProblemMatcherPlugin,
        ],
    });

    const webviewCtx = await esbuild.context({
        entryPoints: {
            index: 'src/core/webview/log/index.ts',
            'commit-details': 'src/core/webview/commit-details/index.ts',
            'process-monitor': 'src/core/webview/process-monitor/index.ts',
        },
        bundle: true,
        format: 'iife',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'browser',
        outdir: 'dist/webview',
        logLevel: 'silent',
        define: {
            'process.env.NODE_ENV': production ? '"production"' : '"development"',
        },
        plugins: [
            sveltePlugin({
                compilerOptions: {
                    dev: !production,
                    css: 'external',
                },
            }),
            esbuildProblemMatcherPlugin,
        ],
        banner: {
            js: `var process = { env: { NODE_ENV: ${production ? '"production"' : '"development"'} } };`,
        },
    });

    const allContexts = [extensionCtx, webviewCtx, ...webContexts];
    if (watch) {
        await Promise.all(allContexts.map((ctx) => ctx.watch()));
    } else {
        await Promise.all(allContexts.map((ctx) => ctx.rebuild()));
        await Promise.all(allContexts.map((ctx) => ctx.dispose()));
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
        {
            src: 'node_modules/@vscode/codicons/dist/codicon.css',
            dest: 'web/dist/codicons/codicon.css',
        },
        {
            src: 'node_modules/@vscode/codicons/dist/codicon.ttf',
            dest: 'web/dist/codicons/codicon.ttf',
        },
        {
            src: 'media/custom-icons/jj-view-icons.css',
            dest: 'web/dist/custom-icons/jj-view-icons.css',
        },
        {
            src: 'media/custom-icons/jj-view-icons.woff2',
            dest: 'web/dist/custom-icons/jj-view-icons.woff2',
        },
        {
            src: 'web/node_modules/@pierre/diffs/dist/worker/worker-portable.js',
            dest: 'web/dist/pierre-worker.js',
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

        if (
            !destPath.includes('dist') &&
            (destPath.endsWith('.css') || destPath.endsWith('.ts') || destPath.endsWith('.js'))
        ) {
            formatFile(destPath, { ignoreUnmatched: true });
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
            } catch (_) {
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

async function generateSettingsSchema() {
    execFileSync(process.execPath, [path.join(__dirname, 'tooling/generate-settings-schema.ts')], {
        stdio: 'inherit',
    });
}

// Run prerequisite tasks before main build
Promise.all([generateSettingsSchema(), buildIcons(), copyAssets(), webOnly ? Promise.resolve() : installNativeDeps()])
    .then(main)
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
