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
    isCurrentWorkingCopy: boolean;
    workingCopies?: string[];
    conflict?: boolean;
    isEmpty?: boolean;
    isImmutable?: boolean;
}

export interface GraphEdge {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    curveY?: number; // Row index where the line bends horizontally
    color: string;
    type: 'parent' | 'merge'; // 'parent' usually means from Child -> Parent (Vertical/Fork). 'merge' means incoming?
    isJoining?: boolean; // True if this edge seamlessly merges into another edge's trunk
    isElided?: boolean; // True if this edge connects to a non-direct ancestor (history gap)
}

export interface ElisionRow {
    type: 'elision';
}

export type GraphRow = JjLogEntry | ElisionRow;

export interface GraphLayout {
    nodes: GraphNode[];
    edges: GraphEdge[];
    width: number;
    height: number;
    rows: GraphRow[]; // The commits and spacer rows in display order
}
