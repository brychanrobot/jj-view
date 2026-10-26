/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { ProcessMonitorController } from '../../src/core/controllers/process-monitor-controller';
import type { TrackableProcess } from '../../src/core/host/host-system';
import { JjProcessTracker } from '../../src/core/jj-process-tracker';
import { FakeHostEnvironment } from '../../src/test/fake-host-environment';
import { createInMemoryBridge } from '../src/bridge/in-memory-bridge';
import ProcessMonitorView from '../src/monitor/ProcessMonitorView.svelte';
import StatusBar from '../src/status/StatusBar.svelte';
import { StatusBarService } from '../src/status/status-bar-service';
import { getTabId, PROCESS_MONITOR_TAB_ID } from '../src/tabs/tab-types';

describe('ProcessMonitorView & Web Process Monitor Integration', () => {
    it('resolves process-monitor tab ID', () => {
        expect(getTabId({ type: 'process-monitor' })).toBe(PROCESS_MONITOR_TAB_ID);
    });

    it('renders ProcessMonitorView header, metrics, and sections via SSR', () => {
        const bridge = createInMemoryBridge();
        const result = render(ProcessMonitorView, {
            props: {
                transport: bridge.transport,
                onClose: () => {},
            },
        });
        const html = result.body;

        expect(html).toContain('data-testid="process-monitor-view"');
        expect(html).toContain('data-testid="process-monitor-header"');
        expect(html).toContain('data-testid="process-monitor-close"');
        expect(html).toContain('Process &amp; Performance Monitor');
        expect(html).toContain('Running Processes');
        expect(html).toContain('History');
    });

    it('wires ProcessMonitorController with InMemoryBridge and invokes onHidePanel on hidePanel RPC', async () => {
        const tracker = new JjProcessTracker();
        const fakeHost = new FakeHostEnvironment();
        const onHidePanel = vi.fn();

        let controller: ProcessMonitorController | undefined;
        const bridge = createInMemoryBridge(async (msg) => {
            if (controller) {
                await controller.handleMessage(msg);
            }
        });

        controller = new ProcessMonitorController(tracker, fakeHost, {
            messenger: bridge.messenger,
            onHidePanel,
        });

        const fakeProc: TrackableProcess = {
            pid: 4321,
            exitCode: null,
            signalCode: null,
            killed: false,
            kill: vi.fn(() => true),
        };
        const tracked = tracker.startTrackingProcess({
            command: 'jj log --no-pager',
            args: ['log', '--no-pager'],
            childProcess: fakeProc,
            status: 'running',
            label: 'Log refresh',
        });

        expect(controller.activeTasks).toHaveLength(1);
        expect(controller.getMetrics().activeCount).toBe(1);

        tracked.finish('completed', undefined, 'commit abc', '', 0);
        expect(controller.activeTasks).toHaveLength(0);
        expect(controller.historyTasks).toHaveLength(1);
        expect(controller.getMetrics().totalCount).toBe(1);

        bridge.transport.postMessage({ command: 'hidePanel' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(onHidePanel).toHaveBeenCalledTimes(1);

        controller.dispose();
    });

    it('renders StatusBar Process & Performance Monitor button and active process count badge', () => {
        const service = new StatusBarService();
        const idleHtml = render(StatusBar, {
            props: {
                service,
                activeProcessCount: 0,
                onOpenProcessMonitor: () => {},
            },
        }).body;

        expect(idleHtml).toContain('data-testid="status-process-monitor-btn"');
        expect(idleHtml).toContain('codicon-pulse');
        expect(idleHtml).not.toContain('data-testid="status-process-count-badge"');

        const activeHtml = render(StatusBar, {
            props: {
                service,
                activeProcessCount: 3,
                onOpenProcessMonitor: () => {},
            },
        }).body;

        expect(activeHtml).toContain('data-testid="status-process-monitor-btn"');
        expect(activeHtml).toContain('codicon-sync');
        expect(activeHtml).toContain('data-testid="status-process-count-badge"');
        expect(activeHtml).toContain('>3<');
    });
});
