// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as React from 'react';

interface CommitDetailsProps {
    commitId: string;
    description: string;
    files: Array<{
        path: string;
        status: string;
        additions?: number;
        deletions?: number;
    }>;
    onSave: (description: string) => void;
    onOpenDiff: (filePath: string) => void;
}

export const CommitDetails: React.FC<CommitDetailsProps> = ({ commitId, description, files, onSave, onOpenDiff }) => {
    const [draftDescription, setDraftDescription] = React.useState(description);
    const [isSaving, setIsSaving] = React.useState(false);

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
            <div style={{ marginBottom: '20px' }}>
                <h2 style={{ margin: '0 0 10px 0' }}>Commit Details</h2>
                <div
                    style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', fontFamily: 'monospace' }}
                >
                    ID: {commitId}
                </div>
            </div>

            {/* Description Editor */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px', flex: 1 }}>
                <label style={{ fontWeight: 'bold' }}>Message</label>
                <textarea
                    value={draftDescription}
                    onChange={(e) => setDraftDescription(e.target.value)}
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
                        backgroundColor: 'var(--vscode-input-background)',
                        color: 'var(--vscode-input-foreground)',
                        border: '1px solid var(--vscode-input-border)',
                        padding: '10px',
                        resize: 'none',
                        outline: 'none',
                        fontFamily: 'inherit',
                        minHeight: '150px',
                    }}
                />
            </div>

            {/* Changed Files */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, maxHeight: '40%' }}>
                <label style={{ fontWeight: 'bold' }}>Changed Files ({files.length})</label>
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
                                onClick={() => onOpenDiff(file.path)}
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

            {/* Footer Actions */}
            <div
                style={{
                    marginTop: '20px',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '10px',
                }}
            >
                <button
                    onClick={handleSave}
                    disabled={isSaving}
                    style={{
                        padding: '8px 16px',
                        color: 'var(--vscode-button-foreground)',
                        backgroundColor: 'var(--vscode-button-background)',
                        border: 'none',
                        cursor: 'pointer',
                        opacity: isSaving ? 0.7 : 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                    }}
                >
                    <span className="codicon codicon-save"></span>
                    {isSaving ? 'Saving...' : 'Save Description'}
                </button>
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
