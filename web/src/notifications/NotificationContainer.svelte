<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import NotificationToast from './NotificationToast.svelte';
import type { NotificationService } from './notification-service';
import type { NotificationItem, NotificationPosition } from './notification-types';

interface Props {
    service: NotificationService;
}

let { service }: Props = $props();

let items = $state<readonly NotificationItem[]>([]);
let position = $state<NotificationPosition>('bottom-right');

let unsubscribeNotifications: (() => void) | null = null;
let unsubscribePosition: (() => void) | null = null;

onMount(() => {
    items = service.items;
    position = service.position;

    const notifSub = service.onDidChangeNotifications((newItems) => {
        items = newItems;
    });
    unsubscribeNotifications = notifSub.dispose;

    const posSub = service.onDidChangePosition((newPos) => {
        position = newPos;
    });
    unsubscribePosition = posSub.dispose;
});

onDestroy(() => {
    if (unsubscribeNotifications) {
        unsubscribeNotifications();
    }
    if (unsubscribePosition) {
        unsubscribePosition();
    }
});
</script>

{#if items.length > 0}
    <div
        class="notification-container pos-{position}"
        data-testid="notification-container"
        data-position={position}
        aria-live="polite"
    >
        {#each items as item (item.id)}
            <NotificationToast
                {item}
                onAction={(action) => service.triggerAction(item.id, action)}
                onDismiss={() => service.dismiss(item.id)}
            />
        {/each}
    </div>
{/if}

<style>
.notification-container {
    position: fixed;
    z-index: 1500;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
    box-sizing: border-box;
}

/* Position Configurations */
.pos-bottom-right {
    bottom: 32px;
    right: 16px;
    align-items: flex-end;
}

.pos-bottom-left {
    bottom: 32px;
    left: 16px;
    align-items: flex-start;
}

.pos-top-right {
    top: 16px;
    right: 16px;
    align-items: flex-end;
}

.pos-top-left {
    top: 16px;
    left: 16px;
    align-items: flex-start;
}
</style>
