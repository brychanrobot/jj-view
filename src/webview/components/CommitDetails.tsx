/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import { formatCommitDescription } from '../../utils/format-utils';
import { JjStatusEntry } from '../../jj-types';
import { BookmarkPill, BasePill, TagPill } from './Bookmark';
import { formatDisplayChangeId } from '../../utils/jj-utils';
import { PersonInfo } from './PersonInfo';

interface CommitDetailsProps {
    changeId: string;
    commitId: string;
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
    committer?: { name: string; email: string; timestamp: string };
    bookmarks?: Array<{ name: string; remote?: string }>;
    tags?: string[];
    titleWidthRuler?: number;
    bodyWidthRuler?: number;
    minChangeIdLength?: number;
    onSave: (description: string) => void;
    onOpenDiff: (file: JjStatusEntry, isImmutable: boolean) => void;
    onOpenMultiDiff: () => void;
    onDirtyStateChange?: (isDirty: boolean, draftDescription: string) => void;
}

export const CommitDetails: React.FC<CommitDetailsProps> = ({
    changeId,
    commitId,
    description,
    files,
    isImmutable,
    isEmpty,
    isConflict,
    author,
    committer,
    bookmarks,
    tags,
    titleWidthRuler = 50,
    bodyWidthRuler = 72,
    minChangeIdLength = 1,
    onSave,
    onOpenDiff,
    onOpenMultiDiff,
    onDirtyStateChange,
}) => {
    const [draftDescription, setDraftDescription] = React.useState(description);
    const draftDescriptionRef = React.useRef(draftDescription);
    const [isSaving, setIsSaving] = React.useState(false);

    // Keep the ref strictly in sync with the state for use inside effects
    // that shouldn't re-run on every keystroke.
    React.useEffect(() => {
        draftDescriptionRef.current = draftDescription;
    }, [draftDescription]);

    const isDirty = draftDescription !== description;

    const saveTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const backdropRef = React.useRef<HTMLDivElement>(null);
    const prevDescriptionRef = React.useRef(description);

    React.useEffect(() => {
        // Synchronize the draft description with the canonical description from the backend.
        // We only overwrite the draft if the user hasn't made any unsaved edits (the draft
        // matches the previous description), or if the only difference is trailing whitespace
        // (to account for formatting adjustments applied by jj during save).
        if (
            draftDescriptionRef.current === prevDescriptionRef.current ||
            draftDescriptionRef.current.trimEnd() === description.trimEnd()
        ) {
            setDraftDescription(description);
        }
        setIsSaving(false);
        prevDescriptionRef.current = description;
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    }, [description]);

    React.useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (event.data.type === 'saveFailed') {
                setIsSaving(false);
                if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    React.useEffect(() => {
        if (onDirtyStateChange) {
            onDirtyStateChange(isDirty, draftDescription);
        }
    }, [isDirty, draftDescription, onDirtyStateChange]);

    const handleSave = () => {
        setIsSaving(true);

        // jj enforces a trailing newline. Ensure we have one so our state matches what jj will return
        let finalDescription = draftDescription;
        if (!finalDescription.endsWith('\n')) {
            finalDescription += '\n';
            setDraftDescription(finalDescription);
        }

        onSave(finalDescription);

        // Fallback to clear the saving state after 15s in case of silent failure
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = setTimeout(() => setIsSaving(false), 15000);
    };

    const handleFormat = async () => {
        const newDescription = await formatCommitDescription(draftDescription, bodyWidthRuler);
        if (newDescription !== draftDescription) {
            setDraftDescription(newDescription);
        }
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
                    <span style={{ backgroundColor: 'var(--vscode-input-background)' }}>
                        {line.substring(0, limit)}
                    </span>
                    <span
                        style={{
                            color: 'var(--vscode-errorForeground)',
                            backgroundColor: 'var(--vscode-input-background)',
                        }}
                    >
                        {line.substring(limit)}
                    </span>
                </span>,
            );
        } else {
            highlightedElements.push(
                <span key={`line-${i}`} style={{ backgroundColor: 'var(--vscode-input-background)' }}>
                    {line}
                </span>,
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
                    <div
                        style={{
                            display: 'flex',
                            gap: '6px',
                            flexWrap: 'wrap',
                            fontSize: '11px',
                            fontWeight: 'normal',
                        }}
                    >
                        {isImmutable && (
                            <BasePill
                                style={badgeStyle('var(--vscode-gitDecoration-untrackedResourceForeground)')}
                                title="This commit cannot be modified"
                            >
                                Immutable
                            </BasePill>
                        )}
                        {isEmpty && (
                            <BasePill
                                style={badgeStyle('var(--vscode-gitDecoration-ignoredResourceForeground)')}
                                title="This commit has no file changes"
                            >
                                Empty
                            </BasePill>
                        )}
                        {isConflict && (
                            <BasePill
                                style={badgeStyle('var(--vscode-gitDecoration-conflictingResourceForeground)')}
                                title="This commit has unresolved conflicts"
                            >
                                Conflicted
                            </BasePill>
                        )}
                        {bookmarks?.map((b) => (
                            <BookmarkPill key={`${b.name}-${b.remote}`} bookmark={b} />
                        ))}
                        {tags?.map((t) => (
                            <TagPill key={t} tag={t} />
                        ))}
                    </div>
                </h2>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '13px', color: 'var(--vscode-descriptionForeground)' }}>Change:</span>
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
                                alignItems: 'center',
                            }}
                        >
                            <span className="codicon codicon-copy" style={{ fontSize: '14px' }}></span>
                        </button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '13px', color: 'var(--vscode-descriptionForeground)' }}>Commit:</span>
                        <span
                            style={{ fontSize: '13px', color: 'var(--vscode-foreground)', fontFamily: 'monospace' }}
                            title={commitId}
                        >
                            {commitId.substring(0, 12)}
                        </span>
                        <button
                            onClick={() => navigator.clipboard.writeText(commitId)}
                            title="Copy Commit ID"
                            style={{
                                background: 'none',
                                border: 'none',
                                padding: '2px',
                                cursor: 'pointer',
                                color: 'var(--vscode-icon-foreground)',
                                display: 'flex',
                                alignItems: 'center',
                            }}
                        >
                            <span className="codicon codicon-copy" style={{ fontSize: '14px' }}></span>
                        </button>
                    </div>

                    <PersonInfo person={author} label="Author" />
                    <PersonInfo person={committer} label="Committer" />
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
                                gap: '4px',
                            }}
                        >
                            <span className="codicon codicon-settings-gear"></span>
                        </a>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        {!isImmutable && (
                            <>
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
                                        gap: '4px',
                                    }}
                                >
                                    <span className="codicon codicon-word-wrap"></span>
                                    Format Body
                                </button>
                                <button
                                    title={`Save Changes (${navigator.platform.toUpperCase().indexOf('MAC') >= 0 ? '⌘S' : 'Ctrl+S'})`}
                                    onClick={handleSave}
                                    disabled={isSaving || !isDirty}
                                    className={isDirty && !isSaving ? 'btn-dirty' : ''}
                                    style={{
                                        padding: '2px 8px',
                                        color: 'var(--vscode-button-foreground)',
                                        backgroundColor: isDirty
                                            ? 'var(--vscode-button-background)'
                                            : 'var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background))',
                                        border: '1px solid transparent',
                                        cursor: isSaving || !isDirty ? 'default' : 'pointer',
                                        opacity: isSaving ? 0.7 : !isDirty ? 0.6 : 1,
                                        display: 'flex',
                                        alignItems: 'center',
                                        fontSize: '12px',
                                        gap: '4px',
                                        borderRadius: '2px',
                                        transition: 'background-color 0.2s, color 0.2s',
                                    }}
                                >
                                    <span className={`codicon ${isDirty ? 'codicon-save' : 'codicon-check'}`}></span>
                                    {isSaving
                                        ? 'Saving...'
                                        : isDirty
                                          ? `Save Changes (${navigator.platform.toUpperCase().indexOf('MAC') >= 0 ? '⌘S' : 'Ctrl+S'})`
                                          : 'Saved'}
                                </button>
                            </>
                        )}
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
                        disabled={isImmutable}
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
                        .btn-dirty .codicon-save {
                            animation: jiggle-icon 2s infinite ease-in-out;
                            display: inline-block;
                            transform-origin: center;
                        }
                        @keyframes jiggle-icon {
                            0%, 65%, 100% { transform: rotate(0deg); }
                            70% { transform: rotate(12deg); }
                            77% { transform: rotate(-8deg); }
                            84% { transform: rotate(4deg); }
                            91% { transform: rotate(-2deg); }
                            98% { transform: rotate(0deg); }
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
                            borderRadius: '2px',
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
        border: `1px solid color-mix(in srgb, ${color}, transparent 50%)`,
        backgroundColor: `color-mix(in srgb, ${color}, transparent 90%)`,
        color: color,
        textTransform: 'uppercase',
        fontWeight: 'bold',
    };
}
