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
    }
}
