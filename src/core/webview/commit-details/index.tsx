/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import '@vscode-elements/elements';
import { createRoot } from 'react-dom/client';
import { BridgeProvider } from '../transport/BridgeContext';
import { CommitDetailsApp } from './CommitDetailsApp';

const rootElement = document.getElementById('root');
if (rootElement) {
    const root = createRoot(rootElement);
    root.render(
        <BridgeProvider>
            <CommitDetailsApp />
        </BridgeProvider>,
    );
}
