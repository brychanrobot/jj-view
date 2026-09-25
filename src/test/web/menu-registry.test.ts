/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ContextKeyService } from '../../web/menu/context-key-service';
import { MenuRegistry, parseMenuGroup, resolveIconClass } from '../../web/menu/menu-registry';

describe('ContextKeyService', () => {
    it('sets, gets, and deletes keys', () => {
        const service = new ContextKeyService();
        service.set('jj.parentMutable', true);
        expect(service.get('jj.parentMutable')).toBe(true);
        expect(service.get('unknown.key')).toBeUndefined();

        service.delete('jj.parentMutable');
        expect(service.get('jj.parentMutable')).toBeUndefined();
    });

    it('inherits parent keys in scoped child service', () => {
        const parent = new ContextKeyService();
        parent.set('theme', 'dark');
        parent.set('repoRoot', '/mock/repo');

        const child = parent.createScoped({ scmResourceState: 'jj.resource.allowOpen' });

        expect(child.get('theme')).toBe('dark');
        expect(child.get('repoRoot')).toBe('/mock/repo');
        expect(child.get('scmResourceState')).toBe('jj.resource.allowOpen');
        expect(parent.get('scmResourceState')).toBeUndefined();
    });

    it('overrides parent key locally in scoped child without altering parent', () => {
        const parent = new ContextKeyService();
        parent.set('openDiffOnClick', true);

        const child = parent.createScoped({ openDiffOnClick: false });
        expect(child.get('openDiffOnClick')).toBe(false);
        expect(parent.get('openDiffOnClick')).toBe(true);
    });

    it('fires onDidChangeContext event on key changes', () => {
        const parent = new ContextKeyService();
        const child = parent.createScoped();

        let parentFired = 0;
        let childFired = 0;

        parent.onDidChangeContext(() => {
            parentFired++;
        });
        child.onDidChangeContext(() => {
            childFired++;
        });

        parent.set('key1', 'val1');
        expect(parentFired).toBe(1);
        expect(childFired).toBe(1);

        child.set('localKey', 'localVal');
        expect(parentFired).toBe(1);
        expect(childFired).toBe(2);
    });
});

describe('MenuRegistry & Icon Resolution', () => {
    it('resolves standard and custom codicon classes', () => {
        expect(resolveIconClass('$(plus)')).toBe('codicon codicon-plus');
        expect(resolveIconClass('$(check)')).toBe('codicon codicon-check');
        expect(resolveIconClass('$(jj-icon-squash-into)')).toBe('codicon jj-icon-squash-into');
        expect(resolveIconClass(undefined)).toBeUndefined();
    });

    it('parses group string with order and inline detection', () => {
        expect(parseMenuGroup('inline@3')).toEqual({
            groupName: 'inline',
            order: 3,
            isInline: true,
        });
        expect(parseMenuGroup('navigation@1')).toEqual({
            groupName: 'navigation',
            order: 1,
            isInline: true,
        });
        expect(parseMenuGroup('1_diff@2')).toEqual({
            groupName: '1_diff',
            order: 2,
            isInline: false,
        });
        expect(parseMenuGroup('')).toEqual({
            groupName: 'default',
            order: 0,
            isInline: false,
        });
    });

    it('resolves scm/title inline actions filtered by context keys', () => {
        const registry = new MenuRegistry();
        const context = new ContextKeyService();

        // Default state: scmProviderCount is 1, so focusRepository should not be visible
        let actions = registry.getInlineActions('scm/title', context);
        let commands = actions.map((a) => a.command);
        expect(commands).toContain('jj-view.new');
        expect(commands).toContain('jj-view.setDescription');
        expect(commands).toContain('jj-view.commit');
        expect(commands).toContain('jj-view.refresh');
        expect(commands).not.toContain('jj-view.focusRepository');

        // With multiple providers: focusRepository becomes visible
        context.set('scmProvider', 'jj');
        context.set('scm.providerCount', 2);
        actions = registry.getInlineActions('scm/title', context);
        commands = actions.map((a) => a.command);
        expect(commands).toContain('jj-view.focusRepository');
    });

    it('resolves scm/resourceGroup/context inline actions matching capability flags', () => {
        const registry = new MenuRegistry();
        const rootContext = new ContextKeyService();

        // Working Copy group with allowShowMultiFileDiff, allowAbandon, allowSquash
        const wcContext = rootContext.createScoped({
            scmResourceGroupState:
                'jj.group.workingCopy jj.group.allowShowMultiFileDiff jj.group.allowAbandon jj.group.allowSquash',
        });

        const actions = registry.getInlineActions('scm/resourceGroup/context', wcContext);
        const commands = actions.map((a) => a.command);

        expect(commands).toContain('jj-view.showMultiFileDiff');
        expect(commands).toContain('jj-view.abandon');
        expect(commands).toContain('jj-view.squashRevisionIntoAncestor');
        expect(commands).toContain('jj-view.squashRevisionIntoParent');
        expect(commands).not.toContain('jj-view.absorb');
        expect(commands).not.toContain('jj-view.edit');

        // Verify order
        const diffIdx = commands.indexOf('jj-view.showMultiFileDiff');
        const abandonIdx = commands.indexOf('jj-view.abandon');
        const squashParentIdx = commands.indexOf('jj-view.squashRevisionIntoParent');
        expect(diffIdx).toBeLessThan(abandonIdx);
        expect(abandonIdx).toBeLessThan(squashParentIdx);
    });

    it('resolves scm/resourceState/context actions toggling openFile and openChanges based on openDiffOnClick', () => {
        const registry = new MenuRegistry();
        const rootContext = new ContextKeyService();

        // Case A: openDiffOnClick is true
        rootContext.set('jj.openDiffOnClick', true);
        const itemContextA = rootContext.createScoped({
            scmResourceState: 'jj.resource.allowOpen jj.resource.allowRestore jj.resource.allowSquashIntoParent',
        });

        let actions = registry.getInlineActions('scm/resourceState/context', itemContextA);
        let commands = actions.map((a) => a.command);

        // When openDiffOnClick is true, inline button is "Open File in Working Copy" (since click already opens diff)
        expect(commands).toContain('jj-view.openFile');
        expect(commands).not.toContain('jj-view.openChanges');
        expect(commands).toContain('jj-view.restore');
        expect(commands).toContain('jj-view.squashFilesIntoParent');

        // Case B: openDiffOnClick is false
        rootContext.set('jj.openDiffOnClick', false);
        const itemContextB = rootContext.createScoped({
            scmResourceState: 'jj.resource.allowOpen jj.resource.allowRestore jj.resource.allowSquashIntoParent',
        });

        actions = registry.getInlineActions('scm/resourceState/context', itemContextB);
        commands = actions.map((a) => a.command);

        // When openDiffOnClick is false, inline button is "Open Changes" (diff)
        expect(commands).toContain('jj-view.openChanges');
        expect(commands).not.toContain('jj-view.openFile');
        expect(commands).toContain('jj-view.restore');
    });

    it('resolves context menu groups with getContextActions', () => {
        const registry = new MenuRegistry();
        const rootContext = new ContextKeyService();
        rootContext.set('jj.openDiffOnClick', true);
        const itemContext = rootContext.createScoped({
            scmResourceState: 'jj.resource.allowOpen jj.resource.allowRestore jj.resource.allowSquashIntoParent',
        });

        const groups = registry.getContextActions('scm/resourceState/context', itemContext);
        expect(groups.length).toBeGreaterThan(0);
        const allCommands = groups.flatMap((g) => g.items.map((i) => i.command));
        expect(allCommands).toContain('jj-view.openFile');
        expect(allCommands).toContain('jj-view.restore');
        expect(allCommands).toContain('jj-view.squashFilesIntoParent');
    });
});
