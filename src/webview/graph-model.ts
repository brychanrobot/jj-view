/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { match } from 'ts-pattern';
import type { JjLogEntry } from '../jj-types';

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

export interface NodePoint {
    type: 'node';
    x: number; // Lane index
    y: number; // Row index
}

export interface LinkPoint {
    type: 'link';
    x: number; // Lane index
    y: number; // Row index
}

export type GraphPoint = NodePoint | LinkPoint;

export interface GraphEdge {
    id: string;
    points: GraphPoint[]; // The series of points forming the path
    color: string;
    type: 'parent';
    isElided?: boolean; // True if this edge connects to a non-direct ancestor (history gap)
    isJoining?: boolean; // True if this edge is joining another lane
}

export interface ElisionRow {
    type: 'elision';
    targetId: string;
}

export type GraphRow = JjLogEntry | ElisionRow;

export function isElisionRow(row: GraphRow): row is ElisionRow {
    return match(row)
        .with({ type: 'elision' }, () => true)
        .otherwise(() => false);
}

export interface GraphLayout {
    nodes: GraphNode[];
    edges: GraphEdge[];
    terminations?: { x: number; y: number }[];
    width: number;
    height: number;
    rows: GraphRow[]; // The commits and spacer rows in display order
}
