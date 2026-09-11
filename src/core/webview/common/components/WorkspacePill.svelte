<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import BasePill from './BasePill.svelte';

interface Props {
    workspace: string;
    style?: string;
}

let { workspace, style = '' }: Props = $props();

const accentColor = 'var(--vscode-charts-yellow)';
const backgroundColor = `color-mix(in srgb, ${accentColor}, transparent 90%)`;
const borderColor = `color-mix(in srgb, ${accentColor}, transparent 50%)`;

let vscodeContext = $derived(
    JSON.stringify({
        webviewSection: 'workspace',
        workspaceName: workspace,
        preventDefaultContextMenuItems: true,
    }),
);
</script>

<span
    data-vscode-context={vscodeContext}
    class="workspace-wrapper"
>
    <BasePill
        title="{workspace}@"
        style="background-color: {backgroundColor}; color: {accentColor}; border: 1px solid {borderColor}; {style}"
    >
        <span class="pill-label">
            <span class="isolate-dir">{workspace}@</span>
        </span>
    </BasePill>
</span>

<style>
    .workspace-wrapper {
        display: inline-flex;
        align-items: center;
        min-width: 22px;
        flex-shrink: 1;
    }

    .pill-label {
        direction: rtl;
        text-align: left;
    }

    .isolate-dir {
        direction: ltr;
        unicode-bidi: isolate;
    }
</style>

