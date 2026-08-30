/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface MenuAction {
    label: string;
    command: string;
    requiresMutable: boolean;
}

export function filterMenuActions(actions: MenuAction[], isImmutable: boolean): MenuAction[] {
    return actions.filter((action) => {
        if (action.requiresMutable && isImmutable) {
            return false;
        }
        return true;
    });
}
