<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { getPersonDisplayStrings, type PersonInfoProps } from '../utils/person-utils';

let { person, label }: PersonInfoProps = $props();

let displayStrings = $derived(person ? getPersonDisplayStrings(person) : null);
</script>

{#if person && displayStrings}
    <div class="person-info">
        <span class="label">{label}:</span>
        <strong class="name">{displayStrings.nameToDisplay}</strong>
        <span
            class="email"
            class:no-email={!displayStrings.hasEmail}
            title="<{displayStrings.emailToDisplay}>"
        >
            &lt;{displayStrings.emailToDisplay}&gt;
        </span>
        <span aria-hidden="true" class="dot-separator">•</span>
        <time
            dateTime={person.timestamp}
            class="time"
            title={displayStrings.fullTime}
        >
            {displayStrings.relTime}
        </time>
    </div>
{/if}

<style>
    .person-info {
        display: flex;
        align-items: center;
        font-size: 12px;
        line-height: 1.5;
        gap: 2px;
        flex-wrap: wrap;
    }

    .label {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        margin-right: 4px;
        flex-shrink: 0;
    }

    .name {
        color: var(--vscode-foreground);
        font-weight: 600;
        margin-right: 4px;
        flex-shrink: 0;
    }

    .email {
        color: var(--vscode-descriptionForeground);
        opacity: 0.75;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex-shrink: 1;
        min-width: 0;
    }

    .email.no-email {
        color: var(--vscode-errorForeground);
    }

    .dot-separator {
        color: var(--vscode-descriptionForeground);
        opacity: 0.4;
        margin: 0 4px;
        flex-shrink: 0;
    }

    .time {
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
        flex-shrink: 0;
    }
</style>
