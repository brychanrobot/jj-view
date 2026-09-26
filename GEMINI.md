# JJ View Extension - Development Guidelines

This document outlines the coding standards, testing strategies, and architectural patterns for the `jj-view` VS Code extension.

## Code Style

### Language

- All code should be written in **TypeScript**.
- Strict type checking is enabled (`"strict": true` in `tsconfig.json`).
- **Forbidden**: `any` type usage. Use strict types or `unknown` if absolutely necessary.
- **Forbidden**: disabling the `any` type check for a line or block. `// @ts-ignore` or `// eslint-disable-line` are not allowed.
- **Forbidden**: `as unknown as Type` double casting. Use `createMock` utility or proper type narrowing instead.
- **Early Returns**: Always prefer early returns / guard clauses to avoid deeply nested blocks of conditional logic. Check error or mismatch conditions first, return early, and keep the primary execution path unindented.
- **No Omnibus Union Parameters**: Avoid polymorphic argument unions (e.g. `param: TypeA | TypeB`, `optionsOrAction?: Options | string`, or `messageOrError: string | Error`) that change parameter semantics based on runtime type checks. Instead, use explicit, separate parameters, dedicated method names, or a clean options object. Every parameter in a function signature must have a single, unambiguous purpose.
- **Imports**: All imports (static or dynamic) should be placed at the top of the file. Avoid inline/local dynamic `await import(...)` statements inside functions, classes, or test cases unless strictly necessary (e.g., to break circular dependencies or for conditional loading).
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

### Configuration Settings

- Whenever you add or modify configuration settings in `package.json` under `contributes.configuration`, you **MUST** document them in the settings table of `README.md`. Ensure that the default values and descriptions match precisely.

## Testing Strategy

**CRITICAL RULE**: Tests should **NEVER** mock `JjService` methods.

- Always use `TestRepo` to set up a real temporary repository on disk.
- Use a real `JjService` instance to operate on it.
- Use `TestRepo` methods to verify outcomes (e.g. file content, log history), rather than spying on `JjService` calls.
- **Never invoke raw `npx playwright test`**: Always use project `pnpm` scripts (`pnpm test:e2e:web -- <spec>`, `pnpm test:e2e -- <spec>`). Pass all flags and arguments after `--`. `pnpm test:e2e:web` guarantees `pnpm build:all` is run beforehand.

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

## Standalone Web UI Guidelines

### Theming & Styling Invariants
- **Theme-Defined Colors Only**: Never hardcode hex color values in component styles. All backgrounds, borders, foregrounds, and focus indicators must use theme-defined CSS variables (`var(--vscode-...)`) to guarantee seamless adaptability across dark and light themes:
  - **Surfaces & Borders**: `var(--vscode-editor-background)`, `var(--vscode-sideBar-background)`, `var(--vscode-widget-border)`.
  - **Headers & Dividers**: `var(--vscode-editorGroupHeader-tabsBackground)`, `var(--vscode-editorGroupHeader-tabsBorder)`.
  - **Inputs & Focus**: `var(--vscode-input-background)`, `var(--vscode-input-border)`, `var(--vscode-input-foreground)`, `var(--vscode-focusBorder)`.
  - **Lists & Selection**: `var(--vscode-list-activeSelectionBackground)`, `var(--vscode-list-activeSelectionForeground)`, `var(--vscode-list-hoverBackground)`.
  - **Typography**: `var(--vscode-foreground)`, `var(--vscode-descriptionForeground)`, `var(--vscode-font-family)`, `var(--vscode-font-size)`.
- **Dimensional Consistency**: Maintain uniform header heights (`35px`) across panes and dialogs, and standard border radii (`6px` for containers/inputs, `4px` for buttons/items).

### UI Presentation Hygiene
- **No Self-Referential Branding**: In standalone mode, do not prefix items, command titles, or list labels with the application's own name (e.g. display `"Commit"` rather than `"JJ View: Commit"`).
- **Clean User Surfaces**: Show clear, human-readable labels; do not expose internal implementation identifiers (e.g., `jj-view.*` command IDs) in primary list rows.
- **Manifest Contribution Rules**: Strictly honor contribution manifest `when` conditions (e.g., `menus.commandPalette` entries with `when: "false"` or dynamic context conditions) to filter out hidden or inapplicable commands.
- **Proportional Sizing**: Size modal dialogs and floating pickers proportionally to their functional content rather than spanning unnecessary width.

### Visual Verification
- For any UI additions or layout changes, write or update Playwright E2E tests to verify interactive behavior.
- Capture visual artifacts (screenshots and animated GIFs via the `recordGifFlow` helper) and embed them directly in `walkthrough.md`.
