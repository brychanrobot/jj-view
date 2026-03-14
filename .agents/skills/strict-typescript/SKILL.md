---
name: strict_typescript
description: A reference for the repository's strict type rules, explaining forbidden practices and how to correctly handle types and mocking in tests.
---

# Strict TypeScript Rules in JJ View

This document outlines the strict TypeScript rules enforced in the `jj-view` repository and provides guidance on how to correctly cast types, narrow types, and mock dependencies without resorting to anti-patterns.

## Core Rules

The project has strict type-checking enabled (`"strict": true` in `tsconfig.json`). To maintain code quality and reliability, the following practices are **strictly forbidden**:

1.  **NO `any` types:** The use of `any` disables type checking and is completely forbidden. Use strict types, or if the type is truly unknown, use `unknown`.
2.  **NO disabling type checks:** You may not disable type checking for a line or block of code.
    *   Forbidden: `// @ts-ignore`
    *   Forbidden: `// eslint-disable-line` (for type-related lint rules)
    *   Forbidden: `// @ts-expect-error`
3.  **NO double casting:** You may not bypass the type system by casting to `unknown` and then immediately casting to another type.
    *   Forbidden: `const myVar = foo as unknown as Bar;`

## How to Handle Types Correctly

When you encounter a situation where the TypeScript compiler is unhappy, you must solve it using proper type-safe methods.

### 1. Type Narrowing

Instead of forcing a cast, use type guards (e.g., `typeof`, `instanceof`, or custom type guard logic) to narrow `unknown` or union types into the specific type you need.

```typescript
// BAD (Forbidden)
const data = getSomeUnknownData();
const myString = data as unknown as string; 
const length = myString.length;

// GOOD (Type Narrowing)
const data = getSomeUnknownData();
if (typeof data === 'string') {
    // TypeScript now knows `data` is a string
    const length = data.length; 
} else {
    // Handle the unexpected type
    throw new Error('Expected a string');
}
```

### 2. Handling Complex external types

If you have an object from an external source typed as `unknown` and need to access its properties, define an interface for the expected structure and build a type guard, or use safe assertion functions.

## How to Handle Mocking in Tests

The most common reason developers reach for double-casting (`as unknown as Type`) is when creating mock objects for tests. **This is forbidden.** 

To create partial mock objects that satisfy a required interface, use the `createMock` utility (where available) or structurally type what you need.

### Mocking `vscode`

When unit testing, you often need to mock the `vscode` module. Do not attempt to cast custom objects as `typeof vscode`. Instead, use the dedicated `createVscodeMock` helper provided in the test suite.

```typescript
// src/test/my-test.test.ts
import { vi } from 'vitest';

// GOOD: Use the provided mock factory and vitest dynamic import
vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        // Provide partial overrides here
        window: { 
            showInformationMessage: vi.fn(),
            showErrorMessage: vi.fn() 
        },
        workspace: {
             // Only provide what the test needs
             workspaceFolders: [{ uri: { fsPath: '/custom/test/path' } }]
        }
    });
});
```

The `createVscodeMock` function handles the heavy lifting of satisfying the `vscode` module shapes without requiring forbidden casts. Always refer to `src/test/vscode-mock.ts` to see what is already mocked by default.
