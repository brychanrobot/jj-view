/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JjLogEntry } from '../jj-types';

export interface GraphNode {
    commitId: string;
    changeId: string;
    x: number; // Lane index
    y: number; // Row index
    color: string;
    isWorkingCopy: boolean;
    conflict?: boolean;
    isEmpty?: boolean;
}

export interface GraphEdge {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    color: string;
    type: 'parent' | 'merge'; // 'parent' usually means from Child -> Parent (Vertical/Fork). 'merge' means incoming?
}

export interface GraphLayout {
    nodes: GraphNode[];
    edges: GraphEdge[];
    width: number;
    height: number;
    rows: JjLogEntry[]; // The commits in display order
}
