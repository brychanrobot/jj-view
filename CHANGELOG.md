# Changelog

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
