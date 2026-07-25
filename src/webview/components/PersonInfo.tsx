/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as React from 'react';
import { getRelativeTimeString } from '../utils/time-utils';

export { getRelativeTimeString } from '../utils/time-utils';

export interface PersonInfoProps {
    person?: { name: string; email: string; timestamp: string };
    label: string;
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
    if (!person) {
        return null;
    }

    const { nameToDisplay, emailToDisplay, fullTime, relTime, hasEmail } = getPersonDisplayStrings(person);

    return (
        <div style={{ display: 'flex', alignItems: 'center', fontSize: '13px' }} className="person-info">
            <span style={{ color: 'var(--vscode-descriptionForeground)', marginRight: '6px', flexShrink: 0 }}>
                {label}:
            </span>
            <strong style={{ color: 'var(--vscode-foreground)', marginRight: '6px', flexShrink: 0 }}>
                {nameToDisplay}
            </strong>
            <span
                style={{
                    color: hasEmail ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-errorForeground)',
                    opacity: 0.7,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flexShrink: 1,
                    minWidth: 0,
                }}
                title={`<${emailToDisplay}>`}
            >
                &lt;{emailToDisplay}&gt;
            </span>
            <span style={{ color: 'var(--vscode-descriptionForeground)', margin: '0 6px', flexShrink: 0 }}>•</span>
            <span style={{ color: 'var(--vscode-foreground)', whiteSpace: 'nowrap', flexShrink: 0 }} title={fullTime}>
                {relTime}
            </span>
        </div>
    );
};
