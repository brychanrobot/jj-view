<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import BasePill from './BasePill.svelte';

interface Props {
    tag: string;
    style?: string;
}

let { tag, style = '' }: Props = $props();

const accentColor = 'var(--vscode-charts-green)';
const backgroundColor = `color-mix(in srgb, ${accentColor}, transparent 90%)`;
const borderColor = `color-mix(in srgb, ${accentColor}, transparent 50%)`;
</script>

<BasePill
    title={tag}
    style="background-color: {backgroundColor}; color: {accentColor}; border: 1px solid {borderColor}; {style}"
>
    <span aria-hidden="true" class="codicon codicon-tag"></span>
    <span class="pill-label">{tag}</span>
</BasePill>



