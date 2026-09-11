<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import {
    type CommitDetailsHostToWebviewMessage,
    CommitDetailsHostToWebviewMessageSchema,
    type CommitDetailsPayload,
    type CommitDetailsToHostMessage,
    CommitDetailsToHostMessageSchema,
} from '../../host/ipc/commit-details-schemas';
import { useRpcReceiver, useRpcSender } from '../transport/bridge.svelte';
import CommitDetails from './CommitDetails.svelte';

let detailsCommit = $state<CommitDetailsPayload | null>(null);
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
        commitId={detailsCommit.commitId || ''}
        description={detailsCommit.description || ''}
        files={detailsCommit.files || []}
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

