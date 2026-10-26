/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JjResourceState } from '../../../src/core/scm-resource-state';
import type { Uri } from '../../../src/core/uri-utils';

export interface MultiDiffFileEntry {
    filename: string;
    originalContent?: string;
    modifiedContent?: string;
    fileStatus?: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
    isWorkingCopy?: boolean;
    isConflict?: boolean;
    leftUri?: Uri;
    rightUri?: Uri;
}

export type TabViewData =
    | {
          type: 'diff';
          leftUri?: Uri;
          rightUri?: Uri;
          title: string;
          resourceState?: JjResourceState;
          originalContent?: string;
          modifiedContent?: string;
          loaded?: boolean;
      }
    | {
          type: 'multi-diff';
          title: string;
          files: MultiDiffFileEntry[];
      }
    | {
          type: 'commit-details';
          changeId: string;
          title?: string;
      }
    | {
          type: 'file';
          uri: Uri;
          title: string;
          content?: string;
          resourceState?: JjResourceState;
      }
    | {
          type: 'merge';
          uri: Uri;
          title: string;
          baseContent: string;
          leftContent: string;
          rightContent: string;
          resolvedContent?: string;
          resourceState?: JjResourceState;
          loaded?: boolean;
      }
    | {
          /** The review comments for the CommentsManager's active change. One per app. */
          type: 'comments';
      }
    | {
          /** The diagnostic output channel log viewer. One per app. */
          type: 'output';
      }
    | {
          /** The live process and performance monitor view. One per app. */
          type: 'process-monitor';
      };

export interface TabEntry {
    id: string;
    title: string;
    tooltip?: string;
    iconClass?: string;
    preview: boolean;
    isDirty?: boolean;
    view: TabViewData;
}

export type TabReorderPosition = 'before' | 'after';

export const COMMENTS_TAB_ID = 'comments';
export const OUTPUT_TAB_ID = 'output';
export const PROCESS_MONITOR_TAB_ID = 'process-monitor';

export function getTabId(view: TabViewData): string {
    switch (view.type) {
        case 'diff': {
            const left = view.leftUri ? view.leftUri.toString() : 'empty';
            const right = view.rightUri ? view.rightUri.toString() : 'empty';
            return `diff:${left}<->${right}`;
        }
        case 'multi-diff':
            return `multi-diff:${view.title}`;
        case 'commit-details':
            return `commit-details:${view.changeId}`;
        case 'file':
            return `file:${view.uri.toString()}`;
        case 'merge':
            return `merge:${view.uri.toString()}`;
        case 'comments':
            return COMMENTS_TAB_ID;
        case 'output':
            return OUTPUT_TAB_ID;
        case 'process-monitor':
            return PROCESS_MONITOR_TAB_ID;
    }
}
