/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { _electron as electron } from 'playwright';
import { test } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TestRepo, buildGraph } from '../test-repo';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

/**
 * Playwright test to generate high-quality screenshots for the README.
 * Sets up a demo repo with "witty" commit history, forces a dark theme,
 * adjusts the layout (wider sidebar, taller log view), and captures the SCM view.
 */
test('generate screenshots', async () => {
    // 1. Setup Demo Repo
    const repo = new TestRepo();
    repo.init();

    await buildGraph(repo, [
        { 
            label: 'initial', 
            description: 'Initial commit: Add README', 
            files: { 'README.md': '# My Project\n' } 
        },
        { 
            label: 'feat-core', 
            parents: ['initial'], 
            description: 'feat: Add core logic', 
            files: { 'main.ts': "console.log('Hello World');" },
            bookmarks: ['main']
        },
        { 
            label: 'feat-utils', 
            parents: ['feat-core'], 
            description: 'feat: Add utils', 
            files: { 'utils.ts': 'export const add = (a, b) => a + b;' },
            bookmarks: ['feature-showcase']
        },
        {
            label: 'docs-update',
            parents: ['feat-core'],
            description: 'docs: Update README',
            files: { 'README.md': '# My Awesome Project\nThis is a demo project.\n' }
        },
        {
            label: 'conflict-base',
            parents: ['feat-core'],
            description: 'feat: Base for conflict',
            files: { 'file.txt': 'base content' }
        },
        {
            label: 'conflict-side-1',
            parents: ['conflict-base'],
            description: 'feat: dark mode preference',
            files: { 'file.txt': 'content 1' }
        },
        {
            label: 'conflict-side-2',
            parents: ['conflict-base'],
            description: 'feat: light theme support',
            files: { 'file.txt': 'content 2' }
        },
        {
            label: 'merge-conflict',
            parents: ['conflict-side-1', 'conflict-side-2'],
            description: 'Merge: resolve theme conflict',
            isWorkingCopy: false
        },
        {
            label: 'working-copy',
            parents: ['merge-conflict'],
            description: 'refactor: polish joke delivery',
            isWorkingCopy: true
        }
    ]);

    // 1b. Configure User Settings (Global) to ensure they apply regardless of workspace trust
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-test-user-data-'));
    const userSettingsDir = path.join(userDataDir, 'User');
    fs.mkdirSync(userSettingsDir, { recursive: true });
    
    fs.writeFileSync(path.join(userSettingsDir, 'settings.json'), JSON.stringify({
        "git.enabled": false,
        "workbench.colorTheme": "Default Dark+",
        "workbench.startupEditor": "none",
        "workbench.sideBar.location": "left",
        "scm.alwaysShowProviders": true, // We want providers visible so we can resize them
        "scm.alwaysShowActions": true,
        "workbench.tips.enabled": false,
        "window.titleBarStyle": "custom",
        "python.defaultInterpreterPath": "/usr/bin/python3",
        "security.workspace.trust.enabled": false // Disable trust prompt
    }, null, 2));

    // 1c. Create Easter Egg File
    repo.writeFile('joke.py', `def tell_joke():
    print("Why do programmers prefer dark mode?")
    print("Because light attracts bugs!")

if __name__ == "__main__":
    tell_joke()
`);
    
    console.log(`Demo repo created at: ${repo.path}`);

    // 2. Launch VS Code
    const extensionPath = path.resolve(__dirname, '../../../');
    const vscodePath = await downloadAndUnzipVSCode();
    const executablePath = vscodePath; 
    
    // Launch with strict isolation
    const app = await electron.launch({
        executablePath,
        args: [
            repo.path,
            path.join(repo.path, 'joke.py'), 
            `--extensionDevelopmentPath=${extensionPath}`,
            `--user-data-dir=${userDataDir}`,
            '--disable-workspace-trust', // Keep this to suppress trust dialog, but settings are now satisfied by User settings
            '--new-window',
            '--skip-welcome',
            '--skip-release-notes'
        ]
    });

    const page = await app.firstWindow();
    
    // 3. Wait for activation and views to load
    await page.waitForTimeout(5000); 

    // 3b. FORCE THEME via Command Palette
    console.log('Forcing Theme to Default Dark+...');
    await page.keyboard.press('F1');
    await page.keyboard.type('Preferences: Color Theme');
    await page.waitForTimeout(2000); // Wait for results
    
    // Select the "Preferences: Color Theme" command
    try {
        const commandOption = page.locator('.quick-input-list .monaco-list-row')
            .filter({ hasText: 'Preferences: Color Theme' })
            .filter({ hasNotText: 'Install' }) 
            .filter({ hasNotText: 'JSON' }) 
            .first();
            
        if (await commandOption.isVisible()) {
            await commandOption.click();
        } else {
            await page.locator('.quick-input-list .monaco-list-row').nth(1).click();
        }
    } catch (e) {
        console.log('Error selecting command:', e);
        await page.keyboard.press('Enter');
    }
    
    await page.waitForTimeout(1000); // Wait for picker to open
    
    // Type specific name
    await page.keyboard.type('Default Dark+');
    await page.waitForTimeout(1000);
    
    // Select "Default Dark+" 
    try {
        const themeOption = page.locator('.quick-input-list .monaco-list-row')
            .filter({ hasText: 'Default Dark+' }) 
            .filter({ hasNotText: 'Browse' }) 
            .filter({ hasNotText: 'Install' })
            .first();
            
        if (await themeOption.isVisible()) {
            await themeOption.click();
        } else {
            await page.keyboard.press('Enter');
        }
    } catch (error) {
        console.log('Error selecting theme:', error);
        await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(2000);

    // 3c. Resize Sidebar (Wider SCM Pane)
    try {
        const sashes = page.locator('.monaco-sash.vertical');
        const count = await sashes.count();
        
        let startX = 0;
        let startY = 0;

        for (let i = 0; i < count; i++) {
            const sash = sashes.nth(i);
            const box = await sash.boundingBox();
            // Assume sidebar sash is the one > 100px (avoiding Activity Bar)
            if (box && box.x > 100) { 
                startX = box.x + (box.width / 2);
                startY = box.y + (box.height / 2);
                break;
            }
        }

        if (startX > 0) {
            await page.mouse.move(startX, startY);
            await page.mouse.down();
            await page.mouse.move(startX + 200, startY, { steps: 10 }); 
            await page.mouse.up();
            await page.waitForTimeout(500);
        }
    } catch (e) {
        console.log('Error resizing sidebar:', e);
    }

    // 4. Switch to SCM View
    await page.keyboard.press('Control+Shift+G');
    await page.waitForTimeout(2000);

    // 5. Layout Adjustment: Maximize JJ Log View
    try {
        const logPaneHeader = page.locator('.pane-header', { hasText: 'JJ Log' });
        
        if (await logPaneHeader.count() > 0) {
            const isExpanded = await logPaneHeader.getAttribute('aria-expanded');
            if (isExpanded !== 'true') {
                await logPaneHeader.click();
                await page.waitForTimeout(1000);
            }
            
            const box = await logPaneHeader.boundingBox();
            if (box) {
                // Drag sash above header to resize
                const sashY = box.y - 2; 
                const centerX = box.x + (box.width / 2);

                await page.mouse.move(centerX, sashY);
                await page.mouse.down();
                await page.mouse.move(centerX, 500, { steps: 10 });
                await page.mouse.up();
                await page.waitForTimeout(1000);
            }
        }
    } catch (e) {
        console.log('Error resizing JJ Log:', e);
    }

    // 6. Close Secondary Side Bar
    await page.keyboard.press('F1');
    await page.keyboard.type('View: Close Secondary Side Bar');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // 7. Open Joke File
    await page.keyboard.press('Control+P');
    await page.keyboard.type('joke.py');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    // 8. Capture Screenshot
    console.log('Capturing scm-view.png...');
    await page.screenshot({ path: 'media/screenshots/scm-view.png' });

    console.log('Screenshots captured.');
    
    await app.close();
    
    // Cleanup User Data
    try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch { }
});
