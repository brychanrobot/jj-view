/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as markdownPlugin from 'prettier/plugins/markdown';
import * as prettier from 'prettier/standalone';

export async function formatCommitDescription(description: string, bodyWidthRuler: number): Promise<string> {
    // Separate the title, any empty lines immediately following it, and the content body.
    const titleMatch = description.match(/^([^\n]*)\n((?:[ \t]*\n)*)([\s\S]*)$/);
    if (!titleMatch || !titleMatch[3].trim()) return description; // Nothing to format

    const [, title, emptyPrefix, contentToFormat] = titleMatch;

    // Isolate trailing trailer blocks using a regex.
    // The trailer section must be the final paragraph of the message, composed
    // entirely of lines formatted as "Token-Name: Value".
    const trailerLine = '[\\w-]+[:=]\\s[^\\n]*';
    const trailerBlock = `(?:${trailerLine}(?:\\n|$))+`;
    const trailingTrailersRegex = new RegExp(`(?:^|\\n\\s*\\n)(${trailerBlock})\\s*$`);

    const match = contentToFormat.match(trailingTrailersRegex);

    let bodyText = contentToFormat;
    let trailers = '';

    if (match) {
        const trailerBlock = match[1];
        const trailerEndIndex = contentToFormat.lastIndexOf(trailerBlock);
        bodyText = contentToFormat.substring(0, trailerEndIndex).trimEnd();
        trailers = trailerBlock.trimEnd();
    }

    let formattedBody = bodyText;
    if (bodyText !== '') {
        formattedBody = await prettier.format(bodyText, {
            parser: 'markdown',
            plugins: [markdownPlugin],
            printWidth: bodyWidthRuler,
            proseWrap: 'always',
        });

        // Prettier adds a trailing newline, remove it to match existing behavior
        formattedBody = formattedBody.trimEnd();
    }

    const separator = formattedBody && trailers ? '\n\n' : '';
    return `${title}\n${emptyPrefix}${formattedBody}${separator}${trailers}`;
}
