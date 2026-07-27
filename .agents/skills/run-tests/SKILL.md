---
name: run_tests
description: Explains how to write and run tests in the jj-view repository, detailing the test suites, their purposes, and how to filter test runs down to single test cases. You must read this before editing or debuggins tests.
---

# Testing in JJ View

This document defines the process for writing, running, and debugging tests in the `jj-view` repository.

## The Test Suites

The repository uses three different test runners for different layers of testing.

### 1. Unit Tests (Vitest)

**Purpose:** Fast feedback tests for individual classes and functions in isolation without starting the VS Code Extension Host.
**Command:** `pnpm test:unit`
**Location Pattern:** `src/test/**/*.test.ts` (excluding `*.integration.test.ts`)
**Key Rules:**

- Mock external dependencies, especially `vscode` (using the `createVscodeMock` helper) and file system operations.
- **CRITICAL:** Do NOT mock `JjService` methods. Always use `TestRepo` to create a real temporary repository on disk, and interact with it using a real `JjService` instance. Use `TestRepo` methods to verify outcomes (e.g., file content, log history) rather than spying on `JjService` calls.

**Filtering:**
You MUST run individual test cases when writing a new test or debugging a broken test.

- **Run a single test case (Recommended):** Use the `-t` flag with the test name (you may also include the filename to narrow it down further).
    ```bash
    pnpm test:unit <filename> -t "<test name>"
    # Example: pnpm test:unit merge-editor.test.ts -t "should open merge editor"
    ```
- **Run a specific test file:** Pass part of the filename.
    ```bash
    pnpm test:unit <filename>
    # Example: pnpm test:unit merge-editor
    ```

### 2. Integration Tests (VS Code Test Electron)

**Purpose:** Tests that require the VS Code Extension Host to verify extension activation, command registration, and real VS Code API interactions.
**Command:** `pnpm test:integration`
**Location Pattern:** `src/test/**/*.integration.test.ts`
**Key Rules:**

- Must import `vscode`.
- Uses a temporary workspace on disk.
- Handle async operations carefully as they run in a real environment.
- Use `sinon` for spying/stubbing internal VS Code commands if necessary (e.g., spying on `setContext`).

**Filtering:**
You MUST run individual test cases when writing a new test or debugging a broken test.

- **Run a specific test file (Recommended for focus):** Use the `--run` flag followed by the path to the **compiled** test file in the `out/` directory.
    ```bash
    pnpm test:integration --run out/test/filename.integration.test.js
    # Example: pnpm test:integration --run out/test/quick-diff.integration.test.js
    ```
- **Run a single test case:** Use the `--grep` flag with the specific test case name or a pattern that uniquely identifies it.
    ```bash
    pnpm test:integration --grep "<test case name>"
    # Example: pnpm test:integration --grep "should register commands"
    ```
    _(Note: `vscode-test` passes arguments to Mocha under the hood. For `pnpm`, you can pass these flags directly if they are not picked up by pnpm itself, or use `--` to be safe: `pnpm test:integration --grep "pattern"`)_

### 3. End-to-End (E2E) Tests (Playwright)

**Purpose:** End-to-end testing of the extension's behavior in VS Code, interacting with the real UI to ensure the user perspective functions correctly.
**Command:** `pnpm test:e2e` (also `pnpm test:screenshots` for visual regression)
**Location Pattern:** `src/test/e2e/**/*.spec.ts`
**Key Rules:**

- Use the `hoverAndClick` helper function to consistently handle inline action buttons.
- Replace manual `setTimeout` calls with Playwright's native `waitForTimeout` function.

**Filtering:**
You MUST run individual test cases when writing a new test or debugging a broken test.

- **Run a single test case (Required):** Use the `-g` flag for grep.
  You can also provide the filename to narrow it down further, but just using `-g` with a unique pattern is often more convenient.
  
  > [!IMPORTANT]
  > **Playwright's `-g` / `--grep` uses Regular Expressions, not literal strings!**
  > If a test name contains special regex characters like parentheses `()`, brackets `[]`, dots `.`, or asterisks `*`, a raw literal match will fail or behave unexpectedly (e.g. `(foo)` is interpreted as a regex capture group, not literal parentheses).
  >
  > To match these correctly:
  > 1. Use the `.*` wildcard to bypass the special characters entirely.
  > 2. Or, escape the special characters with backslashes (e.g. `\(` and `\)`).

  When debugging a flaky test, append `--repeat-each 5 --max-failures 1` to run it multiple times and fail fast.
    ```bash
    pnpm test:e2e [-g "<test-name-regex>"] [<filename>] [--repeat-each 5 --max-failures 1]
    # Examples using wildcards (Recommended):
    # pnpm test:e2e -g "Compare All Files with Revision.*Arbitrary"
    # pnpm test:e2e -g "Compare File with Revision.*Ancestor"
    #
    # Examples with literal escaping:
    # pnpm test:e2e -g "Compare File with Revision\.\.\. \(Arbitrary\)"
    #
    # Basic examples:
    # pnpm test:e2e -g "Additional Actions"
    # pnpm test:e2e scm.spec.ts -g "squash"
    ```
- **Run a specific test file:** Pass the filename.
    ```bash
    pnpm test:e2e <filename>
    # Example: pnpm test:e2e scm.spec.ts
    ```

- **Verbose Logging (Opt-in):** If you need to see `console.log` output from the extension's webview or any page errors in your terminal, prefix the command with `VERBOSE=1`.
    ```bash
    VERBOSE=1 pnpm test:e2e context-menu.spec.ts -g "New Merge Change"
    ```

- **Configurable Artifacts Output Directory (Direct Image Debugging):**
  By default, Playwright outputs failure screenshots/videos to `test-results/` inside the workspace. To view these images directly without copying them to the artifact directory, you can set the `PLAYWRIGHT_OUTPUT_DIR` environment variable to the agent's current conversation artifact directory:
  ```bash
  PLAYWRIGHT_OUTPUT_DIR=<artifact-directory-path>/test-results pnpm test:e2e <test-arguments>
  ```
  *(Note: You can find the `<artifact-directory-path>` in the conversation details/metadata, e.g., `<appDataDir>/brain/<conversation-id>`)*
  This will place failure screenshots directly into your artifact folder, making them instantly available for the `view_file` tool.

### 4. Debugging E2E Tests (Automatic Failure Diagnostics & Artifact Parsing)

**Purpose:** When locators fail in E2E tests, it's often due to the complex, nested structure of VS Code. Playwright is configured to automatically dump the visual and DOM state on failure.

**Diagnostic Outputs & Failure Script:**
Whenever an E2E test fails, the test runner automatically saves two diagnostic files in `test-results/` and `playwright-report/`:
1. **Screenshot:** `test-failure.png` showing the visual editor/workspace state.
2. **DOM HTML:** `test-failure.html` containing the complete DOM structure (including shadow roots and iframes).

**Parsing Failure Artifacts:**
Run `pnpm test:failures` after any E2E test run to immediately list all failed spec files, error stack traces, and direct `file://` links to screenshot images and DOM HTML files:
```bash
pnpm test:failures
```

You MUST use `pnpm test:failures` after test runs to identify failure artifact paths, and use `view_file` to inspect the exact `test-failure.png` screenshot images and `test-failure.html` DOM dumps to diagnose root causes visually.

## Mandatory Debugging Practice

When writing a new test or investigating a failure:

1. **Never** run the full test suite over and over without filtering.
2. **Always** apply the filtering commands listed above to restrict execution to the single test case or file you are working on during development.
3. **Always** run `pnpm test:failures` when test failures occur, inspect all `test-failure.png` screenshots using `view_file`, and address root causes empirically.

