/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds jj template strings from a readable TypeScript structure.
 * This avoids the complex escaping required in raw template strings.
 */

export type JjTemplateField =
    | { type: 'string'; expr: string } // Output as quoted string: "value"
    | { type: 'json'; expr: string } // Output with escape_json(): value.escape_json()
    | { type: 'raw'; expr: string } // Output as-is (for booleans, numbers)
    | { type: 'timestamp'; expr: string } // Format as ISO timestamp
    | { type: 'array'; expr: string; itemSchema: Record<string, JjTemplateField> } // Array with generated item template
    | { type: 'stringArray'; expr: string; itemExpr: string } // Array of simple strings
    | { type: 'rawArray'; expr: string; itemExpr: string } // Array of raw values (booleans, numbers)
    | { type: 'object'; fields: Record<string, JjTemplateField> } // Nested object
    | { type: 'nullable'; expr: string; valueExpr: string } // Nullable with if()
    | { type: 'optionalField'; where: string; valueExpr: string }; // Conditionally included object field

function buildObjectFields(fields: Record<string, JjTemplateField>): string {
    const parts: string[] = [];
    const entries = Object.entries(fields);
    for (let i = 0; i < entries.length; i++) {
        const [key, field] = entries[i];
        if (field.type === 'optionalField') {
            const prefix = i === 0 ? `"\\"${key}\\": "` : `", \\"${key}\\": "`;
            parts.push(`if(${field.where}, ${prefix} ++ ${field.valueExpr}, "")`);
        } else {
            const prefix = i === 0 ? `"\\"${key}\\": "` : `", \\"${key}\\": "`;
            parts.push(`${prefix} ++ ${buildTemplateExpr(field)}`);
        }
    }
    return parts.join(' ++ ');
}

function buildTemplateExpr(field: JjTemplateField): string {
    switch (field.type) {
        case 'string':
            return `"\\"" ++ ${field.expr} ++ "\\""`;
        case 'json':
            return `${field.expr}.escape_json()`;
        case 'raw':
            return field.expr;
        case 'timestamp':
            return `"\\"" ++ ${field.expr}.local().format("%Y-%m-%dT%H:%M:%S%:z") ++ "\\""`;
        case 'array': {
            const itemTemplate = `"{" ++ ${buildObjectFields(field.itemSchema)} ++ "}"`;
            return `"[" ++ ${field.expr}.map(|item| ${itemTemplate}).join(",") ++ "]"`;
        }
        case 'stringArray':
            return `"[" ++ ${field.expr}.map(|item| "\\"" ++ ${field.itemExpr} ++ "\\"").join(",") ++ "]"`;
        case 'rawArray':
            return `"[" ++ ${field.expr}.map(|item| ${field.itemExpr}).join(",") ++ "]"`;
        case 'object': {
            return `"{" ++ ${buildObjectFields(field.fields)} ++ "}"`;
        }
        case 'nullable':
            return `if(${field.expr}, "\\"" ++ ${field.valueExpr} ++ "\\"", "null")`;
        case 'optionalField':
            return `if(${field.where}, ${field.valueExpr}, "null")`;
    }
}

export function buildLogTemplate(schema: Record<string, JjTemplateField>): string {
    return `"{" ++ ${buildObjectFields(schema)} ++ "}\\n"`;
}
export const CHANGE_ID_EXPR = 'if(divergent || hidden, change_id ++ "/" ++ change_offset, change_id)';
export const CHANGE_ID_ITEM_EXPR =
    'if(item.divergent() || item.hidden(), item.change_id() ++ "/" ++ item.change_offset(), item.change_id())';

/**
 * Common schema fields for a single file diff entry (path, oldPath, status, conflicted).
 * @param varName The template variable name ('item' when iterating over self.diff().files(), or 'self' for jj diff -T).
 */
export function buildDiffFileSchema(varName: 'item' | 'self'): Record<string, JjTemplateField> {
    return {
        path: { type: 'json', expr: `${varName}.path().display()` },
        oldPath: {
            type: 'optionalField',
            where: `${varName}.status() == "renamed" || ${varName}.status() == "copied"`,
            valueExpr: `${varName}.source().path().display().escape_json()`,
        },
        status: {
            type: 'raw',
            expr: `if(${varName}.status() == "removed", "\\"deleted\\"", ${varName}.status().escape_json())`,
        },
        conflicted: { type: 'raw', expr: `${varName}.target().conflict()` },
    };
}

// Schema for JjLogEntry - defines how to serialize each field
export const LOG_ENTRY_SCHEMA: Record<string, JjTemplateField> = {
    commit_id: { type: 'string', expr: 'commit_id' },
    change_id: { type: 'string', expr: CHANGE_ID_EXPR },
    change_id_shortest: { type: 'string', expr: 'change_id.shortest()' },
    description: { type: 'json', expr: 'description' },
    author: {
        type: 'object',
        fields: {
            name: { type: 'json', expr: 'author.name()' },
            email: { type: 'string', expr: 'author.email()' },
            timestamp: { type: 'timestamp', expr: 'author.timestamp()' },
        },
    },
    committer: {
        type: 'object',
        fields: {
            name: { type: 'json', expr: 'committer.name()' },
            email: { type: 'string', expr: 'committer.email()' },
            timestamp: { type: 'timestamp', expr: 'committer.timestamp()' },
        },
    },
    bookmarks: {
        type: 'array',
        expr: 'bookmarks',
        itemSchema: {
            name: { type: 'string', expr: 'item.name()' },
            remote: { type: 'nullable', expr: 'item.remote()', valueExpr: 'item.remote()' },
        },
    },
    tags: {
        type: 'stringArray',
        expr: 'tags',
        itemExpr: 'item.name()',
    },
    is_immutable: { type: 'raw', expr: 'immutable' },
    is_current_working_copy: { type: 'raw', expr: 'current_working_copy' },
    working_copies: {
        type: 'rawArray',
        expr: 'working_copies',
        itemExpr: 'item.name().escape_json()',
    },
    is_empty: { type: 'raw', expr: 'empty' },
    is_divergent: { type: 'raw', expr: 'divergent' },
    change_id_offset: { type: 'raw', expr: 'if(change_offset, change_offset, "null")' },
    parents: {
        type: 'array',
        expr: 'parents',
        itemSchema: {
            commit_id: { type: 'string', expr: 'item.commit_id()' },
            change_id: { type: 'string', expr: CHANGE_ID_ITEM_EXPR },
            is_immutable: { type: 'raw', expr: 'item.immutable()' },
        },
    },
    conflict: { type: 'raw', expr: 'conflict' },
    is_hidden: { type: 'raw', expr: 'hidden' },
    changes: {
        type: 'array',
        expr: 'self.diff().files()',
        itemSchema: buildDiffFileSchema('item'),
    },
};

// Schema for JjBookmark
export const BOOKMARK_SCHEMA: Record<string, JjTemplateField> = {
    name: { type: 'string', expr: 'name' },
    remote: { type: 'nullable', expr: 'remote', valueExpr: 'remote' },
};

// Schema for JjWorkspace
export const WORKSPACE_SCHEMA: Record<string, JjTemplateField> = {
    name: { type: 'json', expr: 'name' },
    path: { type: 'json', expr: 'root' },
};
