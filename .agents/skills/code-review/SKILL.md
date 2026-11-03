---
name: code-review
description: Performs multi-agent code reviews on jj-view commits using the repository's review rubric (strict TypeScript, theme-defined CSS variables, TestRepo/E2E standards, and component lifecycle invariants) and continuously updates the rubric as new codebase-wide positive or negative patterns are discovered.
---

# JJ View Code Review Rubric & Self-Improving Review Protocol

## When to use this skill

Use this skill before completing any feature, bugfix, refactoring, or
multi-commit Jujutsu stack in `jj-view`, or whenever asked to review local
changes or commits in the `jj-view` repository.

## How to use it

### Step 1: Audit the Commit Stack Structure

1.  Inspect `jj log -r 'main..@' --stat` (always with `--no-pager`).
2.  Ensure `@` is an empty working-copy commit on top of the stack and every
    non-empty commit in `main..@-` is atomic, logically scoped, and has a clean
    conventional commit message (`feat(...)`, `fix(...)`, `test(...)`,
    `docs(...)`, etc.) free of internal codenames, prototype labels, or
    temporary notes.

### Step 2: Spawn 2 Independent Review Subagents Per Commit

For **every** non-empty commit in the stack, launch **2 independent read-only
review subagents** in parallel so each commit gets two orthogonal perspectives:

-   **Reviewer A (Correctness, Algorithms, Lifecycle & Tests)**: Audits business
    logic, parser/state-machine edge cases, external library callback contracts,
    DOM/Shadow DOM lifecycle, resource cleanup (`try / finally`), and unit + E2E
    test coverage.
-   **Reviewer B (Architecture, Strict TypeScript & Theme Fidelity)**: Audits
    strict TypeScript rules, parameter signatures, component boundaries, and
    strict adherence to `jj-view`'s configured theme CSS variables
    (`var(--vscode-...)`).

Instruct both reviewers to read this skill
(`.agents/skills/code-review/SKILL.md`) and `GEMINI.md`, inspect the full diff
(`jj show -r <rev> --git --no-pager`) and full source of touched files, and end
their report with a `### Candidate Rubric Patterns (Positive & Negative)`
section.

--------------------------------------------------------------------------------

## The `jj-view` Code Review Rubric

Every commit in `jj-view` MUST be evaluated against the following four
categories:

### 1. Theme Color & Styling Fidelity (CRITICAL for Web UI & CSS)

-   **Zero Hardcoded Hex or RGB Colors**: Component styles (`.svelte` `<style>`
    blocks, `.css` files outside theme palette definitions, and CSS strings
    injected into Web Component Shadow DOMs) MUST NEVER hardcode hex (`#...`) or
    `rgb()`/`rgba()` values, and MUST NEVER borrow hardcoded theme palettes
    (e.g. orange `#ff7849` or fixed slate backgrounds) from external prototypes.
    Always sweep `<style>` blocks of touched `.svelte` files for residual hex or
    rgba fallbacks.
-   **Configured `jj-view` Theme Variables Only**: All backgrounds, recessed
    surfaces, borders, text, badges, accents, focus rings, and hover states must
    reference `var(--vscode-...)` tokens (populated dynamically by
    `applyAppTheme` in `web/src/diff/highlighter-setup.ts` and
    `web/src/styles/vscode-theme.css` for the user's selected `jj-view` theme):
    -   **Surfaces & Borders**: `var(--vscode-editor-background)`,
        `var(--vscode-sideBar-background)`, `var(--vscode-widget-border)`,
        `var(--vscode-widget-shadow, var(--vscode-foreground))`. (Note: always
        provide a sensible fallback like `var(--vscode-foreground)` for
        `widget-shadow` since it may evaluate to transparent or empty in custom
        web themes).
    -   **Headers & Dividers**:
        `var(--vscode-editorGroupHeader-tabsBackground)`,
        `var(--vscode-editorGroupHeader-tabsBorder)`.
    -   **Inputs, Accents & Focus**: `var(--vscode-input-background)`,
        `var(--vscode-input-border)`, `var(--vscode-input-foreground)`,
        `var(--vscode-focusBorder)`, `var(--vscode-button-background)`,
        `var(--vscode-textLink-foreground)`.
    -   **Lists & Selection**: `var(--vscode-list-activeSelectionBackground)`,
        `var(--vscode-list-activeSelectionForeground)`,
        `var(--vscode-list-hoverBackground)`.
    -   **Typography**: `var(--vscode-foreground)`,
        `var(--vscode-descriptionForeground)`, `var(--vscode-font-family)`,
        `var(--vscode-font-size)`.
-   **Theme-Adaptive Translucent Tints (`color-mix`)**: When deriving subtle
    tints, recessed channels, or accent borders that must work across all dark
    and light `jj-view` themes (`pierre-dark-soft`, `pierre-light-soft`,
    `github-light`, `dracula`, `catppuccin-mocha`, etc.), combine
    `var(--vscode-...)` variables with `color-mix(in srgb, ...)`:

    ```css
    /* GOOD: Adapts automatically to any configured dark or light jj-view theme */
    --accent-primary: var(--vscode-focusBorder, var(--vscode-button-background));
    background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
    border-color: color-mix(in srgb, var(--accent-primary) 50%, var(--vscode-input-border));

    /* BAD (Forbidden): Borrowed or hardcoded colors */
    --accent-primary: #ff7849;
    background: rgba(255, 120, 73, 0.12);
    ```
-   **Light & Dark Theme Reactivity**: Components that wrap external renderers
    (such as `@pierre/diffs` `FileDiff` or `CodeView`) must use
    `isLightTheme(effectiveTheme)` consistently and reactively re-apply theme
    styles when the configured theme changes at runtime.
-   **Presentation Hygiene**: Maintain `35px` header heights and `6px`/`4px`
    border radii; never prefix standalone labels with `"JJ View: ..."`, never
    expose raw `jj-view.*` command IDs in user-facing rows, and use crisp inline
    `<svg>` vector icons instead of Unicode emoji or dingbats.
-   **Segmented Control Clipping via `overflow: hidden` Container + Sibling Tooltip Wrapper (Positive Pattern)**:
    When building compact segmented controls (such as dock-pair pill clusters),
    clip child hover backgrounds cleanly by wrapping the button pair in
    `.dock-pair { overflow: hidden; padding: 0; }`. Never nest floating tooltips
    inside an `overflow: hidden` container; place the tooltip as an absolute sibling
    inside an outer `.ast-pill-anchor` wrapper and trigger visibility via
    `.ast-pill-anchor:has(.pill-ast:hover) .ast-tooltip`. For keyboard accessibility
    inside clipped controls, set
    `.dock-pair .seam-pill:focus-visible { outline-offset: -2px }` so the focus
    outline draws inward rather than being clipped by the parent.
-   **CSS Overlapping Curves Distortion from Mixing Pill Radii with Small Pixel Radii (Anti-Pattern)**:
    Never mix `border-radius: 999px` on three corners with a small pixel radius
    (e.g., `4px`) on the fourth corner of a fixed-height container. Per CSS
    Backgrounds & Borders Level 3 §4.5 ("Overlapping Curves"), when the sum of
    adjacent radii exceeds the container height (`4px + 999px = 1003px > 24px`),
    browsers proportionally scale down all radii by `24 / 1003`, flattening the
    `4px` corner to `0.09px` and the `999px` corners to `23.9px`. Use non-overlapping,
    explicit pixel radii matching container height (`border-radius: 12px` with
    `border-top-left-radius: 4px` on a `24px` container).
-   **Assuming Container Query Units (`cqi`) Query the Viewport (Anti-Pattern)**:
    In `@pierre/diffs`, each diff column defines `container-type: inline-size` on
    `<code data-container-size>`. Therefore, `100cqi` represents the width of that
    single column, NOT the whole editor viewport. In split mode, `100cqi` on
    `.combo-seam-half` correctly spans the visible half-column width; do NOT divide
    by 2 (`50cqi`), which would shrink half-seams to a quarter of the container width.

### 2. Strict TypeScript & Code Style (`GEMINI.md`)

-   **Zero `any` / Zero Suppressions / Zero Double Casts**:
    -   Forbidden: `any`, `// @ts-ignore`, `// @ts-expect-error`,
        `// eslint-disable-line`, `// biome-ignore`, `as unknown as Type`.
    -   Required: Use proper type guards, narrowed interfaces, or
        `createMock<T>` / `createVscodeMock` in tests.
    -   Avoid redundant `as Record<string, unknown>` casts after `'prop' in obj`
        checks; rely on direct `'prop' in obj` type narrowing instead.
-   **No Omnibus Union Parameters (`GEMINI.md:15`)**:
    -   Forbidden: Polymorphic parameter unions
        (`target: Locator | { x: number; y: number }`,
        `optionsOrAction?: Options | string`) that branch on runtime type checks
        (`'x' in target`, `typeof arg === 'string'`).
    -   Required: Split into explicit, single-purpose methods
        (`moveTo(target: Locator)` and `moveToPoint(x: number, y: number)`),
        separate parameters, or a structural interface
        (`event: SeamPointerEventLike` that both `PointerEvent` and `MouseEvent`
        satisfy structurally without a union).
-   **Early Returns & Top-of-File Imports**:
    -   Check error/boundary conditions first and return early rather than
        nesting 4–5 levels of `if` statements.
    -   Place all imports at the top of the file.
-   **Interval-Stack AST Tree Merging with Strict Upper-Bound Containment (Positive Pattern)**:
    When merging distinct syntax hierarchies (e.g. JS/TS function braces and
    JSX/HTML tag trees) via interval containment (`mergeSyntaxBlockTrees`), maintain
    an ancestor stack sorted by `start_line` ascending and `end_line` descending.
    When evaluating the next block, pop stack entries until
    `top.range.start_line <= block.range.start_line && block.range.end_line <= top.range.end_line`.
    Never pop solely on `top.range.end_line < block.range.start_line`: every
    attached child must satisfy `child.range.end_line <= parent.range.end_line`
    so hierarchical breadcrumbs and progressive step-out algorithms never
    encounter overhanging child blocks.
-   **Gating Quote Tracking on `braceDepth === 0` Inside Embedded Expression Lexers (Anti-Pattern)**:
    When parsing tags with embedded code expressions (such as JSX, Svelte, or Vue
    attributes), never gate quote entry on `braceDepth === 0`. Quotes (`"`, `'`,
    `` ` ``) must be tracked at ALL brace depth levels; otherwise a closing
    brace `}` inside a string literal within an expression (e.g.
    `onClick={() => alert("}") && a > b}`) prematurely decrements `braceDepth`
    to 0, corrupts the outer lexer state, and causes subsequent operators (`>`)
    to terminate the opening tag prematurely.

### 3. Component Lifecycle, Shadow DOM & Virtualized Rendering

-   **Shadow DOM Root Resolution**: Web Components like `@pierre/diffs`'s
    `<diffs-container>` render internal rows and separators inside
    `element.shadowRoot`, while light-DOM test stubs may omit a shadow root.
    Host adapters must resolve `container.shadowRoot ?? container` rather than
    returning the outer light-DOM host element when `shadowRoot` is present.
-   **Library Callback Signatures**: Always verify callback parameter positions
    against `.d.ts` definitions in `node_modules` rather than assuming
    2-argument signatures (for example, `@pierre/diffs`
    `CodeViewOptions.onPostRender` passes `(node, instance, phase, context)`
    where the diff item context is the **4th** argument and
    `phase === 'unmount'` must be ignored).
-   **Pooled / Recycled DOM Node Cleanup**: Virtualized views (`CodeView`) pool
    and recycle `<diffs-container>` elements across different files during
    scrolling. Host controllers attached via `WeakMap<HTMLElement, Host>` must
    clear cached per-file state when `diffItem.item.fileDiff` changes and remove
    custom child elements when a separator or row becomes inactive.
-   **Diff Editor Selection & Unlayered Cascade Architecture (`adoptedStyleSheets`)**:
    `@pierre/diffs/edit` (`Editor`) injects unlayered `<style data-editor-css>`
    (`::selection { background-color: #0000; }`) and `<style data-editor-theme-css>`
    (`:host { --diffs-editor-selection-bg: ${colors["editor.selectionBackground"] ?? "var(--diffs-line-bg)"}; }`)
    into the `<diffs-container>` Shadow DOM. To maintain 100% visible,
    theme-adaptive text selection highlights across working-copy diffs, single-file
    views, and read-only commit diffs **without using `!important`**:
    -   **Populate Selection Background on Shiki Theme Registrations**: All theme
        loaders in `highlighter-setup.ts` must ensure
        `colors['editor.selectionBackground']` is populated (and made translucent
        for 3-digit, 6-digit, or opaque 8-digit hex) before registering themes
        with `@pierre/diffs`. Built-in Pierre themes (`pierre-dark-soft`,
        `pierre-light-soft`) rely on `applyAppTheme` + `--diffs-editor-selection-bg`
        in `adoptedStyleSheets`, while custom Shiki themes natively emit a valid
        `--diffs-editor-selection-bg` via `EditorTokenizer` instead of falling
        back to `var(--diffs-line-bg)`.
    -   **Adopt Custom Stylesheets via `shadowRoot.adoptedStyleSheets`**: Attach
        custom Shadow DOM stylesheets via `adoptDiffCustomStyles(root)`
        (`shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet]`).
        Because `adoptedStyleSheets` is unlayered and evaluated **after** all
        `<style>` tags in the Shadow DOM by standard CSS Cascade rules, normal
        rules naturally win by cascade order with **zero `!important`**. Keep
        `unsafeCSS: HUNK_EXPANSION_CSS` as the fallback for environments without
        `adoptedStyleSheets`.
    -   **Prevent `::selection` Double-Painting & Compounding**: Use root
        `::selection { background-color: var(--diffs-selection-color); }` rather
        than nested element selectors (`[data-line]::selection`, `*::selection`)
        to avoid Chromium alpha-compounding on syntax tokens. Pair with
        `[data-diffs]:has([data-selection-range]) ::selection { background-color: transparent; }`
        so native `::selection` is suppressed only when `Editor`'s
        `<div data-selection-range>` overlay is actively rendered, preventing
        double-painting while keeping `[data-deleted-text-selection]` active on
        deletions.
    -   **Translucent Line Decorators**: Row decorators (such as context-expanded
        diff lines) must set `--diffs-line-bg` and use translucent backgrounds
        rather than opaque backgrounds on `[data-line]` to prevent occluding
        `Editor`'s `[data-selection-range]` overlay at `z-index: -10`.
-   **Deterministic Pointer & Subprocess Cleanup**:
    -   Always pair `pointermove`/`pointerup`/`pointercancel` and Playwright
        `page.mouse.down()` with `try { ... } finally { ... }` cleanup so
        aborted gestures or lost captures never leak global listeners, `body`
        classes, or pressed mouse state. Global window drag listeners must
        subscribe to `'pointercancel'` in addition to `'pointerup'`.
    -   In Playwright helpers (`recordGifFlow`, `recordInteractionFlow`), wrap
        post-flow `page.evaluate(...)` teardown in `try { ... } catch {}`
        *before* `fs.rmSync(tempDir)` so a closed/crashed page never leaks
        temporary directories or masks the test failure.
    -   Invoke external binaries (`ffmpeg`) via
        `cp.execFileSync(bin, argsArray)` rather than shell string interpolation
        (`cp.execSync`).

### 4. Testing & Visual Verification Quality

-   **Never Mock `JjService`**: Always use a real `TestRepo` and a real
    `JjService` instance in unit and integration tests.
-   **No Arbitrary Sleeps in Playwright Specs**: Use web-first Playwright
    assertions (`await expect(locator).toBeVisible()`,
    `await expect(locator).toHaveCount(0)`) instead of
    `page.waitForTimeout(...)`.
-   **Deterministic Frame Capture**: Avoid wall-clock CSS transitions on virtual
    cursor overlays during frame-by-frame screenshot recording
    (`recordInteractionFlow`) so `page.screenshot()` captures exact
    deterministic states on every frame.
-   **Domain-Neutral Test Fixtures**: Use self-contained, generic code fixtures
    in tests (never project-external codenames or unrelated proprietary
    symbols).
-   **No Hardcoded Absolute Paths in Tests**: Never hardcode developer home
    paths or personal directories in test specs or fixtures; always import and
    use `ARTIFACT_DIR` from `./standalone-fixture` (or
    `process.env.SCREENSHOT_OUT_DIR`).
-   **Visual Artifact Freshness**: Whenever styling or theme variables change,
    re-capture all screenshots, GIFs, and MP4s and visually inspect them (both
    dark and light themes) before finishing.

--------------------------------------------------------------------------------

## Continuous Self-Improvement Directive (Positive & Negative Patterns)

This skill is a **living document** for the `jj-view` codebase. After every code
review cycle (whether conducted by review subagents or triggered by user
feedback):

1.  **Evaluate Newly Discovered Patterns for Codebase-Wide Generalizability**:
    -   Ask: *"Does this bug class, anti-pattern, or clean solution apply across
        the `jj-view` codebase beyond the single file just edited?"*
    -   **Negative Patterns (Anti-Patterns & Defect Classes)**: When a review
        catches a generalizable trap in `jj-view` (e.g., hardcoded/borrowed
        colors bypassing `var(--vscode-...)`, polymorphic union parameters,
        Shadow DOM vs. light DOM mismatches, virtualizer DOM recycling leaks,
        string/comment order-of-operations bugs, or flaky E2E patterns), add a
        concise rule and counter-example to the rubric above.
    -   **Positive Patterns (Exemplars & Idioms)**: When a review identifies a
        clean architectural pattern worth standardizing across `jj-view` (e.g.,
        `color-mix(in srgb, var(--vscode-...) ..., ...)` for theme-adaptive
        surfaces, structural event interfaces that avoid union types,
        optimistic + async renderer `Math.max` state reconciliation, or
        `recordInteractionFlow` for 24fps E2E captures), codify it in the rubric
        above so future features adopt it from the start.
2.  **Update `.agents/skills/code-review/SKILL.md` Before Closing the Task**:
    -   Whenever 1 or more generalizable `jj-view` patterns (positive or
        negative) are identified during a review cycle, edit
        `.agents/skills/code-review/SKILL.md` (and `GEMINI.md` if it establishes
        a top-level repo invariant) to record the pattern as part of completing
        the review.

--------------------------------------------------------------------------------

## Checklist

-   [ ] Were **2 independent review subagents** spawned for **each** commit in
    `main..@-`?
-   [ ] Are **100% of component and Shadow DOM styles** using
    `var(--vscode-...)` tokens (and `color-mix`) with **zero** hardcoded or
    borrowed hex/rgba colors?
-   [ ] Were both **dark and light `jj-view` themes** verified visually?
-   [ ] Are there **zero** `any` types, type suppressions, double casts
    (`as unknown as`), or omnibus union parameters?
-   [ ] Were all P0–P3 findings fixed and squashed into their target commits via
    the Bottom-Up JJ Squash Workflow (`jj new <rev>`, test,
    `jj squash --into <rev> -u`, leaving `@` empty)?
-   [ ] Were any newly discovered codebase-wide **positive or negative
    patterns** added to `.agents/skills/code-review/SKILL.md`?
