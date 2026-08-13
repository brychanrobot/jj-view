/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandContext } from '../common/command-context';
import { Uri } from '../uri-utils';
import { getJjViewConfig } from '../utils/config-utils';
import { getErrorMessage } from './command-utils';

export async function workspaceAddCommand(ctx: CommandContext): Promise<void> {
    const { jj } = ctx.repo;
    try {
        // 1. Find main workspace root
        const mainRoot = await jj.getMainWorkspaceRoot();

        // 2. Get workspaces location from config
        let workspacesLocation = getJjViewConfig<string>('workspacesLocation', '.workspaces') ?? '.workspaces';

        // Resolve relative paths against the main repo root
        if (!path.isAbsolute(workspacesLocation)) {
            workspacesLocation = path.resolve(mainRoot, workspacesLocation);
        }

        // 3. Prompt for workspace name
        const workspaceName = await ctx.ui.showInputBox({
            prompt: 'Enter a name for the new workspace',
            placeHolder: 'e.g. my-feature',
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Workspace name is required';
                }
                if (/[<>:"/\\|?*]/.test(value)) {
                    return 'Workspace name contains invalid characters';
                }
                return null;
            },
        });

        if (!workspaceName) {
            return;
        }

        const destination = path.join(workspacesLocation, workspaceName);

        // 4. Run jj workspace add
        await ctx.ui.withProgress(`Creating workspace "${workspaceName}"...`, async () => {
            // Ensure the parent directory (workspacesLocation) exists
            await fs.promises.mkdir(workspacesLocation, { recursive: true });
            await jj.workspaceAdd(destination, workspaceName);
        });

        await ctx.repo.refresh();

        // 5. Success notification with "Open" action
        const OPEN = 'Open Workspace';
        const result = await ctx.ui.showInformation(`Workspace "${workspaceName}" created successfully.`, OPEN);

        if (result === OPEN) {
            const uri = Uri.file(destination);
            await ctx.nav.openFolder(uri, true);
        }
    } catch (e) {
        const message = getErrorMessage(e);
        await ctx.ui.showError(new Error(`Failed to create workspace: ${message}`), 'Workspace Add Error');
    }
}
