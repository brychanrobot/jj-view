---
name: run_tests
description: Explains how to write and run tests in the jj-view repository, detailing the test suites, their purposes, and how to filter test runs down to single test cases.
---

# Testing in JJ View

This document defines the process for writing, running, and debugging tests in the `jj-view` repository.

## The Test Suites

The repository uses three different test runners for different layers of testing.

### 1. Unit Tests (Vitest)
**Purpose:** Fast feedback tests for individual classes and functions in isolation without starting the VS Code Extension Host.
**Command:** `npm run test:unit`
**Location Pattern:** `src/test/**/*.test.ts` (excluding `*.integration.test.ts`)
**Key Rules:**
- Mock external dependencies, especially `vscode` (using the `createVscodeMock` helper) and file system operations.
- **CRITICAL:** Do NOT mock `JjService` methods. Always use `TestRepo` to create a real temporary repository on disk, and interact with it using a real `JjService` instance. Use `TestRepo` methods to verify outcomes (e.g., file content, log history) rather than spying on `JjService` calls.

**Filtering:**
You MUST run individual test cases when writing a new test or debugging a broken test.
- **Run a single test case (Recommended):** Use the `-t` flag with the test name (you may also include the filename to narrow it down further).
  ```bash
  npm run test:unit -- <filename> -t "<test name>"
  # Example: npm run test:unit -- merge-editor.test.ts -t "should open merge editor"
  ```
- **Run a specific test file:** Pass part of the filename.
  ```bash
  npm run test:unit -- <filename>
  # Example: npm run test:unit -- merge-editor
  ```

### 2. Integration Tests (VS Code Test Electron)
**Purpose:** Tests that require the VS Code Extension Host to verify extension activation, command registration, and real VS Code API interactions.
**Command:** `npm run test:integration`
**Location Pattern:** `src/test/**/*.integration.test.ts`
**Key Rules:**
- Must import `vscode`.
- Uses a temporary workspace on disk.
- Handle async operations carefully as they run in a real environment.
- Use `sinon` for spying/stubbing internal VS Code commands if necessary (e.g., spying on `setContext`).

**Filtering:**
You MUST run individual test cases when writing a new test or debugging a broken test.
- **Run a single test case (Recommended):** Use the `--grep` flag with the specific test case name or a pattern that uniquely identifies it.
  ```bash
  npm run test:integration -- --grep "<test case name>"
  # Example: npm run test:integration -- --grep "should register commands"
  ```
*(Note for Integration tests: `vscode-test` passes arguments to Mocha under the hood. Using an exact string in `--grep` is the best way to isolate a single test case.)*

### 3. End-to-End (E2E) Tests (Playwright)
**Purpose:** End-to-end testing of the extension's behavior in VS Code, interacting with the real UI to ensure the user perspective functions correctly.
**Command:** `npm run test:e2e` (also `npm run test:screenshots` for visual regression)
**Location Pattern:** `src/test/e2e/**/*.spec.ts`
**Key Rules:**
- Use the `hoverAndClick` helper function to consistently handle inline action buttons.
- Replace manual `setTimeout` calls with Playwright's native `waitForTimeout` function.

**Filtering:**
You MUST run individual test cases when writing a new test or debugging a broken test.
- **Run a single test case (Recommended):** Use the `-g` flag for grep along with the filename.
  ```bash
  npm run test:e2e -- <filename> -g "<test-name>"
  # Example: npm run test:e2e -- scm.spec.ts -g "squash button visibility"
  ```
- **Run a specific test file:** Pass the filename.
  ```bash
  npm run test:e2e -- <filename>
  # Example: npm run test:e2e -- scm.spec.ts
  ```

## Mandatory Debugging Practice

When writing a new test or investigating a failure:
1. **Never** run the full test suite over and over.
2. **Always** apply the filtering commands listed above to restrict execution to the single test case or file you are working on. This drastically speeds up the feedback loop and simplifies debugging output.
