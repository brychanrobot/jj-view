---
name: generate_release
description: Generate release notes for a new version
---

# Generate Release Notes

This skill details the process for generating release notes and bumping the version of the `jj-view` extension. 

## Context

Use this skill when the user wants to cut a new release of the extension. It requires reading commit history, determining the next version number, updating the changelog, and preparing a GitHub release link.

## Execution Steps

1.  **Check Current Version:** Read the `version` field in `package.json`.
2.  **Find Most Recent Tag:** Find the most recent git tag. You can use `git describe --tags --abbrev=0 --match "v*"` if git is available.
3.  **Determine if Bump Needed:** Check if the most recent tag string (e.g., `v1.15.2`) matches the version found in `package.json` (e.g., `1.15.2`).
4.  **Version Bump Logic (If Match):** If the tag and `package.json` version *match*, a version bump is needed:
    *   Read all commit messages since the previous tag using `jj log -r '<previous_tag>..@' -T 'description "\n"' --no-graph`.
    *   Analyze the commit messages to determine the correct next version (patch, minor, or major bump) based on standard conventions (e.g., `feat:` is minor, `fix:` is patch).
    *   Update the `version` field in `package.json` with the new version.
5.  **Fetch Commits (If No Match):** If they *do not match*, assume the version in `package.json` was already bumped manually and is correct. Fetch the commit messages since the most recent tag using `jj log -r '<previous_tag>..@' -T 'description "\n"' --no-graph`.
6.  **Draft Release Notes:** Generate nicely formatted, categorized release notes (e.g., Features, Fixes, Chores) from the commits.
7.  **Update Changelog:** Update `CHANGELOG.md` by prepending the new version and the drafted release notes.
8.  **CRITICAL - User Review:** Use the `notify_user` tool to present the proposed changes (updated `CHANGELOG.md` and `package.json`) to the user. **Wait for their approval before proceeding.**
9.  **Commit Changes:** After user approval, commit the changes using `jj commit -m "chore: bump version to <new_version>"`.
10. **Encode Notes:** Use the encoding script to encode the release notes for a URL: `npm run release:encode -- "<release_notes>"`. The script is located at `.agents/scripts/encode-release-notes.ts`.
11. **Generate Release Link:** Craft a GitHub release link: `https://github.com/brychanrobot/jj-view/releases/new?tag=v<version>&title=v<version>&body=<encoded_notes>`.
12. **Final Output:** Present the finalized Release Notes and the one-click Release Link directly to the user.
    *   Include links to both marketplaces in the release notes output:
        *   [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jj-view.jj-view)
        *   [Open VSX](https://open-vsx.org/extension/jj-view/jj-view)
    *   Add a **CI Note**: A clear reminder that CI handles the binary (VSIX) upload automatically after publishing the release.
    *   Instruct the user to push changes via `jj git push` before clicking the link.
13. **Cleanup:** (Optional) Update `task.md` if one is active, but do NOT create a `walkthrough.md` for the release itself.

## Edge Cases
- If `npm run release:encode` fails, ensure the arguments are wrapped in quotes.

## Completion Criteria
The skill is complete when the release commit is made and the user is provided with the formatted release notes and the GitHub release creation link.
