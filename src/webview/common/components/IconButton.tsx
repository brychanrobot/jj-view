/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as React from 'react';

interface IconButtonProps {
    onClick: (e: React.MouseEvent) => void;
    title: string;
    icon: string; // codicon class name, e.g., 'codicon-plus'
    contextData?: Record<string, unknown>; // Data for data-vscode-context
}

export const IconButton: React.FC<IconButtonProps> = ({ onClick, title, icon, contextData }) => {
    return (
        <button
            type="button"
            className="icon-button"
            title={title}
            aria-label={title}
            onClick={onClick}
            data-vscode-context={contextData ? JSON.stringify(contextData) : undefined}
        >
            <span className={`codicon ${icon}`}></span>
        </button>
    );
};
