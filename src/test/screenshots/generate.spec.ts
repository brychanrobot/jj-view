/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import {
    ensureSidebarWide,
    focusJJLog,
    focusSCM,
    getLogWebview,
    test,
    type VSCodeFixture,
    waitForLogCommitRow,
    waitForTab,
} from '../e2e/e2e-helpers';
import { buildGraph, TestRepo } from '../test-repo';

/**
 * Promotional screenshot generator for the README.
 *
 * Showcases JJ View's key features with "The Marauder's Holocron" demo repo
 * (Star Wars x Harry Potter crossover theme):
 * 1. scm-view.png: Hero overview (Revision graph + SCM changes + code editor)
 * 2. drag-drop.png: Interactive drag-and-drop rebasing/squashing with modifier preview
 * 3. commit-details.png: Custom .jj-commit editor with rulers, metadata & changed files
 * 4. multi-file-diff.png: Multi-File Diff viewer reviewing full changeset diffs
 */
// Common helpers
const closeSecondarySidebar = async (vscode: VSCodeFixture) => {
    try {
        await vscode.executeCommand('workbench.action.closeAuxiliaryBar');
    } catch {}
    try {
        await vscode.executeCommand('workbench.action.closeSecondarySidebar');
    } catch {}
    try {
        await vscode.executeCommand('workbench.action.chat.close');
    } catch {}
};

const splitSCMPane = async (page: Page) => {
    try {
        const logHeader = page.locator('.pane-header', { hasText: 'JJ Log' }).first();
        const changesHeader = page.locator('.pane-header', { hasText: 'Changes' }).first();

        await expect(async () => {
            if (!(await logHeader.isVisible()) || !(await changesHeader.isVisible())) {
                return;
            }
            const logBox = await logHeader.boundingBox();
            const changesBox = await changesHeader.boundingBox();
            if (!logBox || !changesBox) {
                return;
            }

            if (logBox.y < changesBox.y) {
                // JJ Log is top pane. Drag sash down to Y=490
                if (changesBox.y >= 480) {
                    return;
                }
                const centerX = changesBox.x + changesBox.width / 2;
                await page.mouse.move(centerX, changesBox.y - 2);
                await page.mouse.down();
                await page.mouse.move(centerX, 490, { steps: 30 });
                await page.mouse.up();
                await page.waitForTimeout(300);

                const newChangesBox = await changesHeader.boundingBox();
                expect(newChangesBox?.y).toBeGreaterThanOrEqual(480);
            } else {
                // JJ Log is bottom pane. Drag sash to midpoint ~380
                if (logBox.y >= 370 && logBox.y <= 410) {
                    return;
                }
                const centerX = logBox.x + logBox.width / 2;
                await page.mouse.move(centerX, logBox.y - 2);
                await page.mouse.down();
                await page.mouse.move(centerX, 380, { steps: 30 });
                await page.mouse.up();
                await page.waitForTimeout(300);

                const newLogBox = await logHeader.boundingBox();
                expect(newLogBox?.y).toBeLessThanOrEqual(410);
                expect(newLogBox?.y).toBeGreaterThanOrEqual(370);
            }
        }).toPass({ timeout: 5000, intervals: [200, 500] });
    } catch (e) {
        console.error('Failed to adjust SCM pane split:', e);
    }
};

const focusDocument = async (page: Page, vscode: VSCodeFixture) => {
    try {
        await vscode.executeCommand('workbench.action.focusActiveEditorGroup');
        const editor = page.locator('.editor-instance .monaco-editor').first();
        if (await editor.isVisible()) {
            await editor.click();
        }
        await page.keyboard.press('Escape');
    } catch {}
    // Blur active editor element so modifier keys don't type into the editor buffer
    await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
    });
    // Move mouse to bottom-right corner to avoid triggering editor hover tooltips
    await page.mouse.move(1270, 790);
    await page.waitForTimeout(300);
};

/**
 * 1. Screenshot 1: scm-view.png (Hero Overview - Default Theme, 3 Lanes, No Empty Commits)
 */
test('screenshot 1: scm-view', async ({ vscode }) => {
    test.setTimeout(60000);
    const repo = new TestRepo();
    repo.init();

    await buildGraph(repo, [
        {
            label: 'initial',
            description: "Initial commit: Add Marauder's Holocron manifesto",
            tags: ['v1.0.0'],
            files: {
                'README.md': `# 🪄 Marauder's Holocron 🌌\n\n> "I solemnly swear that I am up to no good in a galaxy far, far away."\n`,
                'src/targeting/death-star-computer.ts': `/**
 * 🎯 Targeting Guidance System
 * Manages thermal exhaust port targeting during the trench run.
 */
export class TargetingGuidance {
    private isLocked = false;

    lockExhaustPort(coordinates: { x: number; y: number; z: number }): boolean {
        console.log('Targeting computer locked on 2m thermal exhaust port.');
        this.isLocked = true;
        return this.isLocked;
    }

    fireProtonTorpedoes(useForce: boolean): string {
        if (useForce) {
            console.warn('Obi-Wan: "Use the Force, Harry. Let go."');
            return 'Proton torpedoes guided into the exhaust port via the Force!';
        }
        return 'Mechanical trajectory calculation failed!';
    }
}
`,
            },
        },
        {
            label: 'docs-map',
            parents: ['initial'],
            description: "docs: update star chart and Marauder's Map overlay",
            bookmarks: ['docs/star-map'],
            files: {
                'docs/star-map.md': `# Galactic Star Map\n\n- Outer Rim Sector 4\n- Hogwarts Hyperlane: Active\n`,
            },
        },
        {
            label: 'feat-hyperdrive',
            parents: ['initial'],
            description: 'feat(engine): calibrate Nimbus 2000 warp drive',
            files: {
                'src/hyperdrive/nimbus.ts': `export interface WarpBroomstickConfig {
    model: 'Nimbus 2000' | 'Firebolt Hyperdrive';
    maxWarpSpeed: number; // Parsecs per Quidditch match
    antiDeathEaterShields: boolean;
}
`,
            },
        },
        {
            label: 'main-trunk',
            parents: ['feat-hyperdrive'],
            description: 'feat(shields): deploy deflector shield grid',
            bookmarks: ['main'],
            files: {
                'src/defense/deflector-grid.ts': `export const DEFLECTOR_POWER_GW = 150_000;\n`,
            },
        },
        {
            label: 'feat-spells',
            parents: ['feat-hyperdrive'],
            description: 'feat(spells): add Expelliarmus lightsaber disarming charm',
            bookmarks: ['feature/lightsaber-wand'],
            files: {
                'src/spells/lightsaber-wand.ts': `export class LightsaberWand {
    readonly core = 'Kyber Crystal & Phoenix Feather';

    castExpelliarmus(): string {
        return 'Disarmed! An elegant weapon for a more civilized Jedi wizard.';
    }
}
`,
            },
        },
        {
            label: 'working-copy',
            parents: ['feat-spells'],
            description: 'fix(targeting): use the force, Harry (turn off targeting computer)',
            files: {
                'src/targeting/guidance-override.ts': `export const JEDI_OVERRIDE_ENABLED = true;\n`,
            },
            isCurrentWorkingCopy: true,
        },
    ]);

    // Uncommitted working copy modifications
    repo.writeFile(
        'src/targeting/death-star-computer.ts',
        `/**
 * 🎯 Targeting Guidance System
 * Manages thermal exhaust port targeting during the trench run.
 */
export class TargetingGuidance {
    private isLocked = false;
    private jediInstinctActive = true;

    lockExhaustPort(coordinates: { x: number; y: number; z: number }): boolean {
        // Switching off targeting computer for the trench run
        console.warn('Targeting computer switch: OFF. Trusting the Force.');
        this.isLocked = false;
        return true;
    }

    fireProtonTorpedoes(useForce: boolean): string {
        if (useForce || this.jediInstinctActive) {
            console.warn('Obi-Wan: "The Force will be with you. Always, Harry."');
            return 'Proton torpedoes curved directly into the thermal exhaust port! 🌟';
        }
        return 'Mechanical trajectory calculation failed!';
    }
}
`,
    );

    repo.writeFile(
        'src/hyperdrive/nimbus.ts',
        `export interface WarpBroomstickConfig {
    model: 'Nimbus 2000' | 'Firebolt Hyperdrive' | 'Millennium Falcon 3000';
    maxWarpSpeed: number; // Parsecs per Quidditch match
    antiDeathEaterShields: boolean;
    snitchTrackingGuidance: boolean;
}
`,
    );

    repo.writeFile(
        'src/spells/patronus-shield.ts',
        `export function expectoPatronumShield(): string {
    return 'Expecto Patronum! Deflecting Imperial Dementors and TIE Fighters.';
}
`,
    );

    const screenshotsDir = path.resolve('media/screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    const { page } = await vscode.openWorkspace(repo, {
        'editor.fontSize': 13,
        'terminal.integrated.fontSize': 12,
        'chat.commandCenter.enabled': false,
        'chat.agent.enabled': false,
        'github.copilot.chat.enable': false,
        'workbench.secondarySideBar.location': 'hidden',
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await closeSecondarySidebar(vscode);

    await vscode.openFileInEditor(path.join(repo.path, 'src/targeting/death-star-computer.ts'));
    await waitForTab(page, /death-star-computer\.ts/);
    await focusSCM(page);
    await focusJJLog(page);
    await ensureSidebarWide(page);
    await splitSCMPane(page);
    await focusDocument(page, vscode);

    await waitForLogCommitRow(page, 'calibrate Nimbus 2000 warp drive');
    await waitForLogCommitRow(page, 'use the force, Harry');

    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(screenshotsDir, 'scm-view.png') });
});

/**
 * 2. Screenshot 2: drag-drop.png (5 Parallel Long-Lived Lanes - Dracula Theme, No Empty Commits)
 */
test('screenshot 2: drag-drop', async ({ vscode }) => {
    test.setTimeout(60000);
    const repo = new TestRepo();
    repo.init();

    await buildGraph(repo, [
        {
            label: 'initial',
            description: "feat(core): initialize Marauder's Holocron base matrix",
            tags: ['v1.0.0'],
            files: {
                'README.md': `# 🪄 Marauder's Holocron\n`,
            },
        },
        // Lane 0: Main trunk (2 commits)
        {
            label: 'main-1',
            parents: ['initial'],
            description: 'feat(engine): deploy Millennium Falcon 3000 warp core',
            files: {
                'src/engine/warp-core.ts': `export const WARP_CORE_OUTPUT_MW = 950_000;\n`,
            },
        },
        {
            label: 'main-2',
            parents: ['main-1'],
            description: 'feat(engine): add coaxium hyperdrive stabilizer',
            bookmarks: ['main'],
            files: {
                'src/engine/coaxium.ts': `export const COAXIUM_INJECTION_STABILIZER = true;\n`,
            },
        },
        // Lane 1: Wand spells (2 commits)
        {
            label: 'wand-1',
            parents: ['initial'],
            description: 'feat(spells): synthesize Kyber crystal matrix',
            files: {
                'src/spells/kyber.ts': `export const KYBER_RESONANCE_FREQ = 432;\n`,
            },
        },
        {
            label: 'wand-2',
            parents: ['wand-1'],
            description: 'feat(spells): forge Phoenix feather emitter wand',
            bookmarks: ['feature/lightsaber-wand'],
            files: {
                'src/spells/emitter.ts': `export const EMITTER_CORE = 'Phoenix Feather';\n`,
            },
        },
        // Lane 2: Shields (2 commits)
        {
            label: 'shield-1',
            parents: ['initial'],
            description: 'feat(defense): construct ray-shield grid',
            files: {
                'src/defense/ray-grid.ts': `export const RAY_GRID_SEGMENTS = 64;\n`,
            },
        },
        {
            label: 'shield-2',
            parents: ['shield-1'],
            description: 'feat(defense): seal thermal exhaust port with Protego Maxima',
            bookmarks: ['feature/death-star-shields'],
            files: {
                'src/defense/exhaust.ts': `export const PROTEGO_MAXIMA_SEAL = true;\n`,
            },
        },
        // Lane 3: Droid (2 commits)
        {
            label: 'droid-1',
            parents: ['initial'],
            description: 'feat(droid): initialize R2-D2 astromech core',
            files: {
                'src/droid/r2d2.ts': `export const ASTROMECH_CHASSIS = 'R2-D2';\n`,
            },
        },
        {
            label: 'droid-2',
            parents: ['droid-1'],
            description: 'feat(droid): install holographic sorting hat protocol',
            bookmarks: ['feature/astromech-droid'],
            files: {
                'src/droid/sorting-hat.ts': `export const SORTING_HAT_PROTOCOL = 'Gryffindor';\n`,
            },
        },
        // Lane 4: Trench run tactics (2 commits)
        {
            label: 'trench-1',
            parents: ['initial'],
            description: 'feat(tactics): compute Yavin trench run vector',
            files: {
                'src/tactics/vector.ts': `export const TRENCH_VECTOR_X = 14.2;\n`,
            },
        },
        {
            label: 'trench-2',
            parents: ['trench-1'],
            description: 'feat(tactics): simulate proton torpedo trajectory',
            bookmarks: ['feature/trench-tactics'],
            files: {
                'src/tactics/torpedo.ts': `export const TORPEDO_CURVE_ARC = 90;\n`,
            },
        },
        // Working copy on trench branch
        {
            label: 'working-copy',
            parents: ['trench-2'],
            description: 'fix(targeting): use the force, Harry (turn off targeting computer)',
            files: {
                'src/tactics/targeting-override.ts': `export const FORCE_GUIDANCE = true;\n`,
            },
            isCurrentWorkingCopy: true,
        },
    ]);

    // Open active file in editor behind drag-drop view
    repo.writeFile(
        'src/spells/lightsaber-wand.ts',
        `/**
 * ⚡ Kyber Crystal Lightsaber Wand
 * Harmonic resonance frequency: 432 Hz
 */
export class LightsaberWand {
    readonly core = 'Phoenix Feather & Kyber Crystal';
    readonly bladeColor = 'Emerald Green';

    castExpelliarmus(): string {
        return 'Disarmed! An elegant weapon for a more civilized Jedi wizard.';
    }

    deflectBlasterBolt(spell: string): boolean {
        return spell === 'Protego' || spell === 'The Force';
    }
}
`,
    );

    const screenshotsDir = path.resolve('media/screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    const { page } = await vscode.openWorkspace(repo, {
        'jj-view.logTheme': 'dracula',
        'editor.fontSize': 13,
        'terminal.integrated.fontSize': 12,
        'chat.commandCenter.enabled': false,
        'chat.agent.enabled': false,
        'github.copilot.chat.enable': false,
        'workbench.secondarySideBar.location': 'hidden',
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await closeSecondarySidebar(vscode);

    await vscode.openFileInEditor(path.join(repo.path, 'src/spells/lightsaber-wand.ts'));
    await waitForTab(page, /lightsaber-wand\.ts/);
    await focusSCM(page);
    await focusJJLog(page);
    await ensureSidebarWide(page);
    await splitSCMPane(page);
    await focusDocument(page, vscode);

    const sourceRow = await waitForLogCommitRow(page, 'install holographic sorting hat protocol');
    const targetRow = await waitForLogCommitRow(page, 'seal thermal exhaust port with Protego Maxima');

    const sourceBox = await sourceRow.boundingBox();
    const targetBox = await targetRow.boundingBox();

    if (sourceBox && targetBox) {
        await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
        await page.keyboard.down('s');

        const webview = await getLogWebview(page);
        await expect(webview.locator('[data-drop-target], .active-modifier, kbd').first()).toBeVisible({
            timeout: 5000,
        });
        await page.waitForTimeout(600);

        await page.screenshot({ path: path.join(screenshotsDir, 'drag-drop.png') });

        await page.mouse.up();
        await page.keyboard.up('s');
        await page.waitForTimeout(500);
    }
});

/**
 * 3. Screenshot 3: commit-details.png (Commit Details Panel - Octopus Megamerge - Forest Theme, No Empty Commits)
 */
test('screenshot 3: commit-details', async ({ vscode }) => {
    test.setTimeout(60000);
    const repo = new TestRepo();
    repo.init();

    const nodes = await buildGraph(repo, [
        {
            label: 'initial',
            description: 'feat(core): initial Death Star defense infrastructure',
            tags: ['v1.0.0'],
            files: {
                'README.md': `# 🪄 Marauder's Holocron Defense Grid\n`,
                'package.json': JSON.stringify({ name: 'marauders-holocron', version: '1.0.0' }, null, 2),
                'src/defense/thermal-exhaust.ts': `/**
 * Thermal Exhaust Venting Subsystem v1.0
 */
export interface ExhaustVent {
    diameterMeters: number;
    rayShieldActive: boolean;
    enchantmentWard: string;
}

export const EXHAUST_PORT: ExhaustVent = {
    diameterMeters: 2.0,
    rayShieldActive: false,
    enchantmentWard: 'None',
};

export function canWithstandProtonTorpedo(): boolean {
    return EXHAUST_PORT.rayShieldActive;
}
`,
                'docs/security-audit.md': `# Security Audit Report\n\n- [ ] Thermal exhaust port unshielded.\n- [ ] Alohomora vulnerabilities.\n`,
            },
        },
        // Branch 1: Exhaust port security
        {
            label: 'feat-security',
            parents: ['initial'],
            description:
                'feat(security): seal thermal exhaust port against proton torpedoes\n\nEnsure 2-meter thermal exhaust port is ray-shielded with\nProtego Maxima enchantments and Alohomora-proofed wards.\nResolves critical Death Star vulnerability identified during Yavin tactical review.',
            bookmarks: ['feature/galactic-security'],
            tags: ['v2.0.0-holocron'],
            files: {
                'package.json': JSON.stringify({ name: 'marauders-holocron', version: '2.0.0' }, null, 2),
                'src/defense/thermal-exhaust.ts': `/**
 * Thermal Exhaust Venting Subsystem v2.0 (Reinforced)
 */
export interface ExhaustVent {
    diameterMeters: number;
    rayShieldActive: boolean;
    enchantmentWard: string;
}

export const EXHAUST_PORT: ExhaustVent = {
    diameterMeters: 2.0,
    rayShieldActive: true,
    enchantmentWard: 'Protego Maxima & Fianto Duri',
};

export function canWithstandProtonTorpedo(): boolean {
    console.log('Ray shielding active with ancient runic wards.');
    return EXHAUST_PORT.rayShieldActive;
}
`,
                'src/defense/warding-charms.ts': `export function castFiantoDuri(): string {
    return 'Fianto Duri barrier reinforced against proton torpedoes.';
}
`,
                'docs/security-audit.md': `# Security Audit Report\n\n- [x] Thermal exhaust port ray-shielded with Protego Maxima.\n- [x] Alohomora-proof wards installed.\n`,
            },
        },
        // Branch 2: Patronus grid
        {
            label: 'feat-patronus',
            parents: ['initial'],
            description: 'feat(shields): deploy Patronus Maxima anti-proton barrier',
            bookmarks: ['feature/patronus-grid'],
            files: {
                'src/spells/patronus-barrier.ts': `export const PATRONUS_BARRIER_GW = 200_000;\n`,
            },
        },
        // Branch 3: Lightsaber wand
        {
            label: 'feat-wand',
            parents: ['initial'],
            description: 'feat(spells): add Expelliarmus lightsaber disarming charm',
            bookmarks: ['feature/lightsaber-wand'],
            files: {
                'src/spells/lightsaber-wand.ts': `export const SPELL_CORE = 'Kyber Crystal';\n`,
            },
        },
        // Branch 4: Nimbus hyperdrive
        {
            label: 'feat-hyperdrive',
            parents: ['initial'],
            description: 'feat(engine): calibrate Nimbus 2000 warp drive',
            bookmarks: ['feature/nimbus-drive'],
            files: {
                'src/hyperdrive/nimbus.ts': `export const WARP_FACTOR = 9.8;\n`,
            },
        },
        // Branch 5: Astromech droid
        {
            label: 'feat-droid',
            parents: ['initial'],
            description: 'feat(droid): install R2-D2 holographic sorting hat protocol',
            bookmarks: ['feature/astromech-droid'],
            files: {
                'src/droid/astromech.ts': `export const ASTROMECH_CORE = 'R2-D2';\n`,
            },
        },
        // Octopus Megamerge (5 parents!)
        {
            label: 'megamerge-release',
            parents: ['feat-security', 'feat-patronus', 'feat-wand', 'feat-hyperdrive', 'feat-droid'],
            description: 'merge: integrate security, shields, wand spells, hyperdrive, and droid systems',
            bookmarks: ['main'],
            files: {
                'docs/unified-release.md': `# Unified Defense & Magic Architecture\n\nAll 5 tactical branches merged into production.\n`,
            },
        },
        {
            label: 'working-copy',
            parents: ['megamerge-release'],
            description: 'docs(briefing): add Yavin victory feast schedule',
            files: {
                'docs/victory-feast.md': `# Victory Celebration\nFeast starts at 20:00 in Great Hall.\n`,
            },
            isCurrentWorkingCopy: true,
        },
    ]);

    const screenshotsDir = path.resolve('media/screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    const { page } = await vscode.openWorkspace(repo, {
        'jj-view.logTheme': 'forest',
        'editor.fontSize': 13,
        'terminal.integrated.fontSize': 12,
        'chat.commandCenter.enabled': false,
        'chat.agent.enabled': false,
        'github.copilot.chat.enable': false,
        'workbench.secondarySideBar.location': 'hidden',
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await closeSecondarySidebar(vscode);

    await focusSCM(page);
    await focusJJLog(page);
    await ensureSidebarWide(page);
    await splitSCMPane(page);

    await vscode.executeCommand('jj-view.showDetails', nodes['feat-security'].changeId);
    await waitForTab(page, /^Commit:/);
    await focusDocument(page, vscode);
    await page.waitForTimeout(1000);

    await page.screenshot({ path: path.join(screenshotsDir, 'commit-details.png') });
});

/**
 * 4. Screenshot 4: multi-file-diff.png (Multi-File Diff Review - Multi-Branch Graph - Autumn Theme, No Empty Commits)
 */
test('screenshot 4: multi-file-diff', async ({ vscode }) => {
    test.setTimeout(60000);
    const repo = new TestRepo();
    repo.init();

    const nodes = await buildGraph(repo, [
        {
            label: 'initial',
            description: 'feat(core): initial mechanical targeting system',
            tags: ['v1.0.0'],
            files: {
                'config/targeting.json': JSON.stringify(
                    {
                        mode: 'mechanical_imperial',
                        targetLockRequired: true,
                        forceGuidance: false,
                    },
                    null,
                    2,
                ),
                'src/targeting/guidance-system.ts': `/**
 * Imperial Targeting Guidance Subsystem
 * Requires mechanical target locks before ordnance release.
 */

export interface TargetingState {
    mode: string;
    locked: boolean;
    computedTrajectory: string;
}

export class GuidanceSystem {
    private isLocked = false;

    lockCoordinates(x: number, y: number, z: number): boolean {
        console.log(\`Mechanical trajectory computed for [\${x}, \${y}, \${z}]\`);
        this.isLocked = true;
        return this.isLocked;
    }

    releaseTorpedoes(): string {
        if (!this.isLocked) {
            throw new Error('Release rejected: Mechanical target lock required.');
        }
        return 'Ordnance released along mechanical calculation path.';
    }

    getStatus(): string {
        return this.isLocked ? 'TARGET_LOCKED' : 'ACQUIRING';
    }
}
`,
                'docs/manual.md': `# Targeting Manual\n\nAlways follow mechanical guidance.\n`,
            },
        },
        {
            label: 'main-base',
            parents: ['initial'],
            description: 'feat(engine): warp drive telemetry calibration',
            bookmarks: ['main'],
            files: {
                'src/telemetry/warp.ts': `export const TELEMETRY_ONLINE = true;\n`,
            },
        },
        {
            label: 'refactor-targeting',
            parents: ['main-base'],
            description:
                'refactor(targeting): replace Imperial mechanical targeting with Jedi instinct\n\nTurn off the targeting computer during the trench run and trust the Force.',
            bookmarks: ['feature/jedi-targeting'],
            files: {
                'config/targeting.json': JSON.stringify(
                    {
                        mode: 'jedi_instinct',
                        targetLockRequired: false,
                        forceGuidance: true,
                    },
                    null,
                    2,
                ),
                'src/targeting/guidance-system.ts': `/**
 * Imperial Targeting Guidance Subsystem
 * Requires mechanical target locks before ordnance release.
 */

export interface TargetingState {
    mode: string;
    locked: boolean;
    computedTrajectory: string;
}

export class GuidanceSystem {
    private isLocked = false;
    private useTheForce = true;

    lockCoordinates(x: number, y: number, z: number): boolean {
        // Obi-Wan & Dumbledore: "Turn off your targeting computer, Harry!"
        console.warn('Targeting computer switch: OFF. Trusting the Force.');
        this.isLocked = false;
        return true;
    }

    releaseTorpedoes(): string {
        if (this.useTheForce) {
            return 'Proton torpedoes curved into the exhaust port via the Force! 🌟';
        }
        return 'Ordnance released along mechanical calculation path.';
    }

    getStatus(): string {
        return this.useTheForce ? 'THE_FORCE_IS_WITH_YOU' : 'ACQUIRING';
    }
}
`,
                'src/spells/force-charms.ts': `export function invokeForceGuidance(): string {
    return 'The Force will be with you. Always, Harry.';
}
`,
            },
        },
        {
            label: 'feat-hud',
            parents: ['refactor-targeting'],
            description: 'feat(hud): render holographic trench run crosshairs',
            bookmarks: ['feature/hud-crosshairs'],
            files: {
                'src/hud/crosshairs.ts': `export const HUD_CROSSHAIRS = 'holographic';\n`,
            },
        },
        {
            label: 'feat-wand',
            parents: ['main-base'],
            description: 'feat(spells): add Expelliarmus lightsaber disarming charm',
            bookmarks: ['feature/lightsaber-wand'],
            files: {
                'src/spells/wand.ts': `export const WAND_SPELL = 'Expelliarmus';\n`,
            },
        },
        {
            label: 'docs-map',
            parents: ['main-base'],
            description: 'docs: update galactic star chart and flight paths',
            bookmarks: ['docs/star-map'],
            files: {
                'docs/star-map.md': `# Star Map\nFlight coordinates.\n`,
            },
        },
        {
            label: 'working-copy',
            parents: ['feat-hud'],
            description: 'docs: update trench run mission debrief',
            files: {
                'docs/mission-debrief.md': `# Mission Debrief\nExhaust port destroyed.\n`,
            },
            isCurrentWorkingCopy: true,
        },
    ]);

    const screenshotsDir = path.resolve('media/screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    const { page } = await vscode.openWorkspace(repo, {
        'jj-view.logTheme': 'autumn',
        'editor.fontSize': 13,
        'terminal.integrated.fontSize': 12,
        'chat.commandCenter.enabled': false,
        'chat.agent.enabled': false,
        'github.copilot.chat.enable': false,
        'workbench.secondarySideBar.location': 'hidden',
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await closeSecondarySidebar(vscode);

    await focusSCM(page);
    await focusJJLog(page);
    await ensureSidebarWide(page);
    await splitSCMPane(page);

    await vscode.executeCommand('jj-view.showMultiFileDiff', nodes['refactor-targeting'].changeId);
    await waitForTab(page, /refactor\(targeting\)|3 files/i);
    await focusDocument(page, vscode);
    await page.waitForTimeout(1000);

    await page.screenshot({ path: path.join(screenshotsDir, 'multi-file-diff.png') });
});
