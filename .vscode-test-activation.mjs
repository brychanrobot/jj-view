import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-test-activation-user-data-'));
const userDir = path.join(tmpDir, 'User');
const workspaceDir = path.join(tmpDir, 'workspace');
fs.mkdirSync(userDir, { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });

// Write settings to disable git
fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({
    "git.enabled": false,
    "git.path": null,
    "git.autoRepositoryDetection": false
}, null, 4));

export default defineConfig({
    files: 'out/test/extension.integration.test.js',
    mocha: {
        timeout: 20000,
        require: ['./out/test/global-teardown.js'],
    },
    launchArgs: [
        '--disable-extensions',
        '--disable-extension', 'vscode.git',
        '--user-data-dir', tmpDir,
        workspaceDir // Use dedicated workspace directory
    ],
});
