<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { getFileIcon } from './file-icons';

interface Props {
    filename: string;
}

let { filename }: Props = $props();

const icon = $derived(getFileIcon(filename));
</script>

<span class="file-icon-wrapper" aria-hidden="true" data-testid={`file-icon-${filename}`}>
    {#if icon.type === 'svg'}
        {@html icon.svg}
    {:else if icon.type === 'badge'}
        <span class="file-icon-badge" style="color: {icon.color};">
            {icon.text}
        </span>
    {:else if icon.type === 'codicon'}
        <i class={`codicon ${icon.codicon}`} style="color: {icon.color}; font-size: 14px;"></i>
    {/if}
</span>

<style>
.file-icon-wrapper {
    width: 16px;
    height: 16px;
    min-width: 16px;
    max-width: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    align-self: center;
    flex-shrink: 0;
    user-select: none;
    box-sizing: border-box;
}

.file-icon-badge {
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.4px;
    font-family: var(--vscode-font-family, system-ui, Ubuntu, "Droid Sans", sans-serif);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-align: center;
}
</style>
