# JJ View Extension - Development Guidelines

This document outlines the coding standards, testing strategies, and architectural patterns for the `jj-view` VS Code extension.

## Code Style

### Language

- All code should be written in **TypeScript**.
- Strict type checking is enabled (`"strict": true` in `tsconfig.json`).
- **Forbidden**: `any` type usage. Use strict types or `unknown` if absolute necessary.
- **Forbidden**: disabling the `any` type check for a line or block. `// @ts-ignore` or `// eslint-disable-line` are not allowed.
- **Forbidden**: `as unknown as Type` double casting. Use `createMock` utility or proper type narrowing instead.
### Target Environment

- **Node.js**: The extension targets **Node.js 22** or later. Modern APIs like `Set.prototype.difference` are permitted and encouraged.

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

- Use **ESLint** for code quality (`pnpm lint`).

## Testing Strategy

**CRITICAL RULE**: Tests should **NEVER** mock `JjService` methods.

- Always use `TestRepo` to set up a real temporary repository on disk.
- Use a real `JjService` instance to operate on it.
- Use `TestRepo` methods to verify outcomes (e.g. file content, log history), rather than spying on `JjService` calls.

Please refer to the testing skill located at `.agents/skills/run-tests/SKILL.md` for detailed instructions on writing and running tests.

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
