# JJ View Extension - Development Guidelines

This document outlines the coding standards, testing strategies, and architectural patterns for the `jj-view` VS Code extension.

## Code Style

### Language

- All code should be written in **TypeScript**.
- Strict type checking is enabled (`"strict": true` in `tsconfig.json`).
- **Forbidden**: `any` type usage. Use strict types or `unknown` if absolute necessary.
- **Forbidden**: `as unknown as Type` double casting. Use `createMock` utility or proper type narrowing instead.

### Naming Conventions

- **Classes**: PascalCase (e.g., `JjScmProvider`).
- **Methods & Functions**: camelCase (e.g., `getWorkingCopyChanges`).
- **Variables**: camelCase.
- **Context Keys**: Use dot notation for namespacing context keys used in `package.json` `when` clauses.
    - **Correct**: `jj.parentMutable`, `jj.hasChild`
    - **Incorrect**: `jj-view:parentMutable` (colons acceptable but dot notation is preferred for consistency).
- **Files**: Kebab-case (e.g., `jj-scm-provider.ts`).

### CLI Usage

- **Pager**: Always use `--no-pager` when running `jj help` or other jj `--help` commands during research to prevent hanging. If you don't it won't return. It will require user input.

### Formatting & Linting

- Use **ESLint** for code quality (`npm run lint`).

## Testing Strategy

This project employs a split testing strategy to ensure both logic correctness and integration validity. Tests should never mock JjService. They should use TestRepo to create a temporary repository on disk and JjService to interact with it. Test verifications should use TestRepo and not try to verify using JjService.

### 1. Unit Tests

- **Tool**: [Vitest](https://vitest.dev/)
- **Command**: `npm run test:unit`
    - _Note_: Please narrow the run by passing all or part of the filename to the command when iterating on a test. For example: `npm run test:unit merge-editor`.
- **Pattern**: `src/test/**/*.test.ts` (Excluding `*.integration.test.ts`)
- **Scope**:
    - Test individual classes and functions in isolation.
    - **Mock all external dependencies**, especially the `vscode` module and file system operations.
    - Fast feedback loop, run frequently.
- **Example**: Testing `JjService` log parsing logic or `JjScmProvider` state calculations without starting VS Code.

### 2. Integration Tests

- **Tool**: [VS Code Test Electron](https://github.com/microsoft/vscode-test)
- **Command**: `npm run test:integration`
    - _Note_: This command automatically executes `npm run compile-tests` before running.
    - _Note_: You can narrow the run by using -- --grep "pattern". Plese do this when iterating on a test to speed up the process.
- **Pattern**: `src/test/**/*.integration.test.ts`
- **Scope**:
    - Tests that require the VS Code Extension Host.
    - verifying extension activation, command registration, and interaction with the real VS Code API (e.g., `vscode.scm`, `vscode.commands`).
    - Uses a temporary workspace on disk.
- **Writing Integration Tests**:
    - Must import `vscode`.
    - Should handle async operations carefully as they run in a real environment.
    - Use `sinon` for spying/stubbing internal VS Code commands if necessary (e.g., spying on `setContext`).

## Project Structure

```
├── .vscode-test/           # VS Code test runner configuration/cache
├── src/
│   ├── jj-service.ts       # Core logic for interacting with 'jj' CLI
│   ├── jj-scm-provider.ts  # VS Code SCM API implementation
│   ├── extension.ts        # Entry point, command registration
│   └── test/               # Test files
│       ├── suite/          # VS Code test runner entry point
│       ├── runTest.ts      # Integration test runner script
│       ├── *.test.ts       # Unit tests
│       └── *.integration.test.ts # Integration tests
├── package.json            # Manifest, command definitions, menus, activation events
└── vitest.config.ts        # Vitest configuration for unit tests
```

## "When" Clauses

- For SCM resource menu items (inline or context menu), always use **`scmResourceState`** as the context key to match `SourceControlResourceState.contextValue`.
    - Example: `"when": "scmResourceState == 'jjParent'"`
- Avoid using `viewItem` for SCM resources as it is intended for generic tree views.
