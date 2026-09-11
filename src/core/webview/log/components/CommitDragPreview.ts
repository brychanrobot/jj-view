/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export interface CommitDragData {
    changeId: string;
    change_id_shortest?: string;
    description?: string;
}

export { default as CommitDragPreview } from './CommitDragPreview.svelte';
