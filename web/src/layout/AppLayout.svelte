<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { Snippet } from 'svelte';
import SplitPane from './SplitPane.svelte';

interface Props {
    repoPath?: string;
    onRefresh?: () => void;
    scm?: Snippet;
    log?: Snippet;
    main?: Snippet;
}

let { scm, log, main }: Props = $props();
</script>

<div class="app-shell" data-testid="app-shell">
    <main class="app-main-content">
        <SplitPane direction="horizontal" initialSize={340} minSize={220} maxSize={650}>
            {#snippet left()}
                <SplitPane direction="vertical" initialSize={380} minSize={150} maxSize={800}>
                    {#snippet left()}
                        {@render scm?.()}
                    {/snippet}
                    {#snippet right()}
                        {@render log?.()}
                    {/snippet}
                </SplitPane>
            {/snippet}
            {#snippet right()}
                {@render main?.()}
            {/snippet}
        </SplitPane>
    </main>
</div>

<style>
.app-shell {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background-color: var(--vscode-editor-background, #171717);
    color: var(--vscode-foreground, #d4d4d4);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    overflow: hidden;
}

.app-main-content {
    flex-grow: 1;
    height: 100%;
    width: 100%;
    min-height: 0;
    overflow: hidden;
    position: relative;
}
</style>
