# Changelog

## 1.28.0

### Features

- **QuickPick**: Support searching revision QuickPick by description and detail to allow native VS Code filtering to match against descriptions and long change IDs.
- **Squash**: Simplify squash completion workflow by removing the custom confirmation dialog and relying entirely on VS Code's native file save and tab closure behavior.
- **Diff**: Fix diff gutter for renamed files by correctly mapping the original resource to the file's previous path.
- **Gerrit**: Detect outdated Gerrit parent pointers after rebases to identify commits as "Needs Upload" when their local parent pointers no longer match the latest patchsets on the server.

### Fixes

- **Squash**:
    - Standardize squash operations and terminology to unify internal service methods, command logic, and user-facing command names for "Revision", "File", and "Hunk" operations.
    - Refactor partial move to "Squash Partial" with performance gains by consolidating commands and utilizing cached diffs to eliminate redundant CLI calls.
- **Log View**: Hide Edit action for current working copy to remove redundant UI actions when the selected commit is already the working copy.
- **CLI**: Improve cross-platform non-interactive command execution to ensure commands never hang or prompt for interactive input, particularly on Windows.

### Chores & Maintenance

- **Tooling**: Ensure `watch:themes` task completes in VS Code by logging a completion message so the task does not hang.


## 1.27.0

### Features

- **Ghost Nodes**: Implement ghost node visualization for hidden commits in the graph.
- **Diff**: Add `jj-view.openDiffOnClick` configuration option. When enabled (default), clicking a file in the SCM view opens the diff editor; when disabled, the regular file editor is opened instead.
- **Gerrit**: Support `Link:` trailers for more robust Gerrit CL identification and sync status.
- **Workspace**: Automatically hide the `.jj` directory from the VS Code explorer.

### Chores & Maintenance

- **Testing**: Significant stability improvements and expanded coverage for E2E tests.
- **Tooling**: Migrate tooling scripts to native Node.js TypeScript support and automate asset generation.


## 1.26.0

### Features

- **File Comparison**: Compare specific files from an arbitrary revision to the working copy.
- **Multi-File Diff**: View changes across the entire repository from an arbitrary revision to the working copy.
- **Drag Rebase**: Add progress notification for drag rebase operations.
- **Commit Description**: Add option to format description body on save.
- **File Revert**: Support reverting file changes on mutable ancestor commits.

### Fixes

- **Quick Diff**: Fix discarding middle of file deletions in quick diff.
- **Workspace**: Handle serialization of atypical workspace names in getLog.
- **Commit Graph**: Refactor commit graph layout to use renderdag.

### Chores & Maintenance

- **Tooling**: Migrate linting and formatting to Biome.


## 1.25.0

### Features

- **Log View**:
    - Added the ability to **hide commit hover actions** via a right-click context menu, matching native VS Code behavior.

### Improvements & Refactors

- **UI**:
    - Refined **metadata pill responsiveness** (bookmarks, tags, workspaces) to allow graceful shrinking and prevent layout clipping in narrow views.

### Chores & Maintenance

- **Tooling**:
    - Made **automatic bookmarks** (e.g. `up-123`) shorter for better readability in the log view.
    - Decoupled format and license checks from the `lint` script to make dev and CI faster.

## 1.24.0

### Features

- **Workspaces**:
    - Added **Workspace Management** support, allowing you to forget or delete workspaces directly from a new **context menu on workspace pills** in the Log View.
    - Introduced the **Add Workspace** command to easily create new Jujutsu workspaces, accessible via the command palette or a new **button in the JJ Log view title**.
    - New `jj-view.workspacesLocation` setting for customizing where new workspaces are created.
- **SCM & Commit Details**:
    - **Deleted Files**: Improved handling of deleted files in the SCM view and Commit Details, ensuring they can be opened for diffing and display the correct red 'diff-removed' icons.
    - **Copied Files**: Added explicit support for copied files in Commit Details, showing the green 'diff-added' icon.

### Fixes

- **UI**:
    - Ensured the **Log View** automatically refreshes when returning to focus, keeping Gerrit status and repo changes up-to-date.
    - Added an automatic SCM refresh after a successful **Upload**.

### Chores & Maintenance

- **Testing**: Significant stabilization of **E2E tests** for Log and Commit Details views, with improved webview frame handling and diagnostic logging.
- **Repository**: Added periodic stale check configuration to the repository.

## 1.23.0

### Features

- **Log View**:
    - Added support for **dynamic graph themes** (Oceanic, Sunset, Neon, Pastel, Monochrome).
    - Implement **Redo** command, accessible from the view title and context menus.

### Fixes

- **Log View**:
    - Improved **compact graph label alignment** to prevent overlapping with vertical graph edges.
    - Fixed vertical alignment of **bookmarks and status pills**, ensuring a consistent UI in both log and detail views.
- **Workspaces**: Fixed op_heads change detection in secondary Jujutsu workspaces by correctly resolving repository store paths from file links.

### Chores & Maintenance

- **Tooling**: Introduces a repository-specific JJ configuration system to automate code formatting and simplify upload workflows.
- **Publishing**: Added --no-dependencies to Open VSX publication to support pnpm's symlinked node_modules structure.
- **CI**: Optimized the CI pipeline by **parallelizing test execution** and sharing build artifacts across jobs.
- **Testing**:
    - Stabilized E2E tests for the **Settings editor**, ensuring robust detection across different VS Code layouts.
    - Significant cleanup of Playwright test output and refactoring of `TestRepo` metadata helpers.

## 1.22.0

### Features

- **Log View**: Implement **visual graph elision** to hide large gaps in commit history.
- **Log View**: Support **multi-workspace pills**, identifying all working copies associated with a commit.
- **Log View**: Add visualization for **divergent commits**, including purple highlights and change ID offsets (e.g., `/1`).
- **SCM**: Add **"Upload"** action to the commit context menu for easier Gerrit/Git pushing.
- **Configuration**: New `jj-view.binaryPath` setting to manually specify the `jj` location, with active validation on startup.

### Fixes

- **Quick Diff**: Migrated to a native `FileSystemProvider` to eliminate flaky gutter decoration refreshes.
- **Quick Diff**: Fixed "Added" decorations incorrectly showing for untracked or ignored files.
- **Commit Details**: Resolved an issue where selected text was unreadable due to the backdrop highlight pattern.
- **Log View**: Fixed selection state remaining active on the graph after closing a commit details panel.

### Improvements & Refactors

- **Commit Details**: Large-scale refactor for **typing performance**, implementing an uncontrolled textarea and a debounced bridge to VS Code’s native Undo/Redo API.
- **SCM**: Refactored upload command logic to improve flexibility for custom `uploadCommand` configurations.

### Chores & Maintenance

- **Project**: Fully migrated the repository from npm to **pnpm**.
- **CI**: Updated all GitHub Actions to latest major versions and standardized on **Node.js 24**.
- **Testing**: Significant stabilization of E2E and integration tests, particularly on **Windows CI**, using path canonicalization and robust event synchronization.
- **Formatting**: Integrated `@trivago/prettier-plugin-sort-imports` for consistent project-wide import ordering.
- **Build**: Skip `@parcel/watcher` binary downloads if correct version is already present.

## 1.21.1

### Fixes

- **Windows Diff Views**: Fix empty left-side diff view on Windows by simplifying URI paths.
- **Move to Child**: Dynamically resolve the actual child commit and prompt when multiple exist.
- **File Explorer Decorations**: Eliminate visual flicker of ignored files during SCM refreshes.

## 1.21.0

### Features

- Add "New After" command and group context menu items
- Migrate Commit Details to Custom Editor API
- Add compact graph label alignment config option
- Prompt to save unsaved description on commit details close
- Add dirty state indicators to Commit Details view
- Show ignored file decorations in the Explorer pane
- Add `JJ_VIEW_EXTENSION` environment variable for conditional config
- Exclude immutable commits from the SCM pane
- Add action to delete stale `.git/index.lock` on error
- Add more time units to the relative time string (up to years) for
  author/committer timestamps.
- Improve commit description formatting using Prettier
- Recommend disabling built-in Git extension when exploring git-colocated repositories

### Fixes

- Allow explicitly empty commit descriptions
- Hide editor actions for immutable commits
- Fix commit details dirty indicator for empty descriptions
- Ellipsize long emails in commit details header
- Fix CLI invocations by explicitly disabling UI formatting
- Fix error handling and add tests for checkTrackedPaths
- Fix flaky file watcher e2e test by forcing explorer refresh

### Chores

- Docs: update README with missing features and commands
- Test: run `TestRepo.exec` without user configs

## 1.20.0

### Features

- **Commit Details**: Show commit author, committer, and tags in details view.

### Fixes

- **Styling**: Improve styling and alignment of status and bookmark pills.
- **Auto-Update**: The commit details panel now automatically updates when the underlying commit changes or is abandoned.
- **Graph Layout**: Curve graph edges around intersecting nodes to prevent lines drawing through unrelated nodes.
- **Diff Cache Resolution**: Fixed an issue where diff views and merge conflicts would fail to load when a VS Code workspace is a subdirectory of a jj repository. The extension now correctly maps absolute workspace paths to repo-relative paths for bulk diff cache lookups.
- **Initialization**: Prevent the extension from trying to initialize file watchers when a workspace does not contain a `.jj` directory in its root.

## 1.19.0

### Features

- Enhance Commit Details page with new features and UI refinements
    - Add rich header info (Author, relative timestamp)
    - Display status badges (Immutable, Conflict, Empty) and Bookmarks
    - Show individual and total file diff stats (additions/deletions)
    - Implement configurable title and body width rulers with Settings deep link
    - Add "Format Body" button to automatically wrap commit descriptions
    - Add click-to-copy utility for the commit ID
    - Refine text area styling and ruler highlighting for character length overages
    - Enhance overall page layout and button placement for better readability

## 1.18.1

### Fixes

- Improve JJ Log graph layout to match native `jj log` behavior and fix visual bugs:
    - Collapse converging branches to the left lane
    - Allow secondary parents to reuse freed lanes to prevent unnecessary graph expansion
    - Ensure left swim lanes always appear on top
    - Use diamond shape for immutable commits
    - Fix lines drawing through hollow commit nodes

## 1.18.0

### Features

- Add theme support for JJ log webview
- Add formatting to other commands

### Chores & Improvements

- Add several skills to help with development
- Run prettier

## 1.17.0

### Features

- Implement "Squash into Ancestor" feature
- Show multiple ancestors in the SCM pane
- Implement `jj-view.minChangeIdLength` setting

### Fixes

- **Gerrit**:
    - Fix upload error ("r.substring is not a function")
    - Ensure children inherit `needsUpload` status from parents
- Prevent `.git/index.lock` contention in `getGitBlobHashes`
- Fix visibility of "Squash" inline actions

### Chores & Improvements

- Tune the performance of refreshes
- Refine gitignore pattern parsing for file watcher
- Added E2E Playwright tests that run against the VSIX

## 1.16.1

### Fixes

- **Gerrit**: The Upload button now correctly appears when you modify a commit's description. Previously, it only detected changes to file contents.

## 1.16.0

### Features

- Added `describe-prompt` command, which allows users to set a change description using a quick input dialog instead of opening a full text editor.

### Fixes

- Fixed broken save description button.
- Removed the redundant "Committed change" toast notification that appeared after using the commit prompt, for a cleaner and less intrusive user experience.

### Chores

- Cleaned up vitest logs by silencing intentionally triggered console errors.

## 1.15.3

### Fixed

- **CI/CD**: Fixed an issue where the extension artifact was not correctly attached to GitHub releases.

## 1.15.2

### Fixed

- **Fixed Silent Failures in Diffs and Merge Conflicts**: Moved `diffedit` operations—used to capture changes for **diff views** and **merge conflict resolution**—to platform-native shell and batch scripts. This resolves a bug where the extension would fail silently if the `node` binary was not explicitly in the system `PATH`, resulting in broken diff views and unresponsive merge conflict resolution.
