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
    disabled?: boolean;
    className?: string;
    style?: React.CSSProperties;
    ariaLabel?: string;
}

export const IconButton: React.FC<IconButtonProps> = ({
    onClick,
    title,
    icon,
    contextData,
    disabled,
    className,
    style,
    ariaLabel,
}) => {
    return (
        <button
            type="button"
            className={`icon-button ${className || ''}`}
            title={title}
            aria-label={ariaLabel || title}
            disabled={disabled}
            style={style}
            onClick={onClick}
            data-vscode-context={contextData ? JSON.stringify(contextData) : undefined}
        >
            <span aria-hidden="true" className={`codicon ${icon}`}></span>
        </button>
    );
};
