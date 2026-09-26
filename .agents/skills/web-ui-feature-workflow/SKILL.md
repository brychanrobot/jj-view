---
name: web-ui-feature-workflow
description: End-to-end workflow for implementing web UI features, applying theme-defined styling, capturing visual E2E tests and animated GIFs, and executing the bottom-up JJ squash workflow.
---

# Web UI Feature Development & Visual Verification Workflow

## 1. UI Styling & Component Guidelines

- **Theme-Defined CSS Variables**: Always use `var(--vscode-...)` tokens for all colors, backgrounds, borders, and focus rings. Never introduce hardcoded hex colors into component styles:
  - **Surfaces & Borders**: `var(--vscode-editor-background)`, `var(--vscode-sideBar-background)`, `var(--vscode-widget-border)`.
  - **Headers & Dividers**: `var(--vscode-editorGroupHeader-tabsBackground)`, `var(--vscode-editorGroupHeader-tabsBorder)`.
  - **Inputs & Focus**: `var(--vscode-input-background)`, `var(--vscode-input-border)`, `var(--vscode-input-foreground)`, `var(--vscode-focusBorder)`.
  - **Lists & Selection**: `var(--vscode-list-activeSelectionBackground)`, `var(--vscode-list-activeSelectionForeground)`, `var(--vscode-list-hoverBackground)`.
  - **Typography**: `var(--vscode-foreground)`, `var(--vscode-descriptionForeground)`, `var(--vscode-font-family)`, `var(--vscode-font-size)`.
- **Header & Container Standards**: Use standard `35px` header heights and `6px` container border radii to maintain visual harmony with existing views (`CommitDetailsView.svelte`, `SettingsModal.svelte`).
- **Clean Labels**: Keep user-facing titles clean of self-referential app prefixes and raw implementation IDs.
- **Manifest Filtering**: Evaluate menu contribution `when` conditions to suppress hidden commands.

## 2. Visual E2E Verification & GIF Recording

Use the `recordGifFlow` test helper from `standalone-fixture.ts` to capture step-by-step UI flows:

```typescript
import { recordGifFlow } from './standalone-fixture';

test('should demonstrate feature flow', async ({ page, server }) => {
    await page.goto(server.serverUrl);
    await waitForScmReady(page);

    await recordGifFlow(page, async (capture) => {
        await capture(); // initial view
        await triggerAction();
        await capture(); // state after action
        await completeAction();
        await capture(); // final state
    }, { outputPath: path.join(ARTIFACT_DIR, 'feature-flow.gif') });
});
```

Embed the resulting GIFs and high-resolution screenshots into `walkthrough.md`.

## 3. Bottom-Up JJ Squash Workflow

When applying changes across existing commits in a stack:
1. Target the earliest commit needing edits: `jj new <commit-id>` (via shell with `BypassSandbox: true`). Never use `jj edit`.
2. Implement changes in `@`.
3. Verify all checks pass before squashing:
   - `pnpm build:web`
   - `pnpm check-types`
   - `pnpm fix-lint`
   - `pnpm test:unit <test-path>`
   - `pnpm test:e2e:web <spec-path>`
4. Squash into target: `jj_squash` with `description_strategy: "use_destination_message"`.
5. Advance to descendant commits (`jj new <descendant-id>`), resolve downstream updates, verify, and squash until the stack is clean.
