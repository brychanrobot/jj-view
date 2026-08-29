/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type React from 'react';
import type { JjBookmark } from '../../../jj-types';

export const BasePill: React.FC<{
    children: React.ReactNode;
    style?: React.CSSProperties;
    className?: string;
    title?: string;
}> = ({ children, style, className, title }) => (
    <span
        title={title}
        className={`bookmark-pill ${className || ''}`}
        style={{
            borderRadius: '11px',
            padding: '0 5px',
            fontSize: 'inherit',
            height: '22px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            flexShrink: 1,
            verticalAlign: 'middle',
            boxSizing: 'border-box',
            border: '1px solid transparent',
            minWidth: '22px',
            overflow: 'hidden',
            gap: '4px',
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
        <span
            data-vscode-context={JSON.stringify({
                webviewSection: 'jj.bookmark',
                bookmarkName: bookmark.name,
                isRemoteBookmark: !!bookmark.remote,
                preventDefaultContextMenuItems: true,
            })}
            style={{ display: 'inline-flex', alignItems: 'center', minWidth: '22px', flexShrink: 1 }}
        >
            <BasePill
                title={displayName}
                style={{
                    backgroundColor,
                    color: accentColor,
                    border: `1px solid ${borderColor}`,
                    ...style,
                }}
            >
                <span
                    aria-hidden="true"
                    className="codicon codicon-bookmark"
                    style={{ fontSize: '11px', flexShrink: 0 }}
                />
                <span
                    style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {displayName}
                </span>
            </BasePill>
        </span>
    );
};

export const TagPill: React.FC<{ tag: string; style?: React.CSSProperties }> = ({ tag, style }) => {
    const accentColor = 'var(--vscode-charts-green)'; // Using a distinct color for tags
    const backgroundColor = `color-mix(in srgb, ${accentColor}, transparent 90%)`;
    const borderColor = `color-mix(in srgb, ${accentColor}, transparent 50%)`;

    return (
        <BasePill
            title={tag}
            style={{
                backgroundColor,
                color: accentColor,
                border: `1px solid ${borderColor}`,
                ...style,
            }}
        >
            <span aria-hidden="true" className="codicon codicon-tag" style={{ fontSize: '11px', flexShrink: 0 }} />
            <span
                style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}
            >
                {tag}
            </span>
        </BasePill>
    );
};

export const WorkspacePill: React.FC<{ workspace: string; style?: React.CSSProperties }> = ({ workspace, style }) => {
    const accentColor = 'var(--vscode-charts-yellow)'; // Yellow/orange for workspaces
    const backgroundColor = `color-mix(in srgb, ${accentColor}, transparent 90%)`;
    const borderColor = `color-mix(in srgb, ${accentColor}, transparent 50%)`;

    return (
        <span
            data-vscode-context={JSON.stringify({
                webviewSection: 'workspace',
                workspaceName: workspace,
                preventDefaultContextMenuItems: true,
            })}
            style={{ display: 'inline-flex', alignItems: 'center', minWidth: '22px', flexShrink: 1 }}
        >
            <BasePill
                title={`${workspace}@`}
                style={{
                    backgroundColor,
                    color: accentColor,
                    border: `1px solid ${borderColor}`,
                    ...style,
                }}
            >
                <span
                    style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        direction: 'rtl',
                        textAlign: 'left',
                    }}
                >
                    <span style={{ direction: 'ltr', unicodeBidi: 'isolate' }}>{workspace}@</span>
                </span>
            </BasePill>
        </span>
    );
};
