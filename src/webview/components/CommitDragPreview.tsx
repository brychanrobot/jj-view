/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as React from 'react';
import type { JjLogEntry } from '../../jj-types';
import { getChangeIdDisplayLength, shortenChangeId } from '../../utils/jj-utils';
import { BUILT_IN_MODIFIERS, type DragActionModifier, REBASE_BRANCH_MODIFIER } from '../utils/drag-modifiers';

const AVAILABLE_MODIFIERS = BUILT_IN_MODIFIERS.filter((m) => m.id !== 'rebase-branch');
// Put 2 longest modifiers (Squash Onto, Squash Into) in row 1, remaining 3 (Duplicate, Merge, Rebase Rev) in row 2
const MODIFIER_ROW1 = AVAILABLE_MODIFIERS.slice(0, 2);
const MODIFIER_ROW2 = AVAILABLE_MODIFIERS.slice(2);

export const CommitDragPreview: React.FC<{
    commit: JjLogEntry;
    activeModifier?: DragActionModifier;
    minChangeIdLength: number;
}> = ({ commit, activeModifier: activeModifierProp, minChangeIdLength }) => {
    // Mode Logic
    const activeModifier = activeModifierProp || REBASE_BRANCH_MODIFIER;

    const activeColor = activeModifier.accentColor;

    // ID Formatting
    const fullId = commit.commit_id || '';
    const idDisplayLength = getChangeIdDisplayLength(commit.change_id_shortest, minChangeIdLength);
    const shortId = commit.change_id_shortest || shortenChangeId(fullId, idDisplayLength);
    const remainderId = fullId.substring(shortId.length, idDisplayLength);

    const renderModifierBadge = (modifier: DragActionModifier) => {
        const isCurrent = activeModifier.id === modifier.id;
        return (
            <span
                key={modifier.id}
                style={{
                    ...styles.badgeContainer,
                    backgroundColor: isCurrent
                        ? 'var(--vscode-keybindingTable-headerBackground, rgba(255, 255, 255, 0.12))'
                        : 'transparent',
                    border: isCurrent ? `1px solid ${activeColor}` : '1px solid transparent',
                }}
            >
                <kbd
                    style={{
                        ...styles.badgeKbd,
                        color: isCurrent ? activeColor : 'var(--vscode-keybindingLabel-foreground, inherit)',
                        fontWeight: isCurrent ? 'bold' : 'normal',
                    }}
                >
                    {modifier.shortcutHint}
                </kbd>
                <span
                    style={{
                        ...styles.badgeLabel,
                        color: isCurrent ? activeColor : 'var(--vscode-descriptionForeground)',
                        fontWeight: isCurrent ? 'bold' : 'normal',
                    }}
                >
                    {modifier.shortLabel || modifier.label}
                </span>
            </span>
        );
    };

    return (
        <div style={styles.card}>
            <div style={styles.contentRow}>
                {/* Left Handle */}
                <div
                    style={{
                        ...styles.leftHandle,
                        backgroundColor: activeColor,
                    }}
                />

                {/* Content Area */}
                <div style={styles.contentArea}>
                    {/* Row 1: Description (Primary) */}
                    <div style={styles.descriptionRow}>{commit.description || '(no description)'}</div>

                    {/* Row 2: ID + Status */}
                    <div style={styles.idStatusRow}>
                        {/* ID */}
                        <span style={styles.idSpan}>
                            <span style={styles.shortId}>{shortId}</span>
                            <span style={styles.remainderId}>{remainderId}</span>
                        </span>

                        {/* Separator */}
                        <span style={styles.dotSeparator}>•</span>

                        {/* Action Label */}
                        <span style={{ ...styles.actionLabel, color: activeColor }}>{activeModifier.label}</span>
                    </div>
                </div>
            </div>

            {/* Bottom Shortcut Hint Footer */}
            <div style={styles.footer}>
                <div style={styles.footerDescriptionRow}>
                    <span>
                        <strong style={{ color: activeColor }}>{activeModifier.shortcutHint}</strong>:{' '}
                        {activeModifier.description}
                    </span>
                </div>
                <div style={styles.badgeMatrix}>
                    <div style={styles.badgeRow}>{MODIFIER_ROW1.map(renderModifierBadge)}</div>
                    <div style={styles.badgeRow}>{MODIFIER_ROW2.map(renderModifierBadge)}</div>
                </div>
            </div>
        </div>
    );
};

const styles: Record<string, React.CSSProperties> = {
    card: {
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--vscode-editor-background)',
        border: '1px solid var(--vscode-focusBorder)',
        borderRadius: '4px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        width: '300px',
        overflow: 'hidden',
        fontFamily: 'var(--vscode-editor-font-family)',
        fontSize: 'var(--vscode-editor-font-size)',
        transition: 'none',
        willChange: 'transform',
        pointerEvents: 'none',
    },
    contentRow: {
        display: 'flex',
        flexDirection: 'row',
        height: '48px',
    },
    leftHandle: {
        width: '6px',
        height: '100%',
        flexShrink: 0,
    },
    contentArea: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 10px',
        minWidth: 0,
    },
    descriptionRow: {
        fontWeight: 'bold',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        marginBottom: '2px',
        color: 'var(--vscode-foreground)',
    },
    idStatusRow: {
        display: 'flex',
        alignItems: 'center',
        fontSize: '0.9em',
        color: 'var(--vscode-descriptionForeground)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
    },
    idSpan: {
        fontFamily: 'var(--vscode-editor-font-family)',
        marginRight: '8px',
        display: 'flex',
    },
    shortId: {
        color: 'var(--vscode-gitDecoration-addedResourceForeground)',
        fontWeight: 'bold',
    },
    remainderId: {
        opacity: 0.7,
    },
    dotSeparator: {
        marginRight: '8px',
        opacity: 0.5,
    },
    actionLabel: {
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
    },
    footer: {
        backgroundColor: 'var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,0.05))',
        borderTop: '1px solid var(--vscode-widget-border, rgba(255,255,255,0.1))',
        padding: '6px 8px',
        fontSize: '0.75em',
        color: 'var(--vscode-descriptionForeground)',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        fontFamily: 'var(--vscode-editor-font-family)',
    },
    footerDescriptionRow: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    },
    badgeMatrix: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        fontSize: '0.95em',
        backgroundColor: 'var(--vscode-sideBar-background, var(--vscode-editorWidget-background, rgba(0, 0, 0, 0.2)))',
        border: '1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08))',
        borderRadius: '3px',
        padding: '4px 6px',
        marginTop: '2px',
        overflow: 'hidden',
    },
    badgeRow: {
        display: 'flex',
        gap: '6px',
        alignItems: 'center',
        overflow: 'hidden',
    },
    badgeContainer: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        padding: '1px 4px',
        borderRadius: '3px',
        whiteSpace: 'nowrap',
    },
    badgeKbd: {
        fontSize: '0.85em',
        fontFamily: 'var(--vscode-editor-font-family)',
        padding: '0 3px',
        borderRadius: '3px',
        backgroundColor: 'var(--vscode-keybindingLabel-background, rgba(0, 0, 0, 0.2))',
        border: '1px solid var(--vscode-keybindingLabel-border, rgba(255, 255, 255, 0.2))',
        whiteSpace: 'nowrap',
    },
    badgeLabel: {
        whiteSpace: 'nowrap',
    },
};
