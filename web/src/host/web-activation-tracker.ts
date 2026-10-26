/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Event, EventEmitter } from '../../../src/core/host/events';
import type { HostDisposable } from '../../../src/core/host/host-environment';

interface HostFocusMessage {
    readonly type?: unknown;
    readonly payload?: {
        readonly focused?: unknown;
        readonly active?: unknown;
        readonly visible?: unknown;
    };
}

function isHostFocusMessage(data: unknown): data is HostFocusMessage {
    return typeof data === 'object' && data !== null;
}

/**
 * Aggregates browser window, document, iframe, pointer, and postMessage signals
 * into a unified activation state and event stream (`isActive` / `onDidChangeActive`).
 *
 * - In standalone mode (`window.parent === window`), `isActive` requires both
 *   document visibility (`!document.hidden`) and window focus (`document.hasFocus()`).
 * - In embedded/sidecar iframe mode (`window.parent !== window` or `window.sidecar`),
 *   `document.hasFocus()` is false whenever keyboard focus is in the parent frame
 *   (e.g., typing in chat or an editor). Therefore:
 *   1. `isActive` remains `true` whenever the iframe document is visible (`!document.hidden`),
 *      keeping background polling alive while the sidecar is open alongside chat.
 *   2. Activation edges (`visibilitychange` to visible, `window` `focus`,
 *      `document` `pointerenter`, and parent `window-focus` `postMessage`) pulse
 *      `onDidChangeActive(true)` so `ChangeDetectionManager` triggers its throttled
 *      working-copy snapshot in both `"watch"` and `"polling"` modes without
 *      requiring an explicit click inside the iframe.
 */
export class WebActivationTracker implements HostDisposable {
    private _isActive: boolean;
    private readonly _onDidChangeActive = new EventEmitter<boolean>();
    private _cleanupListeners?: () => void;

    public readonly onDidChangeActive: Event<boolean> = this._onDidChangeActive.event;

    constructor() {
        this._isActive = this._computeInitialActiveState();
        this._setupListeners();
    }

    public get isActive(): boolean {
        return this._isActive;
    }

    /**
     * Updates the active state and fires `onDidChangeActive` if the state changed.
     */
    public setActiveState(active: boolean): void {
        if (this._isActive === active) {
            return;
        }
        this._isActive = active;
        this._onDidChangeActive.fire(active);
    }

    /**
     * Marks the tracker active and unconditionally emits `onDidChangeActive(true)`
     * so downstream listeners (such as `ChangeDetectionManager`, which throttles
     * active refreshes to `ACTIVE_REFRESH_THROTTLE_MS`) can sync immediately even
     * when the iframe was already visible.
     */
    public pulseActive(): void {
        this._isActive = true;
        this._onDidChangeActive.fire(true);
    }

    private _isEmbeddedIframe(): boolean {
        if (typeof window === 'undefined') {
            return false;
        }
        try {
            if (window.parent && window.parent !== window) {
                return true;
            }
        } catch {
            // Cross-origin access to window.parent threw, which means we are in an iframe.
            return true;
        }
        return Boolean(window.sidecar);
    }

    private _isDocumentVisible(): boolean {
        if (typeof document === 'undefined') {
            return true;
        }
        return !document.hidden;
    }

    private _hasDocumentFocus(): boolean {
        if (typeof document === 'undefined') {
            return true;
        }
        return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    }

    private _computeInitialActiveState(): boolean {
        if (typeof document === 'undefined') {
            return true;
        }
        const isVisible = this._isDocumentVisible();
        if (this._isEmbeddedIframe()) {
            return isVisible;
        }
        return isVisible && this._hasDocumentFocus();
    }

    private _setupListeners(): void {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return;
        }

        const handleFocus = () => {
            if (this._isEmbeddedIframe()) {
                if (this._isDocumentVisible()) {
                    this.pulseActive();
                }
                return;
            }
            this.setActiveState(true);
        };

        const handleBlur = () => {
            const isVisible = this._isDocumentVisible();
            if (this._isEmbeddedIframe()) {
                // In an iframe, losing keyboard focus to the parent window (e.g. chat)
                // should not mark the sidecar inactive as long as it remains visible.
                this.setActiveState(isVisible);
                return;
            }
            const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : false;
            this.setActiveState(isVisible && hasFocus);
        };

        const handleVisibilityChange = () => {
            const isVisible = this._isDocumentVisible();
            if (this._isEmbeddedIframe()) {
                if (isVisible) {
                    this.pulseActive();
                } else {
                    this.setActiveState(false);
                }
                return;
            }
            const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : false;
            this.setActiveState(isVisible && hasFocus);
        };

        const handlePointerEnter = () => {
            if (!this._isEmbeddedIframe() || !this._isDocumentVisible()) {
                return;
            }
            this.pulseActive();
        };

        const handleMessage = (event: MessageEvent) => {
            if (window.parent !== window) {
                if (event.source !== undefined && event.source !== window.parent) {
                    return;
                }
            } else if (event.source !== window && event.source !== null && event.source !== undefined) {
                return;
            }
            if (!isHostFocusMessage(event.data)) {
                return;
            }
            const msgType = event.data.type;
            if (msgType !== 'window-focus' && msgType !== 'host-visibility-change') {
                return;
            }
            const payload = event.data.payload;
            if (payload?.visible === false || payload?.active === false) {
                this.setActiveState(false);
                return;
            }
            if (payload?.focused === true || payload?.active === true || payload?.visible === true) {
                if (this._isDocumentVisible()) {
                    this.pulseActive();
                }
            }
        };

        window.addEventListener('focus', handleFocus);
        window.addEventListener('blur', handleBlur);
        window.addEventListener('message', handleMessage);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        document.addEventListener('pointerenter', handlePointerEnter);

        this._cleanupListeners = () => {
            window.removeEventListener('focus', handleFocus);
            window.removeEventListener('blur', handleBlur);
            window.removeEventListener('message', handleMessage);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            document.removeEventListener('pointerenter', handlePointerEnter);
        };
    }

    public dispose(): void {
        if (this._cleanupListeners) {
            this._cleanupListeners();
            this._cleanupListeners = undefined;
        }
        this._onDidChangeActive.dispose();
    }
}
