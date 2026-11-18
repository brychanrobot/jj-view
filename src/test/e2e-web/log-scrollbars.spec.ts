/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildGraph } from '../test-repo';
import { expect, type Page, test, waitForScmReady } from './standalone-fixture';

interface WebScrollSnapshot {
    readonly verticalScrollables: readonly string[];
    readonly horizontalScrollables: readonly string[];
    readonly docScrollHeight: number;
    readonly docClientHeight: number;
    readonly docScrollTop: number;
    readonly docScrollWidth: number;
    readonly docClientWidth: number;
    readonly bodyScrollHeight: number;
    readonly bodyClientHeight: number;
    readonly bodyScrollTop: number;
    readonly bodyScrollWidth: number;
    readonly bodyClientWidth: number;
    readonly appScrollHeight: number;
    readonly appClientHeight: number;
    readonly appScrollWidth: number;
    readonly appClientWidth: number;
    readonly paneScrollHeight: number;
    readonly paneClientHeight: number;
    readonly paneScrollWidth: number;
    readonly paneClientWidth: number;
    readonly contentScrollHeight: number;
    readonly contentClientHeight: number;
    readonly contentScrollWidth: number;
    readonly contentClientWidth: number;
    readonly containerScrollHeight: number;
    readonly containerClientHeight: number;
    readonly containerScrollTop: number;
    readonly containerScrollWidth: number;
    readonly containerClientWidth: number;
    readonly containerScrollLeft: number;
}

function trackUnexpectedPageErrors(page: Page): string[] {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
        const isExpectedAgentApiUnavailable =
            err.message.includes('agentapi failed') || err.message.includes('agentapi binary not found');
        if (!isExpectedAgentApiUnavailable) {
            pageErrors.push(err.message);
        }
    });
    return pageErrors;
}

async function getLogScrollSnapshot(page: Page): Promise<WebScrollSnapshot> {
    return await page.evaluate(() => {
        const doc = document.documentElement;
        const body = document.body;
        const app = document.getElementById('app');
        const logPane = document.querySelector('[data-testid="log-pane"]');
        const logContent = document.querySelector('[data-testid="log-content"]');
        const scrollContainer = logContent?.querySelector('.scroll-container');

        const describeEl = (el: Element): string => {
            const classPart =
                typeof el.className === 'string' && el.className.trim()
                    ? `.${el.className.trim().split(/\s+/).join('.')}`
                    : '';
            return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${classPart}`;
        };

        const seen = new Set<Element>();
        const candidates: Element[] = [];
        const addCandidate = (el: Element | null | undefined): void => {
            if (!el || seen.has(el)) {
                return;
            }
            seen.add(el);
            candidates.push(el);
        };

        for (let cur: Element | null = scrollContainer ?? logPane ?? body; cur; cur = cur.parentElement) {
            addCandidate(cur);
        }
        addCandidate(doc);
        addCandidate(body);
        addCandidate(app);
        for (const selector of ['[data-testid="app-shell"]', '[data-testid="split-pane"]', '.split-pane']) {
            for (const el of Array.from(document.querySelectorAll(selector))) {
                addCandidate(el);
            }
        }
        if (logPane) {
            addCandidate(logPane);
            for (const el of Array.from(logPane.querySelectorAll('*'))) {
                addCandidate(el);
            }
        }

        const verticalScrollables: string[] = [];
        const horizontalScrollables: string[] = [];
        for (const el of candidates) {
            const style = getComputedStyle(el);
            const isScrollableY = style.overflowY === 'auto' || style.overflowY === 'scroll';
            if (isScrollableY && el.scrollHeight > el.clientHeight + 1) {
                verticalScrollables.push(describeEl(el));
            }
            const isScrollableX = style.overflowX === 'auto' || style.overflowX === 'scroll';
            if (isScrollableX && el.scrollWidth > el.clientWidth + 1) {
                horizontalScrollables.push(describeEl(el));
            }
        }

        const scrollingEl = document.scrollingElement;
        return {
            verticalScrollables,
            horizontalScrollables,
            docScrollHeight: doc.scrollHeight,
            docClientHeight: doc.clientHeight,
            docScrollTop: scrollingEl?.scrollTop ?? doc.scrollTop,
            docScrollWidth: doc.scrollWidth,
            docClientWidth: doc.clientWidth,
            bodyScrollHeight: body.scrollHeight,
            bodyClientHeight: body.clientHeight,
            bodyScrollTop: body.scrollTop,
            bodyScrollWidth: body.scrollWidth,
            bodyClientWidth: body.clientWidth,
            appScrollHeight: app?.scrollHeight ?? 0,
            appClientHeight: app?.clientHeight ?? 0,
            appScrollWidth: app?.scrollWidth ?? 0,
            appClientWidth: app?.clientWidth ?? 0,
            paneScrollHeight: logPane?.scrollHeight ?? 0,
            paneClientHeight: logPane?.clientHeight ?? 0,
            paneScrollWidth: logPane?.scrollWidth ?? 0,
            paneClientWidth: logPane?.clientWidth ?? 0,
            contentScrollHeight: logContent?.scrollHeight ?? 0,
            contentClientHeight: logContent?.clientHeight ?? 0,
            contentScrollWidth: logContent?.scrollWidth ?? 0,
            contentClientWidth: logContent?.clientWidth ?? 0,
            containerScrollHeight: scrollContainer?.scrollHeight ?? 0,
            containerClientHeight: scrollContainer?.clientHeight ?? 0,
            containerScrollTop: scrollContainer?.scrollTop ?? 0,
            containerScrollWidth: scrollContainer?.scrollWidth ?? 0,
            containerClientWidth: scrollContainer?.clientWidth ?? 0,
            containerScrollLeft: scrollContainer?.scrollLeft ?? 0,
        };
    });
}

function expectNoOuterOverflow(snapshot: WebScrollSnapshot): void {
    expect(snapshot.docScrollHeight).toBeLessThanOrEqual(snapshot.docClientHeight);
    expect(snapshot.docScrollWidth).toBeLessThanOrEqual(snapshot.docClientWidth);
    expect(snapshot.bodyScrollHeight).toBeLessThanOrEqual(snapshot.bodyClientHeight);
    expect(snapshot.bodyScrollWidth).toBeLessThanOrEqual(snapshot.bodyClientWidth);
    expect(snapshot.appScrollHeight).toBeLessThanOrEqual(snapshot.appClientHeight);
    expect(snapshot.appScrollWidth).toBeLessThanOrEqual(snapshot.appClientWidth);
    expect(snapshot.paneScrollHeight).toBeLessThanOrEqual(snapshot.paneClientHeight);
    expect(snapshot.paneScrollWidth).toBeLessThanOrEqual(snapshot.paneClientWidth);
    expect(snapshot.contentScrollHeight).toBeLessThanOrEqual(snapshot.contentClientHeight);
    expect(snapshot.contentScrollWidth).toBeLessThanOrEqual(snapshot.contentClientWidth);
}

function expectStrictlySingleVerticalLogScrollContainer(snapshot: WebScrollSnapshot): void {
    expectNoOuterOverflow(snapshot);
    expect(snapshot.containerScrollHeight).toBeGreaterThan(snapshot.containerClientHeight);
    expect(snapshot.verticalScrollables).toHaveLength(1);
    expect(snapshot.verticalScrollables[0]).toContain('scroll-container');
}

function expectNoHorizontalLogOverflow(snapshot: WebScrollSnapshot): void {
    expect(snapshot.containerScrollWidth).toBeLessThanOrEqual(snapshot.containerClientWidth);
    expect(snapshot.horizontalScrollables).toEqual([]);
}

test.describe('Standalone Web Log Scrollbars (#397)', () => {
    test('maintains strictly one vertical scrollable container across scrolling, resizing, narrow mode, and themes', async ({
        page,
        server,
        testRepo,
    }) => {
        const pageErrors = trackUnexpectedPageErrors(page);

        testRepo.writeFile('base.txt', 'base\n');
        testRepo.describe('feat: earliest base commit at bottom');
        testRepo.new();

        for (let i = 1; i <= 45; i++) {
            testRepo.writeFile('history.txt', `revision ${i}\n`);
            testRepo.describe(`feat: commit ${i} with description for scrollbar testing`);
            if (i < 45) {
                testRepo.new();
            }
        }

        await page.setViewportSize({ width: 1280, height: 500 });
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logContent = page.locator('[data-testid="log-content"]');
        await expect(logContent.locator('.commit-row').first()).toBeVisible({ timeout: 15000 });
        await expect.poll(async () => (await getLogScrollSnapshot(page)).containerScrollHeight).toBeGreaterThan(1000);

        const wideInitial = await getLogScrollSnapshot(page);
        expectStrictlySingleVerticalLogScrollContainer(wideInitial);
        expectNoHorizontalLogOverflow(wideInitial);

        // Scroll via mouse wheel and verify strictly .scroll-container scrolls without outer viewport movement
        const scrollContainer = logContent.locator('.scroll-container');
        await scrollContainer.hover();
        await expect
            .poll(async () => {
                await page.mouse.wheel(0, 400);
                return (await getLogScrollSnapshot(page)).containerScrollTop;
            })
            .toBeGreaterThan(0);

        const bottomCommit = logContent.locator('.commit-row', { hasText: 'feat: earliest base commit at bottom' });
        await bottomCommit.scrollIntoViewIfNeeded();
        await expect(bottomCommit).toBeVisible();

        const wideScrolled = await getLogScrollSnapshot(page);
        expectStrictlySingleVerticalLogScrollContainer(wideScrolled);
        expectNoHorizontalLogOverflow(wideScrolled);
        expect(wideScrolled.docScrollTop).toBe(0);
        expect(wideScrolled.bodyScrollTop).toBe(0);
        expect(wideScrolled.containerScrollTop).toBeGreaterThan(0);

        // Resize viewport height shorter and confirm clientHeight/scrollTop adapt with zero extra scrollbars
        await page.setViewportSize({ width: 1280, height: 340 });
        await expect
            .poll(async () => (await getLogScrollSnapshot(page)).containerClientHeight)
            .toBeLessThan(wideInitial.containerClientHeight);

        const wideResized = await getLogScrollSnapshot(page);
        expectStrictlySingleVerticalLogScrollContainer(wideResized);
        expectNoHorizontalLogOverflow(wideResized);

        // Switch to light theme and verify zero horizontal/double scrollbars
        await page.evaluate(async () => {
            await window.__JJ_VIEW_ENV__?.config.update?.('appearance.theme', 'pierre-light');
        });
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'pierre-light');
        const lightSnapshot = await getLogScrollSnapshot(page);
        expectStrictlySingleVerticalLogScrollContainer(lightSnapshot);
        expectNoHorizontalLogOverflow(lightSnapshot);

        // Switch to narrow mode (<500px width) and confirm Log tab has strictly one scrollable container
        await page.setViewportSize({ width: 420, height: 500 });
        await expect(page.locator('[data-testid="pill-log"]')).toBeVisible();
        await page.locator('[data-testid="pill-log"]').click();
        await expect(logContent.locator('.commit-row').first()).toBeVisible();

        const narrowInitial = await getLogScrollSnapshot(page);
        expectStrictlySingleVerticalLogScrollContainer(narrowInitial);
        expectNoHorizontalLogOverflow(narrowInitial);

        await bottomCommit.scrollIntoViewIfNeeded();
        await expect(bottomCommit).toBeVisible();
        const narrowScrolled = await getLogScrollSnapshot(page);
        expectStrictlySingleVerticalLogScrollContainer(narrowScrolled);
        expectNoHorizontalLogOverflow(narrowScrolled);
        expect(narrowScrolled.containerScrollTop).toBeGreaterThan(0);

        expect(pageErrors).toEqual([]);
    });

    test('maintains zero vertical or horizontal scrollbars for short commit history', async ({
        page,
        server,
        testRepo,
    }) => {
        const pageErrors = trackUnexpectedPageErrors(page);

        testRepo.writeFile('a.txt', 'alpha\n');
        testRepo.describe('feat: short log base');
        testRepo.new();
        testRepo.writeFile('b.txt', 'beta\n');
        testRepo.describe('feat: short log top');

        await page.setViewportSize({ width: 1280, height: 500 });
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const logContent = page.locator('[data-testid="log-content"]');
        await expect(logContent.locator('.commit-row', { hasText: 'feat: short log top' })).toBeVisible({
            timeout: 15000,
        });

        const snapshot = await getLogScrollSnapshot(page);
        expectNoOuterOverflow(snapshot);
        expectNoHorizontalLogOverflow(snapshot);
        expect(snapshot.containerScrollHeight).toBeLessThanOrEqual(snapshot.containerClientHeight);
        expect(snapshot.verticalScrollables).toEqual([]);

        expect(pageErrors).toEqual([]);
    });

    test('contains wide multi-lane graph horizontal scrolling strictly inside .scroll-container', async ({
        page,
        server,
        testRepo,
    }) => {
        const pageErrors = trackUnexpectedPageErrors(page);

        const commits: Array<{ label: string; parents?: string[]; description: string }> = [
            { label: 'base', description: 'feat: parallel graph root' },
        ];
        const branchLabels: string[] = [];
        for (let i = 1; i <= 24; i++) {
            const label = `branch-${i}`;
            branchLabels.push(label);
            commits.push({ label, parents: ['base'], description: `feat: parallel branch ${i}` });
        }
        commits.push({
            label: 'tip',
            parents: branchLabels,
            description: 'feat: merge 24 parallel lanes',
        });
        await buildGraph(testRepo, commits);

        await page.setViewportSize({ width: 340, height: 500 });
        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        await expect(page.locator('[data-testid="pill-log"]')).toBeVisible();
        await page.locator('[data-testid="pill-log"]').click();

        const logContent = page.locator('[data-testid="log-content"]');
        await expect(logContent.locator('.commit-row').first()).toBeVisible({ timeout: 15000 });
        await expect
            .poll(async () => {
                const s = await getLogScrollSnapshot(page);
                return s.containerScrollWidth > s.containerClientWidth;
            })
            .toBe(true);

        const initial = await getLogScrollSnapshot(page);
        expectStrictlySingleVerticalLogScrollContainer(initial);
        expect(initial.horizontalScrollables).toHaveLength(1);
        expect(initial.horizontalScrollables[0]).toContain('scroll-container');

        const scrollContainer = logContent.locator('.scroll-container');
        await scrollContainer.hover();
        await expect
            .poll(async () => {
                await page.mouse.wheel(150, 0);
                return (await getLogScrollSnapshot(page)).containerScrollLeft;
            })
            .toBeGreaterThan(0);

        const scrolled = await getLogScrollSnapshot(page);
        expectStrictlySingleVerticalLogScrollContainer(scrolled);
        expect(scrolled.horizontalScrollables).toHaveLength(1);
        expect(scrolled.horizontalScrollables[0]).toContain('scroll-container');

        expect(pageErrors).toEqual([]);
    });
});
