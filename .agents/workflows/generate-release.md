---
description: Generate release notes for a new version
---

Steps:
1. Use `grep_search` to find `version` in `package.json`.
2. Find the most recent tag. You can check GitHub or use `git describe --tags --abbrev=0 --match "v*"` if you have git available.
3. Check if the most recent tag string (e.g. `v1.15.2`) matches the version found in `package.json` (e.g. `1.15.2`).
4. If they match, it means a version bump is needed:
   a. Ask the system to read all commit messages since the previous tag using `jj log -r '<previous_tag>..@' -T 'description "\n"' --no-graph`.
   b. Analyze the commit messages to determine the correct next version (patch, minor, or major bump) based on standard conventions (e.g., `feat:` is minor, `fix:` is patch).
   c. Update the `version` field in `package.json` with the new version.
   d. Commit the change using `jj commit -m "chore: bump version to <new_version>"`.
5. If they do not match, assume the version in `package.json` is already correct and fetch the commit messages since the most recent tag using `jj log -r '<previous_tag>..@' -T 'description "\n"' --no-graph` if you haven't already.
6. Generate nicely formatted, categorized release notes (e.g., Features, Fixes, Chores).
7. Update `CHANGELOG.md` by prepending the new version and release notes.
8. Use `npm run release:encode -- "<release_notes>"` (script located at `.agents/scripts/encode-release-notes.ts`) to encode the release notes.
9. Generate a GitHub release link: `https://github.com/brychanrobot/jj-view/releases/new?tag=v<version>&title=v<version>&body=<encoded_notes>`.
10. Present the **Release Notes** and the **one-click Release Link** directly to the user in the final chat response.
11. Include links to both marketplaces in the release notes:
    - [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jj-view.jj-view)
    - [Open VSX](https://open-vsx.org/extension/jj-view/jj-view)
12. Add a **CI Note**: A clear reminder that CI handles the binary (VSIX) upload automatically after publishing the release.
13. Instruct the user to push changes via `jj git push` before clicking the link.
14. (Optional) Update the task.md but do NOT create a walkthrough.md for the release itself.