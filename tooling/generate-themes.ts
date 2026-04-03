import * as parcelWatcher from '@parcel/watcher';
import * as fs from 'fs';
import * as Handlebars from 'handlebars';
import * as path from 'path';

export interface ThemeJsonConfig {
    strategy: 'cycle' | 'clamp';
    colors: string[];
    lightColors?: string[];
}

const TS_TEMPLATE = `/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
 * Run \`pnpm build:themes\` to update this file from themes.json.
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
 * Run \`pnpm build:themes\` to update this file from themes.json.
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

    const context = { themes: themesData };

    return {
        ts: tsTemplate(context),
        css: cssTemplate(context),
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
        const themesPath = path.join(__dirname, '../src/webview/themes.json');
        if (!fs.existsSync(themesPath)) {
            console.error(`Error: themes.json not found at ${themesPath}`);
            return;
        }

        const themesData: Record<string, ThemeJsonConfig> = JSON.parse(fs.readFileSync(themesPath, 'utf8'));

        const { ts, css } = generateThemes(themesData);

        const tsOutputPath = path.join(__dirname, '../src/webview/themes.generated.ts');
        const cssOutputPath = path.join(__dirname, '../media/themes.generated.css');

        writeIfChanged(tsOutputPath, ts);
        writeIfChanged(cssOutputPath, css);
    } catch (e) {
        console.error(`Error generating themes: ${e instanceof Error ? e.message : e}`);
    }
}

async function watchThemes() {
    const themesPath = path.join(__dirname, '../src/webview/themes.json');
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

if (require.main === module) {
    main();
}
