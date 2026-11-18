/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { LogViewPayload } from '../core/host/ipc/log-view-schemas';
import type { JjLogEntry } from '../core/jj-types';
import LogApp from '../core/webview/log/LogApp.svelte';
import { createMock } from './test-utils';

function createSampleCommit(overrides: Partial<JjLogEntry> = {}): JjLogEntry {
    return createMock<JjLogEntry>({
        change_id: 'krsyowswxmxnqznrtlpuyutskyzrpunp',
        change_id_shortest: 'krsy',
        commit_id: 'abcdef1234567890abcdef1234567890abcdef12',
        description: 'feat: render log graph commit',
        is_immutable: false,
        is_empty: false,
        is_current_working_copy: true,
        conflict: false,
        bookmarks: [],
        tags: [],
        parents: [],
        ...overrides,
    });
}

describe('LogApp SSR Rendering', () => {
    it('renders loading state when no initialState prop is provided', () => {
        const result = render(LogApp);
        expect(result.body).toContain('loading-state');
        expect(result.body).toContain('Loading changes...');
        expect(result.body).not.toContain('log-no-repo-state');
        expect(result.body).not.toContain('log-error-state');
    });

    it('renders no-repo empty state when hasRepository is false', () => {
        const initialState: LogViewPayload = {
            commits: [],
            hasRepository: false,
        };
        const result = render(LogApp, { props: { initialState } });

        expect(result.body).toContain('status-scroll-container');
        expect(result.body).toContain('data-testid="log-no-repo-state"');
        expect(result.body).toContain('No Jujutsu repository found in this workspace.');
        expect(result.body).not.toContain('Loading changes...');
        expect(result.body).not.toContain('commit-graph');
        expect(result.body).not.toContain('log-error-state');
    });

    it('renders error state when errorMessage is present and commits is empty, escaping HTML', () => {
        const initialState: LogViewPayload = {
            commits: [],
            hasRepository: true,
            errorMessage: '<script>alert("xss")</script> jj exited with code 1',
        };
        const result = render(LogApp, { props: { initialState } });

        expect(result.body).toContain('status-scroll-container');
        expect(result.body).toContain('data-testid="log-error-state"');
        expect(result.body).toContain('Unable to load Jujutsu log');
        expect(result.body).not.toContain('<script>');
        expect(result.body).toContain('&lt;script>alert("xss")&lt;/script> jj exited with code 1');
        expect(result.body).not.toContain('Loading changes...');
        expect(result.body).not.toContain('commit-graph');
    });

    it('renders CommitGraph instead of error state when commits are already loaded', () => {
        const initialState: LogViewPayload = {
            commits: [createSampleCommit()],
            hasRepository: true,
            errorMessage: 'Transient background error',
        };
        const result = render(LogApp, { props: { initialState } });

        expect(result.body).toContain('commit-graph');
        expect(result.body).toContain('feat: render log graph commit');
        expect(result.body).not.toContain('data-testid="log-error-state"');
        expect(result.body).not.toContain('data-testid="log-no-repo-state"');
    });

    it('uses strictly theme-defined CSS variables with zero hardcoded hex or rgb colors in LogApp.svelte', () => {
        const svelteSource = fs.readFileSync(path.resolve(__dirname, '../core/webview/log/LogApp.svelte'), 'utf8');
        const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(svelteSource);
        expect(styleMatch).not.toBeNull();
        const styleBlock = styleMatch?.[1] ?? '';

        expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(styleBlock).not.toMatch(/\brgba?\(/i);
        expect(styleBlock).toContain('.status-scroll-container');
        expect(styleBlock).toContain('.app-container');
        expect(styleBlock).toContain('.scroll-container');
        expect(styleBlock).not.toContain('100vh');
        expect(styleBlock).toContain('.log-status-icon.codicon');
        expect(styleBlock).toContain('var(--vscode-descriptionForeground)');
        expect(styleBlock).toContain('var(--vscode-errorForeground, var(--vscode-descriptionForeground))');
    });

    it('clamps the VS Code log webview root without hardcoding colors in LogPane.svelte', () => {
        const logWebviewCss = fs.readFileSync(path.resolve(__dirname, '../core/webview/log/log-webview.css'), 'utf8');
        expect(logWebviewCss).toContain('overflow: hidden;');
        expect(logWebviewCss).toContain('height: 100%;');

        const logPaneSource = fs.readFileSync(path.resolve(__dirname, '../../web/src/log/LogPane.svelte'), 'utf8');
        const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(logPaneSource);
        expect(styleMatch).not.toBeNull();
        const styleBlock = styleMatch?.[1] ?? '';
        expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(styleBlock).not.toMatch(/\brgba?\(/i);
        expect(styleBlock).not.toContain('100vh');
    });
});
