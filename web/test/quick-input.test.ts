/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { HostFs } from '../../src/core/host/host-system';
import type { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import { createMock } from '../../src/test/test-utils';
import { WebHostEnvironment, WebHostUi } from '../src/host/web-host-environment';
import QuickInput from '../src/quick-input/QuickInput.svelte';
import { QuickInputService } from '../src/quick-input/quick-input-service';

describe('QuickInputService', () => {
    it('manages input-box session lifecycle and accepts value', async () => {
        const service = new QuickInputService();
        expect(service.activeSession).toBeNull();

        const promise = service.showInputBox({
            title: 'Commit Message',
            prompt: 'Enter your commit description',
            value: 'Initial value',
        });

        expect(service.activeSession).not.toBeNull();
        expect(service.activeSession?.type).toBe('input-box');
        if (service.activeSession?.type === 'input-box') {
            expect(service.activeSession.options.title).toBe('Commit Message');
            expect(service.activeSession.options.value).toBe('Initial value');
        }

        service.accept('My new description');
        const result = await promise;
        expect(result).toBe('My new description');
        expect(service.activeSession).toBeNull();
    });

    it('cancels input-box session and returns undefined', async () => {
        const service = new QuickInputService();
        const promise = service.showInputBox({ title: 'Prompt' });

        service.cancel();
        const result = await promise;
        expect(result).toBeUndefined();
        expect(service.activeSession).toBeNull();
    });

    it('manages quick-pick session lifecycle and accepts selected item', async () => {
        const service = new QuickInputService();
        const items = [
            { label: 'Option 1', value: 'opt-1', description: 'First' },
            { label: 'Option 2', value: 'opt-2', description: 'Second' },
        ];

        const promise = service.showQuickPick(items, {
            title: 'Select an Option',
            placeHolder: 'Filter options...',
        });

        expect(service.activeSession).not.toBeNull();
        expect(service.activeSession?.type).toBe('quick-pick');
        if (service.activeSession?.type === 'quick-pick') {
            expect(service.activeSession.options.items.length).toBe(2);
            expect(service.activeSession.options.items[0].label).toBe('Option 1');
        }

        const chosen =
            service.activeSession?.type === 'quick-pick' ? service.activeSession.options.items[1] : undefined;
        expect(chosen).toBeDefined();
        service.accept(chosen);

        const result = await promise;
        expect(result).toEqual(items[1]);
        expect(service.activeSession).toBeNull();
    });

    it('manages multi-quick-pick session lifecycle and accepts selected list', async () => {
        const service = new QuickInputService();
        const items = [
            { label: 'Item A', value: 'a' },
            { label: 'Item B', value: 'b' },
            { label: 'Item C', value: 'c' },
        ];

        const promise = service.showMultiQuickPick(items, { title: 'Pick Multiple' });
        expect(service.activeSession?.type).toBe('multi-quick-pick');

        const chosen =
            service.activeSession?.type === 'multi-quick-pick'
                ? [service.activeSession.options.items[0], service.activeSession.options.items[2]]
                : [];
        service.accept(chosen);

        const result = await promise;
        expect(result).toEqual([items[0], items[2]]);
        expect(service.activeSession).toBeNull();
    });

    it('sorts and presents commands in openCommandPalette and triggers execution callback', async () => {
        const service = new QuickInputService();
        const executed: string[] = [];

        const onExecute = vi.fn((cmdId: string) => {
            executed.push(cmdId);
        });

        const promise = service.openCommandPalette(
            [
                { id: 'jj-view.commit', title: 'Commit', category: 'JJ View' },
                { id: 'workbench.action.openSettings', title: 'Open Settings', category: 'Preferences' },
                { id: 'jj-view.new', title: 'New', category: 'JJ View' },
            ],
            onExecute,
        );

        expect(service.activeSession?.type).toBe('quick-pick');
        if (service.activeSession?.type === 'quick-pick') {
            const list = service.activeSession.options.items;
            expect(list.length).toBe(3);
            // Commands with category 'JJ View' omit the prefix and sort by display label
            expect(list[0].label).toBe('Commit');
            expect(list[0].description).toBeUndefined();
            expect(list[1].label).toBe('New');
            expect(list[1].description).toBeUndefined();
            expect(list[2].label).toBe('Preferences: Open Settings');
            expect(list[2].description).toBeUndefined();

            // Pick the settings command
            service.accept(list[2]);
        }

        await promise;
        expect(onExecute).toHaveBeenCalledWith('workbench.action.openSettings');
        expect(executed).toEqual(['workbench.action.openSettings']);
    });

    it('cancels previous session when a new session is started', async () => {
        const service = new QuickInputService();
        const firstPromise = service.showInputBox({ title: 'First' });
        const secondPromise = service.showInputBox({ title: 'Second' });

        const firstResult = await firstPromise;
        expect(firstResult).toBeUndefined();

        service.accept('Second result');
        const secondResult = await secondPromise;
        expect(secondResult).toBe('Second result');
    });
});

describe('WebHostUi Integration with QuickInputService', () => {
    it('delegates showInputBox and showQuickPick to quickInputService when configured', async () => {
        const quickInput = new QuickInputService();
        const ui = new WebHostUi(quickInput);

        const inputPromise = ui.showInputBox({ prompt: 'Enter name', value: 'jj-view' });
        expect(quickInput.activeSession?.type).toBe('input-box');
        quickInput.accept('my-name');
        expect(await inputPromise).toBe('my-name');

        const pickPromise = ui.showQuickPick([
            { label: 'Alpha', value: '1' },
            { label: 'Beta', value: '2' },
        ]);
        expect(quickInput.activeSession?.type).toBe('quick-pick');
        if (quickInput.activeSession?.type === 'quick-pick') {
            quickInput.accept(quickInput.activeSession.options.items[0]);
        }
        expect(await pickPromise).toEqual({ label: 'Alpha', value: '1' });
    });

    it('injects quickInput into WebHostEnvironment and connects ui', () => {
        const mockRemoteHost = createMock<RemoteHostSystem>({
            fs: createMock<HostFs>({
                readTextFile: vi.fn(),
                writeTextFile: vi.fn(),
            }),
            platform: 'linux',
            isConnected: true,
        });

        const env = new WebHostEnvironment(mockRemoteHost, '/test/repo');
        expect(env.quickInput).toBeInstanceOf(QuickInputService);
        expect(env.ui).toBeInstanceOf(WebHostUi);
    });
});

describe('QuickInput SSR Component Rendering', () => {
    it('renders empty when no session is active', () => {
        const service = new QuickInputService();
        const rendered = render(QuickInput, {
            props: { service },
        });

        expect(rendered.html).not.toContain('quick-input-widget');
        expect(rendered.html).not.toContain('quick-input-backdrop');
    });

    it('renders input box widget when input-box session is active', () => {
        const service = new QuickInputService();
        void service.showInputBox({
            title: 'Set Revision Description',
            prompt: 'Enter commit message...',
            value: 'feat: add quick input',
            placeHolder: 'Type here...',
        });

        const rendered = render(QuickInput, {
            props: { service },
        });

        expect(rendered.html).toContain('quick-input-widget');
        expect(rendered.html).toContain('Set Revision Description');
        expect(rendered.html).toContain('Enter commit message...');
        expect(rendered.html).toContain('feat: add quick input');
    });

    it('renders quick pick list when quick-pick session is active', () => {
        const service = new QuickInputService();
        void service.showQuickPick(
            [
                { label: 'First Command', description: 'jj-view.first', iconClass: 'codicon codicon-check' },
                { label: 'Second Command', description: 'jj-view.second' },
            ],
            {
                title: 'Command Palette',
                placeHolder: 'Type command...',
            },
        );

        const rendered = render(QuickInput, {
            props: { service },
        });

        expect(rendered.html).toContain('quick-input-widget');
        expect(rendered.html).toContain('Command Palette');
        expect(rendered.html).toContain('First Command');
        expect(rendered.html).toContain('Second Command');
        expect(rendered.html).toContain('jj-view.first');
        expect(rendered.html).toContain('codicon-check');
    });
});
