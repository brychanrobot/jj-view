# Changelog

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
