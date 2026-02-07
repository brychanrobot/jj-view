/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useDraggable } from '@dnd-kit/core';
import { JjBookmark } from '../../jj-types';

export const BasePill: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
    <span
        style={{
            marginRight: '6px',
            borderRadius: '10px',
            padding: '0 8px',
            fontSize: 'inherit',
            height: '22px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            verticalAlign: 'middle',
            border: '1px solid transparent',
            ...style,
        }}
    >
        {children}
    </span>
);

export const BookmarkPill: React.FC<{ bookmark: JjBookmark; style?: React.CSSProperties }> = ({ bookmark, style }) => {
    const displayName = bookmark.remote ? `${bookmark.name}@${bookmark.remote}` : bookmark.name;
    const accentColor = bookmark.remote ? 'var(--vscode-charts-purple)' : 'var(--vscode-charts-blue)';

    // Use a tinted style: subtle background, colored text, reduced border
    const backgroundColor = `color-mix(in srgb, ${accentColor}, transparent 90%)`;
    const borderColor = `color-mix(in srgb, ${accentColor}, transparent 50%)`;

    return (
        <BasePill
            style={{
                backgroundColor,
                color: accentColor,
                border: `1px solid ${borderColor}`,
                ...style,
            }}
        >
            <span
                className="codicon codicon-bookmark"
                style={{ marginRight: '4px', fontSize: '11px', flexShrink: 0 }}
            />
            {displayName}
        </BasePill>
    );
};

export const DraggableBookmark: React.FC<{ bookmark: JjBookmark }> = ({ bookmark }) => {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `bookmark-${bookmark.name}-${bookmark.remote || 'local'}`,
        data: { type: 'bookmark', name: bookmark.name, remote: bookmark.remote },
        disabled: !!bookmark.remote,
    });

    if (bookmark.remote) {
        return <BookmarkPill bookmark={bookmark} />;
    }

    const style = {
        cursor: isDragging ? 'grabbing' : 'grab',
        opacity: isDragging ? 0.3 : 1, // Show pending state
        filter: isDragging ? 'grayscale(100%)' : 'none',
    };

    return (
        <span ref={setNodeRef} style={style} {...listeners} {...attributes}>
            <BookmarkPill bookmark={bookmark} />
        </span>
    );
};
