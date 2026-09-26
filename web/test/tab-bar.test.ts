/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import TabBar from '../src/tabs/TabBar.svelte';
import type { TabEntry } from '../src/tabs/tab-types';

describe('TabBar Component (SSR & Rendering)', () => {
    const mockTabs: TabEntry[] = [
        {
            id: 'tab-1',
            title: 'file1.txt',
            tooltip: '/path/to/file1.txt',
            iconClass: 'codicon codicon-diff',
            preview: false,
            isDirty: false,
            view: {
                type: 'diff',
                title: 'file1.txt',
            },
        },
        {
            id: 'tab-2',
            title: 'file2.txt',
            tooltip: '/path/to/file2.txt',
            iconClass: 'codicon codicon-file',
            preview: true,
            isDirty: false,
            view: {
                type: 'diff',
                title: 'file2.txt',
            },
        },
        {
            id: 'tab-3',
            title: 'file3.txt',
            tooltip: '/path/to/file3.txt',
            iconClass: 'codicon codicon-diff',
            preview: false,
            isDirty: true,
            view: {
                type: 'diff',
                title: 'file3.txt',
            },
        },
    ];

    it('renders all tabs with accessible attributes', () => {
        const result = render(TabBar, {
            props: {
                tabs: mockTabs,
                activeTabId: 'tab-1',
                onSelectTab: vi.fn(),
                onCloseTab: vi.fn(),
                onPinTab: vi.fn(),
                onReorderTabs: vi.fn(),
            },
        });
        const html = result.body;

        expect(html).toContain('role="tablist"');
        expect(html).toContain('data-testid="tab-tab-1"');
        expect(html).toContain('data-testid="tab-tab-2"');
        expect(html).toContain('data-testid="tab-tab-3"');
        expect(html).toContain('file1.txt');
        expect(html).toContain('file2.txt');
        expect(html).toContain('file3.txt');
    });

    it('applies active class and aria-selected to the active tab', () => {
        const result = render(TabBar, {
            props: {
                tabs: mockTabs,
                activeTabId: 'tab-1',
                onSelectTab: vi.fn(),
                onCloseTab: vi.fn(),
                onPinTab: vi.fn(),
                onReorderTabs: vi.fn(),
            },
        });
        const html = result.body;

        expect(html).toContain('data-testid="tab-tab-1"');
        // Tab 1 should be active
        expect(html).toMatch(/class="[^"]*active[^"]*"[^>]*data-testid="tab-tab-1"/);
        expect(html).toMatch(/data-testid="tab-tab-1"[^>]*aria-selected="true"/);

        // Tab 2 should not be active
        expect(html).not.toMatch(/class="[^"]*active[^"]*"[^>]*data-testid="tab-tab-2"/);
        expect(html).toMatch(/data-testid="tab-tab-2"[^>]*aria-selected="false"/);
    });

    it('applies preview class (italic title) to preview tabs', () => {
        const result = render(TabBar, {
            props: {
                tabs: mockTabs,
                activeTabId: 'tab-2',
                onSelectTab: vi.fn(),
                onCloseTab: vi.fn(),
                onPinTab: vi.fn(),
                onReorderTabs: vi.fn(),
            },
        });
        const html = result.body;

        // Tab 2 has preview: true
        expect(html).toMatch(/class="[^"]*preview[^"]*"[^>]*data-testid="tab-tab-2"/);
        // Tab 1 has preview: false
        expect(html).not.toMatch(/class="[^"]*preview[^"]*"[^>]*data-testid="tab-tab-1"/);
    });

    it('renders dirty indicator dot and accessible unsaved changes label on dirty tabs', () => {
        const result = render(TabBar, {
            props: {
                tabs: mockTabs,
                activeTabId: 'tab-3',
                onSelectTab: vi.fn(),
                onCloseTab: vi.fn(),
                onPinTab: vi.fn(),
                onReorderTabs: vi.fn(),
            },
        });
        const html = result.body;

        // Tab 3 has isDirty: true
        expect(html).toMatch(/class="[^"]*dirty[^"]*"[^>]*data-testid="tab-tab-3"/);
        expect(html).toContain('Unsaved changes in file3.txt');
        expect(html).toContain('●');
    });

    it('renders cleanly with zero tabs', () => {
        const result = render(TabBar, {
            props: {
                tabs: [],
                activeTabId: undefined,
                onSelectTab: vi.fn(),
                onCloseTab: vi.fn(),
                onPinTab: vi.fn(),
                onReorderTabs: vi.fn(),
            },
        });
        const html = result.body;

        expect(html).toContain('data-testid="tab-bar-container"');
        expect(html).not.toContain('role="tab"');
    });
});
