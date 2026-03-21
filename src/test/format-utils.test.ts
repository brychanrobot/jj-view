/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { formatCommitDescription } from '../utils/format-utils';

function trimLiteral(str: string): string {
    return str.replace(/^\n/, '').replace(/\n$/, '');
}

describe('formatCommitDescription', async () => {
    it('does not format single-line descriptions', async () => {
        expect(await formatCommitDescription('Single line title', 72)).toBe('Single line title');
    });

    it('wraps long body paragraphs while preserving the title and empty line spacing', async () => {
        const description = trimLiteral(`
Feature Title

This is a very long text that will definitely exceed the standard seventy-two character limit that is expected of most commit bodies.
`);
        const formatted = await formatCommitDescription(description, 72);

        expect(formatted).toBe(
            trimLiteral(`
Feature Title

This is a very long text that will definitely exceed the standard
seventy-two character limit that is expected of most commit bodies.
`),
        );
    });

    it('does not wrap trailer blocks (e.g. Gerrit)', async () => {
        const description = trimLiteral(`
Feature Title

Some normal body that needs wrapping because it is very long and goes way past the seventy two character limit.

Change-Id: I1234567890123456789012345678901234567890
Signed-off-by: Some Really Long Name <some.really.long.email@example.com>
`);
        const formatted = await formatCommitDescription(description, 72);

        // Body should be wrapped, but trailer remains untouched
        expect(formatted).toBe(
            trimLiteral(`
Feature Title

Some normal body that needs wrapping because it is very long and goes
way past the seventy two character limit.

Change-Id: I1234567890123456789012345678901234567890
Signed-off-by: Some Really Long Name <some.really.long.email@example.com>
`),
        );
    });

    it('preserves multiple paragraphs', async () => {
        const description = trimLiteral(`
Feature Title

Paragraph 1

Paragraph 2 is very long and goes way past the seventy two character limit so it will be wrapped.
`);
        const formatted = await formatCommitDescription(description, 72);

        expect(formatted).toBe(
            trimLiteral(`
Feature Title

Paragraph 1

Paragraph 2 is very long and goes way past the seventy two character
limit so it will be wrapped.
`),
        );
    });

    it('redistributes newlines within a paragraph', async () => {
        const description = trimLiteral(`
Feature Title

This is a manually
wrapped paragraph that
should be re-distributed
so that lines are filled up to
the seventy-two character limit.
`);

        const formatted = await formatCommitDescription(description, 72);

        expect(formatted).toBe(
            trimLiteral(`
Feature Title

This is a manually wrapped paragraph that should be re-distributed so
that lines are filled up to the seventy-two character limit.
`),
        );
    });

    it('preserves bulleted and numbered lists and indents their wrapped lines', async () => {
        const description = trimLiteral(`
Feature Title

Here are some points:
* First bullet is very very long and goes way past the seventy two character limit so it needs to be wrapped.
* Second bullet
- Third bullet that is also way too long and needs to be wrapped properly at the limit.

1. First numbered item
2. Second numbered item that is extremely long and will surely exceed the seventy two character line limit.
`);

        const formatted = await formatCommitDescription(description, 72);

        // Note: Prettier normalizes list markers (e.g. `-` becomes `*` or vice versa depending on config, default is `-` for first level).
        // Let's rely on standard Prettier output.
        expect(formatted).toBe(
            trimLiteral(`
Feature Title

Here are some points:

- First bullet is very very long and goes way past the seventy two
  character limit so it needs to be wrapped.
- Second bullet

* Third bullet that is also way too long and needs to be wrapped
  properly at the limit.

1. First numbered item
2. Second numbered item that is extremely long and will surely exceed
   the seventy two character line limit.
`),
        );
    });

    it('reflows tightly wrapped lines in multiple paragraphs and bulleted lists', async () => {
        const description = trimLiteral(`
Feature Title

First paragraph that
was wrapped far too
early and should be
reflowed completely.

Second paragraph that
also suffers from
premature wrapping.

* A bullet point that
was wrapped prematurely
before reaching the
width limit.
* Another bullet
wrapped too short.

1. A numbered list item
that was wrapped
too tightly.
2. Another numbered item.
`);

        const formatted = await formatCommitDescription(description, 72);

        expect(formatted).toBe(
            trimLiteral(`
Feature Title

First paragraph that was wrapped far too early and should be reflowed
completely.

Second paragraph that also suffers from premature wrapping.

- A bullet point that was wrapped prematurely before reaching the width
  limit.
- Another bullet wrapped too short.

1. A numbered list item that was wrapped too tightly.
2. Another numbered item.
`),
        );
    });

    it('only exempts trailers if they are at the end of the commit message', async () => {
        const description = trimLiteral(`
Feature Title

Looks-Like-Trailer: This is a very long text that goes past seventy two characters and it should be formatted even though the line starts with a trailer-like syntax.
This-Is-Also-Not-Trailer: Because it is not at the absolute end of the commit message!

Actual-Trailer: With a very very very long message that would otherwise be wrapped, but it's immune


`);

        const formatted = await formatCommitDescription(description, 72);

        expect(formatted).toBe(
            trimLiteral(`
Feature Title

Looks-Like-Trailer: This is a very long text that goes past seventy two
characters and it should be formatted even though the line starts with a
trailer-like syntax. This-Is-Also-Not-Trailer: Because it is not at the
absolute end of the commit message!

Actual-Trailer: With a very very very long message that would otherwise be wrapped, but it's immune
`),
        );
    });

    it('exempts trailers using the equals sign instead of a colon', async () => {
        const description = trimLiteral(`
Feature Title

This is a regular short body.

TESTED= On a real physical device that has a very small screen and it works perfectly without any issues whatsoever
SKIP_PRESUBMIT= Because I am absolutely certain that these changes are flawless and I do not have time to wait for the slow CI servers
FUN_FACT= Did you know that the first computer bug was an actual real-life moth found inside a Harvard Mark II computer in 1947?
`);

        const formatted = await formatCommitDescription(description, 72);

        expect(formatted).toBe(
            trimLiteral(`
Feature Title

This is a regular short body.

TESTED= On a real physical device that has a very small screen and it works perfectly without any issues whatsoever
SKIP_PRESUBMIT= Because I am absolutely certain that these changes are flawless and I do not have time to wait for the slow CI servers
FUN_FACT= Did you know that the first computer bug was an actual real-life moth found inside a Harvard Mark II computer in 1947?
`),
        );
    });
});
