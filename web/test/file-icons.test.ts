/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getFileIcon } from '../src/scm/file-icons';

describe('file-icons', () => {
    it('resolves TypeScript file icons', () => {
        const ts = getFileIcon('default-menus.ts');
        expect(ts.type).toBe('badge');
        expect(ts.text).toBe('TS');
        expect(ts.color).toBe('#519aba');

        const tsx = getFileIcon('Component.tsx');
        expect(tsx.type).toBe('badge');
        expect(tsx.text).toBe('TSX');
    });

    it('resolves JSON file icons', () => {
        const json = getFileIcon('package.json');
        expect(json.type).toBe('badge');
        expect(json.text).toBe('{}');
        expect(json.color).toBe('#cbcb41');
    });

    it('resolves YAML file icons', () => {
        const yml = getFileIcon('ci.yml');
        expect(yml.type).toBe('badge');
        expect(yml.text).toBe('!');
        expect(yml.color).toBe('#cb171e');
    });

    it('resolves test file icons with orange badge', () => {
        const testTs = getFileIcon('file-icons.test.ts');
        expect(testTs.type).toBe('badge');
        expect(testTs.text).toBe('TS');
        expect(testTs.color).toBe('#e37933');

        const specTsx = getFileIcon('App.spec.tsx');
        expect(specTsx.type).toBe('badge');
        expect(specTsx.text).toBe('TSX');
        expect(specTsx.color).toBe('#e37933');

        const testJs = getFileIcon('runner.test.js');
        expect(testJs.type).toBe('badge');
        expect(testJs.text).toBe('JS');
        expect(testJs.color).toBe('#e37933');
    });

    it('resolves CSS and SCSS file icons', () => {
        const css = getFileIcon('app.css');
        expect(css.type).toBe('badge');
        expect(css.text).toBe('#');
        expect(css.color).toBe('#519aba');

        const scss = getFileIcon('app.scss');
        expect(scss.type).toBe('badge');
        expect(scss.text).toBe('#');
        expect(scss.color).toBe('#f55385');
    });

    it('resolves Svelte file icons', () => {
        const svelte = getFileIcon('App.svelte');
        expect(svelte.type).toBe('svg');
        expect(svelte.color).toBe('#cc3e44');
        expect(svelte.svg).toContain('viewBox="0 0 32 32"');
    });

    it('resolves Go file icons', () => {
        const go = getFileIcon('main.go');
        expect(go.type).toBe('svg');
        expect(go.color).toBe('#00add8');
        expect(go.svg).toContain('svg');
    });

    it('resolves exact filename matches', () => {
        const gitignore = getFileIcon('.gitignore');
        expect(gitignore.type).toBe('codicon');
        expect(gitignore.codicon).toBe('codicon-git-branch');

        const docker = getFileIcon('Dockerfile');
        expect(docker.type).toBe('codicon');
        expect(docker.codicon).toBe('codicon-server');

        const jj = getFileIcon('.jjignore');
        expect(jj.type).toBe('badge');
        expect(jj.text).toBe('jj');
    });

    it('falls back to default codicon-file for unknown files', () => {
        const unknown = getFileIcon('some_unknown.xyz123');
        expect(unknown.type).toBe('codicon');
        expect(unknown.codicon).toBe('codicon-file');
    });
});
