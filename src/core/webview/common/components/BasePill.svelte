<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { Snippet } from 'svelte';

interface Props {
    children?: Snippet;
    title?: string;
    className?: string;
    style?: string;
}

let { children, title, className = '', style = '' }: Props = $props();
</script>

<span
    {title}
    class="bookmark-pill {className}"
    {style}
>
    {@render children?.()}
</span>

<style>
    .bookmark-pill {
        border-radius: 11px;
        padding: 0 6px;
        font-size: inherit;
        line-height: normal;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        flex-shrink: 1;
        vertical-align: middle;
        box-sizing: border-box;
        border: 1px solid transparent;
        min-width: 22px;
        overflow: hidden;
        gap: 4px;
        user-select: none;
    }

    .bookmark-pill :global(.codicon) {
        font-size: 11px;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }

    .bookmark-pill :global(.pill-label) {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        line-height: normal;
        display: inline-block;
        transform: translateY(-1px);
    }
</style>

