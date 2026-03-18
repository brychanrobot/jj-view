/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';

export interface PersonInfoProps {
    person?: { name: string; email: string; timestamp: string };
    label: string;
}

export function getRelativeTimeString(timestamp: string): string {
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

export function getPersonDisplayStrings(person: { name: string; email: string; timestamp: string }) {
    const hasName = !!person.name && person.name !== '•';
    const hasEmail = !!person.email;

    const nameToDisplay = hasName ? person.name : hasEmail ? person.email : '(no name set)';
    const emailToDisplay = hasEmail ? person.email : '(no email set)';

    const fullTime = new Date(person.timestamp).toLocaleString();
    let relTime = person.timestamp;
    try {
        relTime = getRelativeTimeString(person.timestamp);
    } catch {
        // fallback to just rendering the timestamp string
    }

    return { nameToDisplay, emailToDisplay, fullTime, relTime, hasEmail };
}

export const PersonInfo: React.FC<PersonInfoProps> = ({ person, label }) => {
    if (!person) return null;

    const { nameToDisplay, emailToDisplay, fullTime, relTime, hasEmail } = getPersonDisplayStrings(person);

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }} className="person-info">
            <span style={{ color: 'var(--vscode-descriptionForeground)' }}>{label}:</span>
            <strong style={{ color: 'var(--vscode-foreground)' }}>{nameToDisplay}</strong>
            <span
                style={{
                    color: hasEmail ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-errorForeground)',
                    opacity: 0.7,
                }}
            >
                &lt;{emailToDisplay}&gt;
            </span>
            <span style={{ color: 'var(--vscode-descriptionForeground)', margin: '0 4px' }}>•</span>
            <span style={{ color: 'var(--vscode-foreground)' }} title={fullTime}>
                {relTime}
            </span>
        </div>
    );
};
