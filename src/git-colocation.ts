/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { JjService } from './jj-service';

/** Checks if the repository is git-colocated and prompts the user to disable the Git extension if necessary. */
export async function checkGitColocation(jj: JjService): Promise<void> {
    const gitRoot = await jj.getGitRoot();
    if (!gitRoot) {
        return; // Not git-backed
    }

    const repoRoot = await jj.getRepoRoot();

    // Normalize paths to compare. A colocated repo has its .git dir at the repo root.
    const isColocated = path.normalize(gitRoot) === path.normalize(path.join(repoRoot, '.git'));
    if (!isColocated) {
        return;
    }

    const gitConfig = vscode.workspace.getConfiguration('git');
    const isGitEnabled = gitConfig.get<boolean>('enabled') !== false;
    const isGitExtensionPresent = !!vscode.extensions.getExtension('vscode.git');

    if (!isGitEnabled || !isGitExtensionPresent) {
        return;
    }

    const jjViewConfig = vscode.workspace.getConfiguration('jj-view');
    const isSuppressed = jjViewConfig.get<boolean>('suppressGitColocationWarning') === true;

    if (isSuppressed) {
        return;
    }

    const disableAction = 'Disable Git Extension';
    const ignoreAction = "Don't Show Again";
    const result = await vscode.window.showInformationMessage(
        'Colocated Jujutsu and Git repository detected. We recommend disabling the built-in Git extension to avoid conflicting source control views.',
        disableAction,
        ignoreAction,
    );

    if (result === disableAction) {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'git.enabled');
    } else if (result === ignoreAction) {
        await jjViewConfig.update('suppressGitColocationWarning', true, vscode.ConfigurationTarget.Global);
    }
}
