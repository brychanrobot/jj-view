/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as parcelWatcher from '@parcel/watcher';
import Handlebars from 'handlebars';
import { type ParseError, parse } from 'jsonc-parser';

export interface ThemeJsonConfig {
    strategy: 'cycle' | 'clamp';
    colors: string[];
    lightColors?: string[];
}

/**
 * Resolves compile-time color expressions like `--opaque(var(--variable))`
 * into modern CSS Relative Color Syntax (`rgb(from var(--variable) r g b / 1)`).
 */
export function resolveColor(color: string): string {
    const trimmed = color.trim();
    const opaqueMatch = /^--opaque\((.+)\)$/.exec(trimmed);
    if (opaqueMatch) {
        return `rgb(from ${opaqueMatch[1].trim()} r g b / 1)`;
    }
    return trimmed;
}

function normalizeThemeConfig(config: ThemeJsonConfig): ThemeJsonConfig {
    return {
        strategy: config.strategy,
        colors: config.colors.map(resolveColor),
        lightColors: config.lightColors ? config.lightColors.map(resolveColor) : undefined,
    };
}

const TS_TEMPLATE = `/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
 * Run \`pnpm build:themes\` to update this file from themes.jsonc.
 */

export interface ThemeConfig {
    strategy: 'cycle' | 'clamp';
    count: number;
}

export const THEME_CONFIGS: Record<string, ThemeConfig> = {
{{#each themes}}
    '{{@key}}': {
        strategy: '{{strategy}}',
        count: {{colors.length}}
    },
{{/each}}
};

/**
 * Returns the CSS variable for a given lane and theme.
 */
export function getColor(lane: number, themeName: string): string {
    const config = THEME_CONFIGS[themeName] || THEME_CONFIGS['default'];

    let index: number;
    if (config.strategy === 'cycle') {
        index = lane % config.count;
    } else {
        index = Math.min(lane, config.count - 1);
    }

    return \`var(--jj-lane-\${index})\`;
}
`;

const CSS_TEMPLATE = `/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
 * Run \`pnpm build:themes\` to update this file from themes.jsonc.
 */

{{#each themes}}
/* Theme: {{@key}} */
.theme-{{@key}} {
{{#each colors}}
    --jj-lane-{{@index}}: {{this}};
{{/each}}
}

{{#if lightColors}}
.vscode-light .theme-{{@key}} {
{{#each lightColors}}
    --jj-lane-{{@index}}: {{this}};
{{/each}}
}
{{/if}}

{{/each}}
`;

export function generateThemes(themesData: Record<string, ThemeJsonConfig>): { ts: string; css: string } {
    const tsTemplate = Handlebars.compile(TS_TEMPLATE);
    const cssTemplate = Handlebars.compile(CSS_TEMPLATE);

    const normalizedThemes: Record<string, ThemeJsonConfig> = {};
    for (const [key, theme] of Object.entries(themesData)) {
        normalizedThemes[key] = normalizeThemeConfig(theme);
    }

    return {
        ts: tsTemplate({ themes: themesData }),
        css: cssTemplate({ themes: normalizedThemes }),
    };
}

function writeIfChanged(filePath: string, content: string) {
    if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, 'utf8');
        if (existing === content) {
            return;
        }
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content);
    console.log(`Generated ${path.relative(process.cwd(), filePath)}`);
}

function runGeneration() {
    try {
        const themesPath = path.join(import.meta.dirname, '../src/core/webview/themes.jsonc');
        if (!fs.existsSync(themesPath)) {
            console.error(`Error: themes.jsonc not found at ${themesPath}`);
            return;
        }

        const raw = fs.readFileSync(themesPath, 'utf8');
        const errors: ParseError[] = [];
        const themesData: unknown = parse(raw, errors);
        if (errors.length > 0 || !themesData || typeof themesData !== 'object') {
            console.error(`Error parsing themes.jsonc: ${errors.map((e) => e.error).join(', ')}`);
            return;
        }

        const { ts, css } = generateThemes(themesData as Record<string, ThemeJsonConfig>);

        const tsOutputPath = path.join(import.meta.dirname, '../src/core/webview/themes.generated.ts');
        const cssOutputPath = path.join(import.meta.dirname, '../media/themes.generated.css');

        writeIfChanged(tsOutputPath, ts);
        writeIfChanged(cssOutputPath, css);
        console.log('Theme generation complete.');
    } catch (e) {
        console.error(`Error generating themes: ${e instanceof Error ? e.message : e}`);
    }
}

async function watchThemes() {
    const themesPath = path.join(import.meta.dirname, '../src/core/webview/themes.jsonc');
    const themesDir = path.dirname(themesPath);
    const themesFile = path.basename(themesPath);

    console.log(`Watching for changes in ${themesPath}...`);

    // Initial run
    runGeneration();

    await parcelWatcher.subscribe(themesDir, (err, events) => {
        if (err) {
            console.error(`Watcher error: ${err.message}`);
            return;
        }

        if (events.some((e) => e.path.endsWith(themesFile))) {
            console.log(`Detected change in ${themesFile}. Regenerating...`);
            runGeneration();
        }
    });
}

function main() {
    const isWatch = process.argv.includes('--watch');
    if (isWatch) {
        watchThemes().catch((e) => {
            console.error(`Failed to start watcher: ${e.message}`);
            process.exit(1);
        });
    } else {
        runGeneration();
    }
}

if (import.meta.main) {
    main();
}
