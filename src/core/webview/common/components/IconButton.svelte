<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
interface Props {
    onclick?: (e: MouseEvent) => void;
    onClick?: (e: MouseEvent) => void;
    title: string;
    icon: string;
    contextData?: Record<string, unknown>;
    disabled?: boolean;
    className?: string;
    style?: string;
    ariaLabel?: string;
}

let {
    onclick,
    onClick,
    title,
    icon,
    contextData,
    disabled = false,
    className = '',
    style = '',
    ariaLabel,
}: Props = $props();

let vscodeContext = $derived(contextData ? JSON.stringify(contextData) : undefined);

function handleClick(e: MouseEvent) {
    (onclick ?? onClick)?.(e);
}
</script>

<button
    type="button"
    class="icon-button {className}"
    {title}
    aria-label={ariaLabel || title}
    {disabled}
    {style}
    onclick={handleClick}
    data-vscode-context={vscodeContext}
>
    <span aria-hidden="true" class="codicon {icon}"></span>
</button>
