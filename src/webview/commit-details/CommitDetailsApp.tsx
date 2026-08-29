/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as React from 'react';
import {
    type CommitDetailsHostToWebviewMessage,
    CommitDetailsHostToWebviewMessageSchema,
    type CommitDetailsPayload,
    type CommitDetailsToHostMessage,
    CommitDetailsToHostMessageSchema,
} from '../../common/ipc/commit-details-schemas';
import { CommitDetails } from '../components/CommitDetails';
import { useRpcReceiver, useRpcSender } from '../transport/BridgeContext';

export const CommitDetailsApp: React.FC = () => {
    const [detailsCommit, setDetailsCommit] = React.useState<CommitDetailsPayload | null>(null);
    const sender = useRpcSender<CommitDetailsToHostMessage>(CommitDetailsToHostMessageSchema);

    useRpcReceiver<CommitDetailsHostToWebviewMessage>(CommitDetailsHostToWebviewMessageSchema, {
        update: (payload) => {
            setDetailsCommit(payload);
        },
        saveComplete: ({ description }) => {
            setDetailsCommit((prev) => (prev ? { ...prev, description } : prev));
        },
        saveFailed: () => {},
        updateDescription: () => {},
    });

    React.useEffect(() => {
        void sender.webviewLoaded();
    }, [sender]);

    if (!detailsCommit) {
        return (
            <div style={{ padding: '20px', color: 'var(--vscode-descriptionForeground)' }}>
                Loading commit details...
            </div>
        );
    }

    return (
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
                if (detailsCommit.changeId) {
                    void sender.saveDescription({ changeId: detailsCommit.changeId, description });
                }
            }}
            onOpenDiff={(file, isImmutable) => {
                if (detailsCommit.changeId) {
                    void sender.openDiff({ changeId: detailsCommit.changeId, file, isImmutable });
                }
            }}
            onOpenMultiDiff={() => {
                if (detailsCommit.changeId) {
                    void sender.openMultiDiff({ changeId: detailsCommit.changeId });
                }
            }}
            onDescriptionChange={(description, selectionStart, selectionEnd) => {
                void sender.descriptionChanged({ description, selectionStart, selectionEnd });
            }}
        />
    );
};
