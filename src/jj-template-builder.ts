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
    | { type: 'nullable'; expr: string; valueExpr: string }; // Nullable with if()

function buildTemplateExpr(field: JjTemplateField): string {
    switch (field.type) {
        case 'string':
            return `"\\\"" ++ ${field.expr} ++ "\\\""`;
        case 'json':
            return field.expr + '.escape_json()';
        case 'raw':
            return field.expr;
        case 'timestamp':
            return `"\\\"" ++ ${field.expr}.local().format("%Y-%m-%dT%H:%M:%S%:z") ++ "\\\""`;
        case 'array': {
            // Generate item template from itemSchema
            const itemParts = Object.entries(field.itemSchema).map(([key, itemField]) => {
                return `"\\\"${key}\\\": " ++ ${buildTemplateExpr(itemField)}`;
            });
            const itemTemplate = `"{" ++ ${itemParts.join(' ++ ", " ++ ')} ++ "}"`;
            return `"[" ++ ${field.expr}.map(|item| ${itemTemplate}).join(",") ++ "]"`;
        }
        case 'stringArray':
            return `"[" ++ ${field.expr}.map(|item| "\\\"" ++ ${field.itemExpr} ++ "\\\"").join(",") ++ "]"`;
        case 'rawArray':
            return `"[" ++ ${field.expr}.map(|item| ${field.itemExpr}).join(",") ++ "]"`;
        case 'object': {
            const parts = Object.entries(field.fields).map(
                ([key, value]) => `"\\\"${key}\\\": " ++ ${buildTemplateExpr(value)}`,
            );
            return `"{" ++ ${parts.join(' ++ ", " ++ ')} ++ "}"`;
        }
        case 'nullable':
            return `if(${field.expr}, "\\\"" ++ ${field.valueExpr} ++ "\\\"", "null")`;
    }
}

export function buildLogTemplate(schema: Record<string, JjTemplateField>): string {
    const parts = Object.entries(schema).map(([key, field]) => {
        return `"\\\"${key}\\\": " ++ ${buildTemplateExpr(field)}`;
    });
    return `"{" ++ ${parts.join(' ++ ", " ++ ')} ++ "}\\n"`;
}

// Schema for JjLogEntry - defines how to serialize each field
export const LOG_ENTRY_SCHEMA: Record<string, JjTemplateField> = {
    commit_id: { type: 'string', expr: 'commit_id' },
    change_id: { type: 'string', expr: 'change_id' },
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
    is_immutable: { type: 'raw', expr: 'immutable' },
    is_working_copy: { type: 'raw', expr: 'current_working_copy' },
    is_empty: { type: 'raw', expr: 'empty' },
    parents: {
        type: 'stringArray',
        expr: 'parents',
        itemExpr: 'item.commit_id()',
    },
    parents_immutable: {
        type: 'rawArray',
        expr: 'parents',
        itemExpr: 'item.immutable()',
    },
    conflict: { type: 'raw', expr: 'conflict' },
    changes: {
        type: 'array',
        expr: 'self.diff().files()',
        itemSchema: {
            path: { type: 'json', expr: 'item.path().display()' },
            oldPath: { type: 'json', expr: 'item.source().path().display()' },
            status: { type: 'string', expr: 'item.status()' },
            conflicted: { type: 'raw', expr: 'item.target().conflict()' },
        },
    },
};
