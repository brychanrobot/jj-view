/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { handleEditorKeyDown } from '../src/diff/editor-shortcuts';
import { createMock } from './test-mock';

function createKeyboardEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return createMock<KeyboardEvent>({
        key: '',
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        preventDefault: vi.fn(),
        ...overrides,
    });
}

describe('handleEditorKeyDown', () => {
    it('calls onEscape when Escape key is pressed', () => {
        const onEscape = vi.fn();
        const event = createKeyboardEvent({ key: 'Escape' });
        handleEditorKeyDown(event, { onEscape });
        expect(onEscape).toHaveBeenCalledTimes(1);
    });

    it('does nothing if isWorkingCopy is false', () => {
        const onSave = vi.fn();
        const onUndo = vi.fn();
        const event = createKeyboardEvent({ key: 's', ctrlKey: true });
        handleEditorKeyDown(event, { isWorkingCopy: false, onSave, onUndo });
        expect(onSave).not.toHaveBeenCalled();
        expect(onUndo).not.toHaveBeenCalled();
    });

    it('ignores shortcuts when event target is an INPUT or TEXTAREA', () => {
        const onSave = vi.fn();
        const input = createMock<HTMLElement>({ tagName: 'INPUT' });
        const event = createKeyboardEvent({ key: 's', ctrlKey: true, target: input as EventTarget });

        handleEditorKeyDown(event, { isWorkingCopy: true, onSave });
        expect(onSave).not.toHaveBeenCalled();
    });

    it('triggers onSave when Ctrl+S or Cmd+S is pressed', () => {
        const onSave = vi.fn();
        const preventDefault = vi.fn();
        const eventCtrl = createKeyboardEvent({ key: 's', ctrlKey: true, preventDefault });
        handleEditorKeyDown(eventCtrl, { isWorkingCopy: true, onSave });
        expect(preventDefault).toHaveBeenCalled();
        expect(onSave).toHaveBeenCalledTimes(1);

        const eventMeta = createKeyboardEvent({ key: 's', metaKey: true, preventDefault });
        handleEditorKeyDown(eventMeta, { isWorkingCopy: true, onSave });
        expect(onSave).toHaveBeenCalledTimes(2);
    });

    it('triggers onUndo when Ctrl+Z or Cmd+Z is pressed and canUndo is true', () => {
        const onUndo = vi.fn();
        const preventDefault = vi.fn();
        const eventCtrl = createKeyboardEvent({ key: 'z', ctrlKey: true, preventDefault });
        handleEditorKeyDown(eventCtrl, { isWorkingCopy: true, canUndo: true, onUndo });
        expect(preventDefault).toHaveBeenCalled();
        expect(onUndo).toHaveBeenCalledTimes(1);

        const eventMeta = createKeyboardEvent({ key: 'z', metaKey: true, preventDefault });
        handleEditorKeyDown(eventMeta, { isWorkingCopy: true, canUndo: true, onUndo });
        expect(onUndo).toHaveBeenCalledTimes(2);
    });

    it('does not trigger onUndo when canUndo is false', () => {
        const onUndo = vi.fn();
        const event = createKeyboardEvent({ key: 'z', ctrlKey: true });

        handleEditorKeyDown(event, { isWorkingCopy: true, canUndo: false, onUndo });
        expect(onUndo).not.toHaveBeenCalled();
    });

    it('triggers onRedo when Ctrl+Y or Cmd+Y is pressed and canRedo is true', () => {
        const onRedo = vi.fn();
        const preventDefault = vi.fn();
        const eventCtrl = createKeyboardEvent({ key: 'y', ctrlKey: true, preventDefault });
        handleEditorKeyDown(eventCtrl, { isWorkingCopy: true, canRedo: true, onRedo });
        expect(preventDefault).toHaveBeenCalled();
        expect(onRedo).toHaveBeenCalledTimes(1);

        const eventMeta = createKeyboardEvent({ key: 'y', metaKey: true, preventDefault });
        handleEditorKeyDown(eventMeta, { isWorkingCopy: true, canRedo: true, onRedo });
        expect(onRedo).toHaveBeenCalledTimes(2);
    });

    it('triggers onRedo when Ctrl+Shift+Z or Cmd+Shift+Z is pressed and canRedo is true', () => {
        const onRedo = vi.fn();
        const preventDefault = vi.fn();
        const eventCtrl = createKeyboardEvent({ key: 'z', ctrlKey: true, shiftKey: true, preventDefault });
        handleEditorKeyDown(eventCtrl, { isWorkingCopy: true, canRedo: true, onRedo });
        expect(preventDefault).toHaveBeenCalled();
        expect(onRedo).toHaveBeenCalledTimes(1);

        const eventMeta = createKeyboardEvent({ key: 'z', metaKey: true, shiftKey: true, preventDefault });
        handleEditorKeyDown(eventMeta, { isWorkingCopy: true, canRedo: true, onRedo });
        expect(onRedo).toHaveBeenCalledTimes(2);
    });

    it('triggers onAddSelectionToChat on Ctrl/Cmd+L and Ctrl/Cmd+I even when isWorkingCopy is false', () => {
        const onAddSelectionToChat = vi.fn();
        const preventDefault = vi.fn();

        const ctrlL = createKeyboardEvent({ key: 'l', ctrlKey: true, preventDefault });
        handleEditorKeyDown(ctrlL, { isWorkingCopy: false, onAddSelectionToChat });
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(onAddSelectionToChat).toHaveBeenCalledTimes(1);

        const metaL = createKeyboardEvent({ key: 'L', metaKey: true, preventDefault });
        handleEditorKeyDown(metaL, { isWorkingCopy: true, onAddSelectionToChat });
        expect(preventDefault).toHaveBeenCalledTimes(2);
        expect(onAddSelectionToChat).toHaveBeenCalledTimes(2);

        const ctrlI = createKeyboardEvent({ key: 'i', ctrlKey: true, preventDefault });
        handleEditorKeyDown(ctrlI, { isWorkingCopy: false, onAddSelectionToChat });
        expect(preventDefault).toHaveBeenCalledTimes(3);
        expect(onAddSelectionToChat).toHaveBeenCalledTimes(3);

        const metaI = createKeyboardEvent({ key: 'i', metaKey: true, preventDefault });
        handleEditorKeyDown(metaI, { isWorkingCopy: true, onAddSelectionToChat });
        expect(preventDefault).toHaveBeenCalledTimes(4);
        expect(onAddSelectionToChat).toHaveBeenCalledTimes(4);
    });

    it('ignores Ctrl/Cmd+L when Shift is held or target is inside quick-input-widget', () => {
        const onAddSelectionToChat = vi.fn();
        const shiftCtrlL = createKeyboardEvent({ key: 'l', ctrlKey: true, shiftKey: true });
        handleEditorKeyDown(shiftCtrlL, { isWorkingCopy: true, onAddSelectionToChat });
        expect(onAddSelectionToChat).not.toHaveBeenCalled();

        const quickInputTarget = createMock<HTMLElement>({
            tagName: 'DIV',
            closest: vi.fn((selector: string) =>
                selector === '[data-testid="quick-input-widget"]' ? createMock<Element>({}) : null,
            ),
        });
        const eventInQuickInput = createKeyboardEvent({
            key: 'l',
            ctrlKey: true,
            target: quickInputTarget as EventTarget,
        });
        handleEditorKeyDown(eventInQuickInput, { isWorkingCopy: true, onAddSelectionToChat });
        expect(onAddSelectionToChat).not.toHaveBeenCalled();
    });
});
