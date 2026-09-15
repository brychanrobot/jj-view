<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import {
    type CommitDetailsHostToWebviewMessage,
    CommitDetailsHostToWebviewMessageSchema,
    type CommitDetailsPayload,
    CommitDetailsPayloadSchema,
    type CommitDetailsToHostMessage,
    CommitDetailsToHostMessageSchema,
} from '../../host/ipc/commit-details-schemas';
import { useRpcReceiver, useRpcSender } from '../transport/bridge.svelte';
import CommitDetails from './CommitDetails.svelte';

interface Props {
    initialCommit?: CommitDetailsPayload;
}

let { initialCommit }: Props = $props();

function getInitialCommit(): CommitDetailsPayload | null {
    if (typeof document === 'undefined') {
        return null;
    }
    const scriptEl = document.getElementById('__INITIAL_STATE__');
    if (!scriptEl?.textContent) {
        return null;
    }
    try {
        const raw: unknown = JSON.parse(scriptEl.textContent);
        const parsed = CommitDetailsPayloadSchema.safeParse(raw);
        if (parsed.success) {
            return parsed.data;
        }
    } catch {
        // Fallback to null on parse failure
    }
    return null;
}

let detailsCommit = $state<CommitDetailsPayload | null>(initialCommit ?? getInitialCommit());

$effect(() => {
    if (initialCommit) {
        detailsCommit = initialCommit;
    }
});
const sender = useRpcSender<CommitDetailsToHostMessage>(CommitDetailsToHostMessageSchema);

useRpcReceiver<CommitDetailsHostToWebviewMessage>(CommitDetailsHostToWebviewMessageSchema, {
    update: (payload) => {
        detailsCommit = payload;
    },
    saveComplete: ({ description }) => {
        if (detailsCommit) {
            detailsCommit = { ...detailsCommit, description };
        }
    },
    saveFailed: () => {},
    updateDescription: () => {},
});

$effect(() => {
    void sender.webviewLoaded();
});
</script>

{#if !detailsCommit}
    <div class="loading-state">
        Loading commit details...
    </div>
{:else}
    <CommitDetails
        changeId={detailsCommit.changeId || ''}
        changeIdShortest={detailsCommit.changeIdShortest}
        isDivergent={detailsCommit.isDivergent}
        changeIdOffset={detailsCommit.changeIdOffset}
        commitId={detailsCommit.commitId || ''}
        description={detailsCommit.description || ''}
        files={detailsCommit.files || []}
        isLoadingFiles={detailsCommit.isLoadingFiles ?? false}
        isImmutable={detailsCommit.isImmutable || false}
        isEmpty={detailsCommit.isEmpty}
        isConflict={detailsCommit.isConflict}
        author={detailsCommit.author}
        committer={detailsCommit.committer}
        bookmarks={detailsCommit.bookmarks}
        tags={detailsCommit.tags}
        titleWidthRuler={detailsCommit.titleWidthRuler}
        bodyWidthRuler={detailsCommit.bodyWidthRuler}
        minChangeIdLength={detailsCommit.minChangeIdLength}
        onSave={(description) => {
            if (detailsCommit?.changeId) {
                void sender.saveDescription({ changeId: detailsCommit.changeId, description });
            }
        }}
        onOpenDiff={(file, isImmutable) => {
            if (detailsCommit?.changeId) {
                void sender.openDiff({ changeId: detailsCommit.changeId, file, isImmutable });
            }
        }}
        onOpenMultiDiff={() => {
            if (detailsCommit?.changeId) {
                void sender.openMultiDiff({ changeId: detailsCommit.changeId });
            }
        }}
        onDescriptionChange={(description, selectionStart, selectionEnd) => {
            void sender.descriptionChanged({ description, selectionStart, selectionEnd });
        }}
    />
{/if}

<style>
    .loading-state {
        padding: 20px;
        color: var(--vscode-descriptionForeground);
    }
</style>

