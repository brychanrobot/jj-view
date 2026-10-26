/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { HostUi } from '../../src/core/host/host-environment';
import { showJjError } from '../../src/core/host/ui-helpers';
import { createMock } from '../../src/test/test-utils';
import { OutputChannel } from '../../src/utils/output-channel';
import OutputPane from '../src/output/OutputPane.svelte';
import {
    parseLogMessage,
    splitHighlightSegments,
    tokenizeLogText,
    WebOutputChannel,
} from '../src/output/web-output-channel';
import StatusBar from '../src/status/StatusBar.svelte';
import { StatusBarService } from '../src/status/status-bar-service';

describe('WebOutputChannel & Log Highlighting', () => {
    describe('parseLogMessage', () => {
        it('extracts source tag, duration, and multi-line details', () => {
            const raw = '[Gerrit] Fetched CL 8412489 [142ms]\nLine 2 detail\nLine 3 detail';
            const parsed = parseLogMessage(raw);
            expect(parsed.source).toBe('Gerrit');
            expect(parsed.durationMs).toBe(142);
            expect(parsed.message).toBe('Fetched CL 8412489');
            expect(parsed.details).toBe('Line 2 detail\nLine 3 detail');
        });

        it('preserves plain single-line messages without tags under General source', () => {
            const parsed = parseLogMessage('Executing jj status --no-pager');
            expect(parsed.source).toBe('General');
            expect(parsed.durationMs).toBeUndefined();
            expect(parsed.message).toBe('Executing jj status --no-pager');
            expect(parsed.details).toBeUndefined();
        });
    });

    describe('tokenizeLogText', () => {
        it('tokenizes URLs, flags, strings, durations, paths, and error/success keywords', () => {
            const text =
                'Command failed with exit code 1 on /workspace/repo/file.ts --no-pager "error detail" https://chromium-review.googlesource.com/c/123 took 45ms';
            const tokens = tokenizeLogText(text);
            const kinds = tokens.map((t) => t.kind);
            expect(kinds).toContain('keyword-error');
            expect(kinds).toContain('path');
            expect(kinds).toContain('flag');
            expect(kinds).toContain('string');
            expect(kinds).toContain('url');
            expect(kinds).toContain('duration');
            expect(tokens.map((t) => t.text).join('')).toBe(text);
        });
    });

    describe('splitHighlightSegments', () => {
        it('splits text into case-insensitive search match segments', () => {
            const segments = splitHighlightSegments('Executing jj rebase -d main', 'REBASE');
            expect(segments).toEqual([
                { text: 'Executing jj ', match: false },
                { text: 'rebase', match: true },
                { text: ' -d main', match: false },
            ]);
        });

        it('returns single unmatched segment when query is empty', () => {
            expect(splitHighlightSegments('hello world', '')).toEqual([{ text: 'hello world', match: false }]);
        });
    });

    describe('WebOutputChannel lifecycle & showJjError integration', () => {
        it('records structured entries, tracks sources, and fires onDidChangeEntries', () => {
            const channel = new WebOutputChannel('JJ View');
            const wrapped = new OutputChannel(channel, 'GitHub');
            const listener = vi.fn();
            channel.onDidChangeEntries(listener);

            wrapped.info('Authenticated user [25ms]');
            channel.warn('[ScmModel] Slow status refresh');
            channel.error('Rebase conflict failed', new Error('Conflict in src/main.ts'));
            channel.debug('[Perf:Startup] Ready');

            expect(channel.entries).toHaveLength(4);
            expect(channel.entries[0].level).toBe('info');
            expect(channel.entries[0].source).toBe('GitHub');
            expect(channel.entries[0].durationMs).toBe(25);
            expect(channel.entries[1].level).toBe('warn');
            expect(channel.entries[1].source).toBe('ScmModel');
            expect(channel.entries[2].level).toBe('error');
            expect(channel.entries[2].details).toContain('Conflict in src/main.ts');
            expect(channel.entries[3].level).toBe('debug');
            expect(listener).toHaveBeenCalledTimes(4);
        });

        it('supports clear() and replace()', () => {
            const channel = new WebOutputChannel('JJ View');
            channel.info('Line 1');
            channel.info('Line 2');
            expect(channel.entries).toHaveLength(2);

            channel.clear();
            expect(channel.entries).toHaveLength(0);

            channel.replace('[Gerrit] Replaced content\nExtra line');
            expect(channel.entries).toHaveLength(1);
            expect(channel.entries[0].source).toBe('Gerrit');
            expect(channel.entries[0].message).toBe('Replaced content');
            expect(channel.entries[0].details).toBe('Extra line');
        });

        it('triggers onDidRequestShow when clicking "Show Log" in showJjError', async () => {
            const webChannel = new WebOutputChannel('JJ View');
            const logger = new OutputChannel(webChannel);
            const showSpy = vi.fn();
            webChannel.onDidRequestShow(showSpy);

            const ui = createMock<HostUi>({
                showErrorMessage: vi.fn(async (_msg: string, ...items: string[]) => {
                    expect(items).toContain('Show Log');
                    return 'Show Log';
                }),
            });

            await showJjError(ui, new Error('Immutable parent commit'), 'Failed to squash', undefined, logger);

            expect(webChannel.entries).toHaveLength(1);
            expect(webChannel.entries[0].level).toBe('error');
            expect(webChannel.entries[0].message).toContain('Failed to squash');
            expect(showSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('OutputPane & StatusBar SSR Rendering', () => {
        it('renders OutputPane with entries, filter controls, and syntax tokens', () => {
            const channel = new WebOutputChannel('JJ View');
            channel.info('[Startup] Host daemon connected [12ms]');
            channel.warn('[Watcher] Falling back to polling mode');
            channel.error('[JjService] Command failed with exit code 1\njj: error: immutable commit');

            const result = render(OutputPane, {
                props: {
                    channel,
                    onClose: () => {},
                },
            });
            const html = result.body;

            expect(html).toContain('data-testid="output-pane"');
            expect(html).toContain('data-testid="output-filter-input"');
            expect(html).toContain('data-testid="output-source-select"');
            expect(html).toContain('data-testid="output-level-all"');
            expect(html).toContain('data-testid="output-level-error"');
            expect(html).toContain('Host daemon ');
            expect(html).toContain('connected');
            expect(html).toContain('Falling back to polling mode');
            expect(html).toContain('with exit code 1');
            expect(html).toContain('12ms');
        });

        it('renders StatusBar with Output Log button when onOpenOutput is provided', () => {
            const service = new StatusBarService();
            const result = render(StatusBar, {
                props: {
                    service,
                    onOpenOutput: () => {},
                },
            });
            expect(result.body).toContain('data-testid="status-output-btn"');
        });
    });
});
