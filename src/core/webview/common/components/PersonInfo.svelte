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
        font-size: 13px;
    }

    .label {
        color: var(--vscode-descriptionForeground);
        margin-right: 6px;
        flex-shrink: 0;
    }

    .name {
        color: var(--vscode-foreground);
        margin-right: 6px;
        flex-shrink: 0;
    }

    .email {
        color: var(--vscode-descriptionForeground);
        opacity: 0.7;
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
        margin: 0 6px;
        flex-shrink: 0;
    }

    .time {
        color: var(--vscode-foreground);
        white-space: nowrap;
        flex-shrink: 0;
    }
</style>
