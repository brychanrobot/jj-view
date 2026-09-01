---
name: generate_release
description: Generate release notes for a new version
---

# Generate Release Notes

This skill details the process for generating release notes and bumping the version of the `jj-view` extension.

## Context

Use this skill when the user wants to cut a new release of the extension. It requires reading commit history, determining the next version number, updating the changelog, and preparing a GitHub release link.

**No Verification / Tests Required:** There is no need to run any tests (unit, integration, or E2E), type checks, or linters during release generation.

## Execution Steps

1.  **Check Current Version:** Read the `version` field in `package.json`.
2.  **Find Most Recent Tag:** Find the most recent git tag. You can use `git describe --tags --abbrev=0 --match "v*"` if git is available.
3.  **Determine if Bump Needed:** Check if the most recent tag string (e.g., `v1.15.2`) matches the version found in `package.json` (e.g., `1.15.2`).
4.  **Version Bump Logic (If Match):** If the tag and `package.json` version _match_, a version bump is needed:
    - Read all commit messages since the previous tag using `jj log -r '<previous_tag>..@' -T 'description "\n"' --no-graph`.
    - Analyze the commit messages to determine the correct next version (patch, minor, or major bump) based on standard conventions (e.g., `feat:` is minor, `fix:` is patch).
    - Update the `version` field in `package.json` with the new version.
5.  **Fetch Commits (If No Match):** If they _do not match_, assume the version in `package.json` was already bumped manually and is correct. Fetch the commit messages since the most recent tag using `jj log -r '<previous_tag>..@' -T 'description "\n"' --no-graph`.
6.  **Draft Release Notes:** Generate nicely formatted, categorized release notes (e.g., Features, Fixes, Chores) from the commits. **CRITICAL:** Adopt the canonical style for changelog entries by starting each bullet with a bolded component or feature name:
    - **User-Centric Organization:** Focus on presenting changes in a way that is most helpful to users. Do not group or combine different logical improvements or bug fixes together just because they happened to be committed in the same change. Instead, split them into separate logical bullet points under their respective component/feature headings.
    - Always group changes as nested bullets under the component/feature name, even if there is only a single change for that component:
      ```markdown
      - **[Component/Feature Name]**:
          - [Description of change]
      ```
7.  **Update Changelog:** Update `CHANGELOG.md` by prepending the new version and the drafted release notes.
8.  **CRITICAL - User Review:** Use the `notify_user` tool to present the proposed changes (updated `CHANGELOG.md` and `package.json`) to the user. **Wait for their approval before proceeding.**
9.  **Describe Changes:** After user approval, describe the working copy commit using `jj describe -m "chore: bump version to <new_version>"` (or the `jj_describe` MCP tool).
10. **Encode Notes:** Use the encoding script to encode the release notes for a URL: `pnpm release:encode -- "<release_notes>"`. The script is located at `.agents/scripts/encode-release-notes.ts`.
11. **Generate Release Link:** Craft a GitHub release link: `https://github.com/brychanrobot/jj-view/releases/new?tag=v<version>&title=v<version>&body=<encoded_notes>`.
12. **Final Output:** Present the finalized Release Notes and the one-click Release Link directly to the user.
    - Always provide the finalized release notes in a clean markdown code block as a copy-paste fallback in case URL query parameters are mangled by chat link handlers.
    - Include links to both marketplaces in the release notes output:
        - [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jj-view.jj-view)
        - [Open VSX](https://open-vsx.org/extension/jj-view/jj-view)
    - Add a **CI Note**: A clear reminder that CI handles the binary (VSIX) upload automatically after publishing the release.
    - Instruct the user to push changes via `jj git push` before clicking the link.
13. **Cleanup:** (Optional) Update `task.md` if one is active, but do NOT create a `walkthrough.md` for the release itself.

## Edge Cases

- If `pnpm release:encode` fails, ensure the arguments are wrapped in quotes.
- **URL Encoding & Chat Link Limitations**: Clicking Markdown links in chat UIs can cause external URI parsers to improperly decode or pass special characters like `#` (pound signs appearing as literal `%23`) and `&` (truncating query parameters). Always present the full release notes in a raw code block so the user can easily copy-paste them directly into the release form.

## Completion Criteria

The skill is complete when the release commit is made and the user is provided with the formatted release notes and the GitHub release creation link.
