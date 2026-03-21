/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';

export interface PersonInfoProps {
    person?: { name: string; email: string; timestamp: string };
    label: string;
}

export function getRelativeTimeString(timestamp: string, now: number | null = null): string {
    const time = new Date(timestamp).getTime();
    if (isNaN(time)) return timestamp;

    // If we assume a year is 365.25 days:
    const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;
    const SECONDS_PER_MONTH = SECONDS_PER_YEAR / 12;

    const diffMs = (now ?? Date.now()) - time;
    // This function only works for timestamps in the past.
    // (We could make it work for timestamps in the future, but that isn't a valid input for now.)
    if (diffMs < 0) return timestamp;

    // Display a single unit of time from seconds to years.
    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(seconds / SECONDS_PER_MONTH);
    const years = Math.floor(seconds / SECONDS_PER_YEAR);
    for (const [x, unit] of [
        [years, 'year'],
        [months, 'month'],
        [weeks, 'week'],
        [days, 'day'],
        [hours, 'hour'],
        [minutes, 'minute'],
        [seconds, 'second'],
    ] satisfies Array<[number, string]>) {
        if (x > 0) {
            return `${x} ${unit}${x > 1 ? 's' : ''} ago`;
        }
    }
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
        <div style={{ display: 'flex', alignItems: 'center', fontSize: '13px' }} className="person-info">
            <span style={{ color: 'var(--vscode-descriptionForeground)', marginRight: '6px', flexShrink: 0 }}>{label}:</span>
            <strong style={{ color: 'var(--vscode-foreground)', marginRight: '6px', flexShrink: 0 }}>{nameToDisplay}</strong>
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
