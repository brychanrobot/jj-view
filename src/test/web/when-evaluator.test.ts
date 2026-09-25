/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { WhenEvaluator } from '../../web/menu/when-evaluator';

describe('WhenEvaluator', () => {
    it('evaluates empty or undefined clauses to true', () => {
        expect(WhenEvaluator.evaluateWithRecord(undefined, {})).toBe(true);
        expect(WhenEvaluator.evaluateWithRecord('', {})).toBe(true);
        expect(WhenEvaluator.evaluateWithRecord('   ', {})).toBe(true);
    });

    it('evaluates static true and false literals', () => {
        expect(WhenEvaluator.evaluateWithRecord('true', {})).toBe(true);
        expect(WhenEvaluator.evaluateWithRecord('false', {})).toBe(false);
    });

    it('evaluates single identifier truthiness', () => {
        expect(WhenEvaluator.evaluateWithRecord('jj.parentMutable', { 'jj.parentMutable': true })).toBe(true);
        expect(WhenEvaluator.evaluateWithRecord('jj.parentMutable', { 'jj.parentMutable': false })).toBe(false);
        expect(WhenEvaluator.evaluateWithRecord('jj.parentMutable', {})).toBe(false);
    });

    it('evaluates unary negation operator', () => {
        expect(WhenEvaluator.evaluateWithRecord('!isRemoteBookmark', { isRemoteBookmark: false })).toBe(true);
        expect(WhenEvaluator.evaluateWithRecord('!isRemoteBookmark', { isRemoteBookmark: true })).toBe(false);
        expect(WhenEvaluator.evaluateWithRecord('!isRemoteBookmark', {})).toBe(true);
    });

    it('evaluates equality and inequality with string literals', () => {
        expect(WhenEvaluator.evaluateWithRecord("webviewSection == 'commit'", { webviewSection: 'commit' })).toBe(true);
        expect(WhenEvaluator.evaluateWithRecord("webviewSection == 'commit'", { webviewSection: 'workspace' })).toBe(
            false,
        );
        expect(
            WhenEvaluator.evaluateWithRecord("jj.codeForgeProvider != 'gerrit'", {
                jj: { codeForgeProvider: 'github' },
                'jj.codeForgeProvider': 'github',
            }),
        ).toBe(true);
        expect(
            WhenEvaluator.evaluateWithRecord("jj.codeForgeProvider != 'gerrit'", { 'jj.codeForgeProvider': 'gerrit' }),
        ).toBe(false);
    });

    it('evaluates unquoted identifier comparison fallback', () => {
        expect(WhenEvaluator.evaluateWithRecord('view == jj-view.logView', { view: 'jj-view.logView' })).toBe(true);
        expect(WhenEvaluator.evaluateWithRecord('view == jj-view.logView', { view: 'workbench.panel.scm' })).toBe(
            false,
        );
    });

    it('evaluates regex matching with =~', () => {
        const context = {
            scmResourceGroupState: 'jj.group.workingCopy jj.group.allowShowMultiFileDiff jj.group.allowAbandon',
            scmProvider: 'jj',
        };

        expect(
            WhenEvaluator.evaluateWithRecord('scmResourceGroupState =~ /\\bjj\\.group\\.allowAbandon\\b/', context),
        ).toBe(true);
        expect(
            WhenEvaluator.evaluateWithRecord('scmResourceGroupState =~ /\\bjj\\.group\\.allowAbsorb\\b/', context),
        ).toBe(false);
        expect(WhenEvaluator.evaluateWithRecord('scmProvider =~ /^jj/', context)).toBe(true);
        expect(WhenEvaluator.evaluateWithRecord('scmProvider =~ /^git/', context)).toBe(false);
    });

    it('evaluates logical AND (&&) with short-circuiting', () => {
        expect(
            WhenEvaluator.evaluateWithRecord('view == jj-view.logView && jj.selection.allowAbandon', {
                view: 'jj-view.logView',
                'jj.selection.allowAbandon': true,
            }),
        ).toBe(true);

        expect(
            WhenEvaluator.evaluateWithRecord('view == jj-view.logView && jj.selection.allowAbandon', {
                view: 'jj-view.logView',
                'jj.selection.allowAbandon': false,
            }),
        ).toBe(false);
    });

    it('evaluates logical OR (||) with short-circuiting', () => {
        expect(
            WhenEvaluator.evaluateWithRecord("resourceScheme == 'jj-view' || resourceScheme == 'jj-edit'", {
                resourceScheme: 'jj-edit',
            }),
        ).toBe(true);

        expect(
            WhenEvaluator.evaluateWithRecord("resourceScheme == 'jj-view' || resourceScheme == 'jj-edit'", {
                resourceScheme: 'file',
            }),
        ).toBe(false);
    });

    it('evaluates compound expressions with parentheses and precedence', () => {
        const when =
            "(webviewSection == 'commitAction' || webviewSection == 'commitActions') && jj.commitActionVisible.newChild";

        expect(
            WhenEvaluator.evaluateWithRecord(when, {
                webviewSection: 'commitActions',
                'jj.commitActionVisible.newChild': true,
            }),
        ).toBe(true);

        expect(
            WhenEvaluator.evaluateWithRecord(when, {
                webviewSection: 'other',
                'jj.commitActionVisible.newChild': true,
            }),
        ).toBe(false);

        expect(
            WhenEvaluator.evaluateWithRecord(when, {
                webviewSection: 'commitActions',
                'jj.commitActionVisible.newChild': false,
            }),
        ).toBe(false);
    });

    it('evaluates complex resource state when-clause from package.json', () => {
        const when =
            'scmResourceState =~ /\\bjj\\.resource\\.allowOpen\\b/ && jj.openDiffOnClick || scmResourceState =~ /\\bjj\\.resource\\.allowOpenMergeEditor\\b/';

        // Case 1: allowOpen and openDiffOnClick is true -> true
        expect(
            WhenEvaluator.evaluateWithRecord(when, {
                scmResourceState: 'jj.resource.allowRestore jj.resource.allowOpen',
                'jj.openDiffOnClick': true,
            }),
        ).toBe(true);

        // Case 2: allowOpen and openDiffOnClick is false -> false
        expect(
            WhenEvaluator.evaluateWithRecord(when, {
                scmResourceState: 'jj.resource.allowRestore jj.resource.allowOpen',
                'jj.openDiffOnClick': false,
            }),
        ).toBe(false);

        // Case 3: allowOpenMergeEditor is present, openDiffOnClick is false -> true (due to ||)
        expect(
            WhenEvaluator.evaluateWithRecord(when, {
                scmResourceState: 'jj.resource.allowRestore jj.resource.allowOpenMergeEditor',
                'jj.openDiffOnClick': false,
            }),
        ).toBe(true);
    });

    it('evaluates relational operators (>, <, >=, <=)', () => {
        const clause = 'scmProvider =~ /^jj/ && scm.providerCount > 1';

        expect(
            WhenEvaluator.evaluateWithRecord(clause, {
                scmProvider: 'jj',
                'scm.providerCount': 2,
            }),
        ).toBe(true);

        expect(
            WhenEvaluator.evaluateWithRecord(clause, {
                scmProvider: 'jj',
                'scm.providerCount': 1,
            }),
        ).toBe(false);

        expect(
            WhenEvaluator.evaluateWithRecord(clause, {
                scmProvider: 'jj',
                'scm.providerCount': 0,
            }),
        ).toBe(false);

        expect(WhenEvaluator.evaluateWithRecord('count >= 5', { count: 5 })).toBe(true);
        expect(WhenEvaluator.evaluateWithRecord('count >= 5', { count: 4 })).toBe(false);
        expect(WhenEvaluator.evaluateWithRecord('count < 10', { count: 9 })).toBe(true);
        expect(WhenEvaluator.evaluateWithRecord('count < 10', { count: 10 })).toBe(false);
        expect(WhenEvaluator.evaluateWithRecord('count <= 10', { count: 10 })).toBe(true);
    });

    it('evaluates in operator', () => {
        expect(WhenEvaluator.evaluateWithRecord("'feat' in tags", { tags: ['feat', 'v1'] })).toBe(true);
        expect(WhenEvaluator.evaluateWithRecord("'bug' in tags", { tags: ['feat', 'v1'] })).toBe(false);
        expect(WhenEvaluator.evaluateWithRecord("'error' in message", { message: 'an error occurred' })).toBe(true);
    });

    it('returns false on trailing invalid syntax tokens', () => {
        expect(WhenEvaluator.evaluateWithRecord('scmProvider == jj extraTokens', { scmProvider: 'jj' })).toBe(false);
    });
});
