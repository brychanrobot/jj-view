/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Synchronous fallback for copying text to the browser clipboard using a temporary
 * offscreen `<textarea>` and `document.execCommand('copy')`.
 *
 * In cross-origin nested iframes (such as the Antigravity sidecar iframe),
 * Chromium's `clipboard-write` Permissions Policy (`crbug.com/414348233`) can block
 * the async `navigator.clipboard.writeText()` API when the outer iframe does not
 * delegate `clipboard-write *`. Legacy `document.execCommand('copy')` is not gated
 * by the `clipboard-write` Permissions Policy and succeeds as long as the iframe
 * sandbox includes `allow-scripts` and transient user activation is active.
 */
export function copyTextWithExecCommand(text: string): boolean {
    if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') {
        return false;
    }

    const activeEl = document.activeElement;
    const previousActive =
        activeEl && 'focus' in activeEl && typeof activeEl.focus === 'function' ? (activeEl as HTMLElement) : null;
    const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
    const savedRanges: Range[] = [];
    if (selection && selection.rangeCount > 0) {
        for (let i = 0; i < selection.rangeCount; i++) {
            savedRanges.push(selection.getRangeAt(i).cloneRange());
        }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';

    document.body.appendChild(textarea);
    try {
        textarea.focus({ preventScroll: true });
        textarea.select();
        textarea.setSelectionRange(0, text.length);
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        textarea.remove();
        if (selection) {
            try {
                selection.removeAllRanges();
                for (const range of savedRanges) {
                    selection.addRange(range);
                }
            } catch {
                // Ignore selection restoration errors in synthetic DOM environments
            }
        }
        try {
            previousActive?.focus({ preventScroll: true });
        } catch {
            // Ignore focus restoration errors
        }
    }
}

/**
 * Writes text to the clipboard using `navigator.clipboard.writeText` when permitted,
 * falling back to `document.execCommand('copy')` when blocked by iframe Permissions Policy.
 */
export async function writeClipboardText(text: string): Promise<void> {
    let primaryError: unknown;

    if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
    ) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch (err) {
            primaryError = err;
        }
    }

    if (copyTextWithExecCommand(text)) {
        return;
    }

    if (primaryError !== undefined) {
        throw primaryError;
    }
}
