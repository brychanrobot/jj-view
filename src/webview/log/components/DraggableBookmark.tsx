/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { useDraggable } from '@dnd-kit/core';
import type * as React from 'react';
import type { JjBookmark } from '../../../jj-types';
import { BookmarkPill } from '../../common/components/Bookmark';

export const DraggableBookmark: React.FC<{ bookmark: JjBookmark }> = ({ bookmark }) => {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `bookmark-${bookmark.name}-${bookmark.remote || 'local'}`,
        data: { type: 'bookmark', name: bookmark.name, remote: bookmark.remote },
        disabled: !!bookmark.remote,
    });

    if (bookmark.remote) {
        return <BookmarkPill bookmark={bookmark} />;
    }

    const style: React.CSSProperties = {
        cursor: isDragging ? 'grabbing' : 'grab',
        opacity: isDragging ? 0.3 : 1, // Show pending state
        filter: isDragging ? 'grayscale(100%)' : 'none',
        display: 'inline-flex',
        alignItems: 'center',
        minWidth: '22px',
        flexShrink: 1,
    };

    return (
        <span ref={setNodeRef} style={style} {...listeners} {...attributes}>
            <BookmarkPill bookmark={bookmark} />
        </span>
    );
};
