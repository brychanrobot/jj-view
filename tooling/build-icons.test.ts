/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { areIconsUpToDate, computeIconsSourceHash } from './build-icons';

describe('build-icons', () => {
    let tmpDir: string;
    let srcDir: string;
    let outDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-icons-test-'));
        srcDir = path.join(tmpDir, 'src');
        outDir = path.join(tmpDir, 'out');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(outDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('computeIconsSourceHash', () => {
        it('returns empty string if srcDir does not exist', () => {
            expect(computeIconsSourceHash(path.join(tmpDir, 'nonexistent'))).toBe('');
        });

        it('computes deterministic hash for files in srcDir', () => {
            fs.writeFileSync(path.join(srcDir, 'icon1.svg'), '<svg>1</svg>');
            fs.writeFileSync(path.join(srcDir, 'icon2.svg'), '<svg>2</svg>');

            const hash1 = computeIconsSourceHash(srcDir);
            const hash2 = computeIconsSourceHash(srcDir);

            expect(hash1).toBeTruthy();
            expect(hash1).toBe(hash2);
        });

        it('changes hash when file content changes without renaming', () => {
            const iconPath = path.join(srcDir, 'icon.svg');
            fs.writeFileSync(iconPath, '<svg>initial</svg>');
            const initialHash = computeIconsSourceHash(srcDir);

            fs.writeFileSync(iconPath, '<svg>modified</svg>');
            const modifiedHash = computeIconsSourceHash(srcDir);

            expect(modifiedHash).not.toBe(initialHash);
        });

        it('ignores hidden files in srcDir', () => {
            fs.writeFileSync(path.join(srcDir, 'icon.svg'), '<svg>test</svg>');
            const baseHash = computeIconsSourceHash(srcDir);

            fs.writeFileSync(path.join(srcDir, '.DS_Store'), 'junk');
            const withHiddenHash = computeIconsSourceHash(srcDir);

            expect(withHiddenHash).toBe(baseHash);
        });
    });

    describe('areIconsUpToDate', () => {
        it('returns false if outDir does not exist', () => {
            fs.rmSync(outDir, { recursive: true, force: true });
            expect(areIconsUpToDate(srcDir, outDir)).toBe(false);
        });

        it('returns false if required output files are missing', () => {
            fs.writeFileSync(path.join(srcDir, 'icon.svg'), '<svg>test</svg>');
            const hash = computeIconsSourceHash(srcDir);
            fs.writeFileSync(path.join(outDir, 'icons.hash'), hash);

            // Missing .woff, .woff2, .ttf, .css
            expect(areIconsUpToDate(srcDir, outDir)).toBe(false);
        });

        it('returns false if hash file is missing', () => {
            fs.writeFileSync(path.join(srcDir, 'icon.svg'), '<svg>test</svg>');
            fs.writeFileSync(path.join(outDir, 'jj-view-icons.woff'), 'dummy');
            fs.writeFileSync(path.join(outDir, 'jj-view-icons.woff2'), 'dummy');
            fs.writeFileSync(path.join(outDir, 'jj-view-icons.ttf'), 'dummy');
            fs.writeFileSync(path.join(outDir, 'jj-view-icons.css'), 'dummy');

            expect(areIconsUpToDate(srcDir, outDir)).toBe(false);
        });

        it('returns false if hash does not match current source', () => {
            fs.writeFileSync(path.join(srcDir, 'icon.svg'), '<svg>test</svg>');
            fs.writeFileSync(path.join(outDir, 'jj-view-icons.woff'), 'dummy');
            fs.writeFileSync(path.join(outDir, 'jj-view-icons.woff2'), 'dummy');
            fs.writeFileSync(path.join(outDir, 'jj-view-icons.ttf'), 'dummy');
            fs.writeFileSync(path.join(outDir, 'jj-view-icons.css'), 'dummy');
            fs.writeFileSync(path.join(outDir, 'icons.hash'), 'old-hash');

            expect(areIconsUpToDate(srcDir, outDir)).toBe(false);
        });

        it('returns true when all required files exist and hash matches', () => {
            fs.writeFileSync(path.join(srcDir, 'icon.svg'), '<svg>test</svg>');
            const hash = computeIconsSourceHash(srcDir);

            fs.writeFileSync(path.join(outDir, 'jj-view-icons.woff'), 'dummy');
            fs.writeFileSync(path.join(outDir, 'jj-view-icons.woff2'), 'dummy');
            fs.writeFileSync(path.join(outDir, 'jj-view-icons.ttf'), 'dummy');
            fs.writeFileSync(path.join(outDir, 'jj-view-icons.css'), 'dummy');
            fs.writeFileSync(path.join(outDir, 'icons.hash'), hash);

            expect(areIconsUpToDate(srcDir, outDir)).toBe(true);
        });
    });
});
