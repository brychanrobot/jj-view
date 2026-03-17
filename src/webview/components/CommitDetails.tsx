/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import wordWrap from 'word-wrap';
import { JjStatusEntry } from '../../jj-types';
import { BookmarkPill } from './Bookmark';
import { formatDisplayChangeId } from '../../utils/jj-utils';

interface CommitDetailsProps {
    changeId: string;
    description: string;
    files: Array<{
        path: string;
        status: string;
        additions?: number;
        deletions?: number;
    }>;
    isImmutable: boolean;
    isEmpty?: boolean;
    isConflict?: boolean;
    author?: { name: string; email: string; timestamp: string };
    bookmarks?: Array<{ name: string; remote?: string }>;
    titleWidthRuler?: number;
    bodyWidthRuler?: number;
    minChangeIdLength?: number;
    onSave: (description: string) => void;
    onOpenDiff: (file: JjStatusEntry, isImmutable: boolean) => void;
    onOpenMultiDiff: () => void;
}

export const CommitDetails: React.FC<CommitDetailsProps> = ({
    changeId,
    description,
    files,
    isImmutable,
    isEmpty,
    isConflict,
    author,
    bookmarks,
    titleWidthRuler = 50,
    bodyWidthRuler = 72,
    minChangeIdLength = 1,
    onSave,
    onOpenDiff,
    onOpenMultiDiff,
}) => {
    const [draftDescription, setDraftDescription] = React.useState(description);
    const [isSaving, setIsSaving] = React.useState(false);

    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const backdropRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        setDraftDescription(description);
    }, [description]);

    const handleSave = () => {
        setIsSaving(true);
        onSave(draftDescription);
        // We expect the backend to maybe close this panel or provide feedback
        // For now, simple loading state
        setTimeout(() => setIsSaving(false), 1000);
    };

    const handleFormat = () => {
        const lines = draftDescription.split('\n');
        if (lines.length <= 1) return; // Nothing to format if it's just the title

        const title = lines[0];
        const bodyLines = lines.slice(1);
        
        // Find the first non-empty line after the title to start formatting
        let bodyStartIndex = 0;
        while (bodyStartIndex < bodyLines.length && bodyLines[bodyStartIndex].trim() === '') {
            bodyStartIndex++;
        }

        const emptyPrefix = '\n'.repeat(bodyStartIndex);
        const contentToFormat = bodyLines.slice(bodyStartIndex).join('\n');

        if (contentToFormat.trim() === '') return; // Nothing to format

        // Preserve paragraph breaks (double newlines) by splitting, formatting, and rejoining
        const paragraphs = contentToFormat.split(/\n\s*\n/);
        const formattedParagraphs = paragraphs.map(p => 
            wordWrap(p, { width: bodyWidthRuler, trim: true, indent: '' })
        );

        const newDescription = `${title}\n${emptyPrefix}${formattedParagraphs.join('\n\n')}`;
        setDraftDescription(newDescription);
    };

    const renderRuler = (width: number, isTitle: boolean, color: string) => (
        <div
            style={{
                position: 'absolute',
                top: isTitle ? '10px' : 'calc(10px + 1.5em)', // title is on first line, body is after, padded by 10px
                bottom: isTitle ? 'auto' : '10px', 
                height: isTitle ? '1.5em' : 'auto',
                left: `calc(10px + ${width}ch)`, // text starts 10px in due to padding
                width: '1px',
                backgroundColor: color,
                pointerEvents: 'none',
                zIndex: 1, // Behind the backdrop text
            }}
        />
    );

    const lines = draftDescription.split('\n');
    const title = lines[0] ?? '';
    const bodyLines = lines.slice(1);

    const isTitleOver = title.length > titleWidthRuler;
    const isBodyOver = bodyLines.some((l) => l.length > bodyWidthRuler);

    const titleRulerColor = isTitleOver ? 'var(--vscode-errorForeground)' : 'var(--vscode-editorRuler-foreground)';
    const bodyRulerColor = isBodyOver ? 'var(--vscode-errorForeground)' : 'var(--vscode-editorRuler-foreground)';

    const highlightedElements = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const limit = i === 0 ? titleWidthRuler : bodyWidthRuler;
        const isOver = line.length > limit;

        if (isOver) {
            highlightedElements.push(
                <span key={`line-${i}`}>
                    <span style={{ backgroundColor: 'var(--vscode-input-background)' }}>{line.substring(0, limit)}</span>
                    <span style={{ color: 'var(--vscode-errorForeground)', backgroundColor: 'var(--vscode-input-background)' }}>{line.substring(limit)}</span>
                </span>
            );
        } else {
            highlightedElements.push(
                <span key={`line-${i}`} style={{ backgroundColor: 'var(--vscode-input-background)' }}>
                    {line}
                </span>
            );
        }
        if (i < lines.length - 1) {
            highlightedElements.push('\n');
        }
    }

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100vh',
                padding: '20px',
                boxSizing: 'border-box',
                backgroundColor: 'var(--vscode-editor-background)',
                color: 'var(--vscode-editor-foreground)',
                fontFamily: 'var(--vscode-editor-font-family)',
            }}
        >
            {/* Header */}
            <div style={{ marginBottom: '12px' }}>
                <h2 style={{ margin: '0 0 10px 0', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    Commit Details
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {isImmutable && (
                            <span style={badgeStyle('var(--vscode-gitDecoration-untrackedResourceForeground)')} title="This commit cannot be modified">
                                Immutable
                            </span>
                        )}
                        {isEmpty && (
                            <span style={badgeStyle('var(--vscode-gitDecoration-ignoredResourceForeground)')} title="This commit has no file changes">
                                Empty
                            </span>
                        )}
                        {isConflict && (
                            <span style={badgeStyle('var(--vscode-gitDecoration-conflictingResourceForeground)')} title="This commit has unresolved conflicts">
                                Conflict
                            </span>
                        )}
                        {bookmarks?.map((b) => (
                            <BookmarkPill key={`${b.name}-${b.remote}`} bookmark={b} />
                        ))}
                    </div>
                </h2>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '13px', color: 'var(--vscode-descriptionForeground)' }}>ID:</span>
                        <span
                            style={{ fontSize: '13px', color: 'var(--vscode-foreground)', fontFamily: 'monospace' }}
                            title={changeId}
                        >
                            {formatDisplayChangeId(changeId, changeId, minChangeIdLength)}
                        </span>
                        <button 
                            onClick={() => navigator.clipboard.writeText(changeId)}
                            title="Copy Change ID"
                            style={{
                                background: 'none',
                                border: 'none',
                                padding: '2px',
                                cursor: 'pointer',
                                color: 'var(--vscode-icon-foreground)',
                                display: 'flex',
                                alignItems: 'center'
                            }}
                        >
                            <span className="codicon codicon-copy" style={{ fontSize: '14px' }}></span>
                        </button>
                    </div>
                    {author && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
                            <span style={{ color: 'var(--vscode-descriptionForeground)' }}>Author:</span>
                            <strong style={{ color: 'var(--vscode-foreground)' }}>{author.name}</strong>
                            <span style={{ color: 'var(--vscode-descriptionForeground)', margin: '0 4px' }}>•</span>
                            <span style={{ color: 'var(--vscode-foreground)' }}>{getRelativeTimeString(author.timestamp)}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Description Editor */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px', flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <label style={{ fontWeight: 'bold' }}>Message</label>
                        <a 
                            href="command:workbench.action.openSettings?%5B%22jj-view.commit%22%5D"
                            title="Configure width rulers"
                            style={{ 
                                fontSize: '11px',
                                color: 'var(--vscode-textLink-foreground)',
                                textDecoration: 'none',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px'
                            }}
                        >
                            <span className="codicon codicon-settings-gear"></span>
                        </a>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            onClick={handleFormat}
                            title={`Format body to ${bodyWidthRuler} characters`}
                            style={{
                                background: 'none',
                                border: 'none',
                                padding: '2px 4px',
                                cursor: 'pointer',
                                color: 'var(--vscode-textLink-foreground)',
                                display: 'flex',
                                alignItems: 'center',
                                fontSize: '12px',
                                gap: '4px'
                            }}
                        >
                            <span className="codicon codicon-word-wrap"></span>
                            Format Body
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={isSaving}
                            style={{
                                padding: '2px 8px',
                                color: 'var(--vscode-button-foreground)',
                                backgroundColor: 'var(--vscode-button-background)',
                                border: 'none',
                                cursor: 'pointer',
                                opacity: isSaving ? 0.7 : 1,
                                display: 'flex',
                                alignItems: 'center',
                                fontSize: '12px',
                                gap: '4px',
                                borderRadius: '2px'
                            }}
                        >
                            <span className="codicon codicon-save"></span>
                            {isSaving ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </div>
                <div 
                    style={{ 
                        position: 'relative', 
                        flex: 1, 
                        display: 'flex', 
                        backgroundColor: 'var(--vscode-input-background)',
                        border: '1px solid var(--vscode-input-border)',
                        fontFamily: 'var(--vscode-editor-font-family), monospace',
                        fontSize: 'var(--vscode-editor-font-size)',
                        lineHeight: '1.5em',
                        minHeight: '150px',
                        overflow: 'hidden',
                    }}
                >
                    <div
                        ref={backdropRef}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            overflow: 'hidden',
                            pointerEvents: 'none',
                            zIndex: 1,
                        }}
                    >
                        <div
                            style={{
                                position: 'relative',
                                minWidth: '100%',
                                minHeight: '100%',
                                padding: '10px',
                                boxSizing: 'border-box',
                                color: 'var(--vscode-input-foreground)',
                                whiteSpace: 'pre',
                                overflowWrap: 'normal',
                            }}
                        >
                            {renderRuler(titleWidthRuler, true, titleRulerColor)}
                            {renderRuler(bodyWidthRuler, false, bodyRulerColor)}
                            <div style={{ position: 'relative', zIndex: 2 }}>
                                {highlightedElements}
                                {draftDescription.endsWith('\n') ? <br /> : null}
                            </div>
                        </div>
                    </div>
                    <textarea
                        className="commit-textarea"
                        ref={textareaRef}
                        value={draftDescription}
                        onChange={(e) => setDraftDescription(e.target.value)}
                        onScroll={() => {
                            if (backdropRef.current && textareaRef.current) {
                                backdropRef.current.scrollTop = textareaRef.current.scrollTop;
                                backdropRef.current.scrollLeft = textareaRef.current.scrollLeft;
                            }
                        }}
                        onKeyDown={(e) => {
                            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                            const hasModifier = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
                            if (hasModifier && e.key === 's') {
                                e.preventDefault();
                                e.stopPropagation();
                                handleSave();
                            }
                        }}
                        style={{
                            flex: 1,
                            backgroundColor: 'transparent',
                            color: 'transparent',
                            caretColor: 'var(--vscode-input-foreground)',
                            border: 'none',
                            padding: '10px',
                            resize: 'none',
                            outline: 'none',
                            fontFamily: 'inherit',
                            fontSize: 'inherit',
                            lineHeight: 'inherit',
                            zIndex: 2,
                            whiteSpace: 'pre',
                            overflowWrap: 'normal',
                            overflowX: 'auto',
                        }}
                    />
                    <style>{`
                        .commit-textarea::selection {
                            color: transparent !important;
                            background-color: var(--vscode-editor-selectionBackground) !important;
                        }
                    `}</style>
                </div>
            </div>

            {/* Changed Files */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, maxHeight: '40%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <label style={{ fontWeight: 'bold' }}>Changed Files ({files.length})</label>
                        <span style={{ fontSize: '11px', fontFamily: 'monospace' }}>
                            <span style={{ color: 'var(--vscode-gitDecoration-addedResourceForeground)' }}>
                                +{files.reduce((acc, f) => acc + (f.additions || 0), 0)}
                            </span>
                            <span style={{ margin: '0 4px', opacity: 0.5 }}>/</span>
                            <span style={{ color: 'var(--vscode-gitDecoration-deletedResourceForeground)' }}>
                                -{files.reduce((acc, f) => acc + (f.deletions || 0), 0)}
                            </span>
                        </span>
                    </div>
                    <button
                        onClick={onOpenMultiDiff}
                        style={{
                            padding: '2px 8px',
                            color: 'var(--vscode-button-foreground)',
                            backgroundColor: 'var(--vscode-button-secondaryBackground)',
                            border: 'none',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            fontSize: '12px',
                            gap: '4px',
                            borderRadius: '2px'
                        }}
                    >
                        <span className="codicon codicon-diff"></span>
                        Multi-file Diff
                    </button>
                </div>
                <div
                    style={{
                        flex: 1,
                        border: '1px solid var(--vscode-widget-border)',
                        overflowY: 'auto',
                    }}
                >
                    {files.length === 0 ? (
                        <div
                            style={{
                                padding: '10px',
                                color: 'var(--vscode-descriptionForeground)',
                                fontStyle: 'italic',
                            }}
                        >
                            No changed files.
                        </div>
                    ) : (
                        files.map((file, idx) => (
                            <div
                                key={idx}
                                onClick={() => onOpenDiff(file as unknown as JjStatusEntry, isImmutable)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    padding: '6px 10px',
                                    fontSize: '13px',
                                    cursor: 'pointer',
                                    borderBottom: '1px solid var(--vscode-tree-tableOddRowsBackground)',
                                }}
                                onMouseEnter={(e) =>
                                    (e.currentTarget.style.backgroundColor = 'var(--vscode-list-hoverBackground)')
                                }
                                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                            >
                                <span
                                    className={`codicon codicon-${getFileIcon(file.status)}`}
                                    style={{
                                        marginRight: '8px',
                                        color: getFileColor(file.status),
                                    }}
                                ></span>
                                <span
                                    title={file.path}
                                    style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                                >
                                    {file.path}
                                </span>
                                <span
                                    style={{
                                        marginLeft: 'auto',
                                        fontSize: '11px',
                                        display: 'flex',
                                        gap: '8px',
                                        color: 'var(--vscode-descriptionForeground)',
                                    }}
                                >
                                    {(file.additions !== undefined || file.deletions !== undefined) && (
                                        <span style={{ fontFamily: 'monospace' }}>
                                            <span
                                                style={{ color: 'var(--vscode-gitDecoration-addedResourceForeground)' }}
                                            >
                                                +{file.additions || 0}
                                            </span>
                                            <span style={{ margin: '0 4px', opacity: 0.5 }}>/</span>
                                            <span
                                                style={{
                                                    color: 'var(--vscode-gitDecoration-deletedResourceForeground)',
                                                }}
                                            >
                                                -{file.deletions || 0}
                                            </span>
                                        </span>
                                    )}
                                    <span style={{ minWidth: '60px', textAlign: 'right' }}>{file.status}</span>
                                </span>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};

// Helper for file status icons and colors
function getFileIcon(status: string): string {
    switch (status) {
        case 'added':
            return 'diff-added';
        case 'removed':
            return 'diff-removed';
        case 'modified':
            return 'diff-modified';
        case 'renamed':
            return 'diff-renamed';
        default:
            return 'file';
    }
}

function getFileColor(status: string): string {
    switch (status) {
        case 'added':
            return 'var(--vscode-gitDecoration-addedResourceForeground)';
        case 'removed':
            return 'var(--vscode-gitDecoration-deletedResourceForeground)';
        case 'modified':
            return 'var(--vscode-gitDecoration-modifiedResourceForeground)';
        case 'renamed':
            return 'var(--vscode-gitDecoration-renamedResourceForeground)';
        default:
            return 'var(--vscode-foreground)';
    }
}

// Helpers

function badgeStyle(color: string): React.CSSProperties {
    return {
        fontSize: '10px',
        padding: '2px 6px',
        borderRadius: '10px',
        border: `1px solid ${color}`,
        color: color,
        textTransform: 'uppercase',
        fontWeight: 'bold',
    };
}

function getRelativeTimeString(timestamp: string): string {
    const time = new Date(timestamp).getTime();
    if (isNaN(time)) return timestamp;

    const now = Date.now();
    const diff = now - time;
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    return 'just now';
}
