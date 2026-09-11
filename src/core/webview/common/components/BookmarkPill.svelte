<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { JjBookmark } from '../../../jj-types';
import BasePill from './BasePill.svelte';

interface Props {
    bookmark: JjBookmark;
    style?: string;
}

let { bookmark, style = '' }: Props = $props();

let displayName = $derived(bookmark.remote ? `${bookmark.name}@${bookmark.remote}` : bookmark.name);
let accentColor = $derived(bookmark.remote ? 'var(--vscode-charts-purple)' : 'var(--vscode-charts-blue)');
let backgroundColor = $derived(`color-mix(in srgb, ${accentColor}, transparent 90%)`);
let borderColor = $derived(`color-mix(in srgb, ${accentColor}, transparent 50%)`);

let vscodeContext = $derived(
    JSON.stringify({
        webviewSection: 'jj.bookmark',
        bookmarkName: bookmark.name,
        isRemoteBookmark: !!bookmark.remote,
        preventDefaultContextMenuItems: true,
    }),
);
</script>

<span
    data-vscode-context={vscodeContext}
    class="bookmark-wrapper"
>
    <BasePill
        title={displayName}
        style="background-color: {backgroundColor}; color: {accentColor}; border: 1px solid {borderColor}; {style}"
    >
        <span aria-hidden="true" class="codicon codicon-bookmark"></span>
        <span class="pill-label">{displayName}</span>
    </BasePill>
</span>

<style>
    .bookmark-wrapper {
        display: inline-flex;
        align-items: center;
        min-width: 22px;
        flex-shrink: 1;
    }
</style>

