/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface FileIconDef {
    readonly type: 'badge' | 'svg' | 'codicon';
    readonly text?: string;
    readonly svg?: string;
    readonly codicon?: string;
    readonly color: string;
}

export function getFileIcon(filename: string): FileIconDef {
    const lower = filename.toLowerCase();

    // 1. Exact filenames
    if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) {
        return { type: 'codicon', codicon: 'codicon-server', color: '#388bfd' };
    }
    if (lower === '.gitignore' || lower === '.gitmodules' || lower === '.gitattributes') {
        return { type: 'codicon', codicon: 'codicon-git-branch', color: '#f05032' };
    }
    if (lower === '.jjignore' || lower === '.jjdescription') {
        return { type: 'badge', text: 'jj', color: '#69b1ff' };
    }
    if (lower === 'license' || lower.startsWith('license.')) {
        return { type: 'codicon', codicon: 'codicon-law', color: '#cbcb41' };
    }

    // 2. Test file pattern matching (matches Seti theme orange #e37933 for test/spec files)
    const isTestFile =
        lower.endsWith('.test.ts') ||
        lower.endsWith('.spec.ts') ||
        lower.endsWith('.test.mts') ||
        lower.endsWith('.spec.mts') ||
        lower.endsWith('.test.cts') ||
        lower.endsWith('.spec.cts') ||
        lower.endsWith('.test.js') ||
        lower.endsWith('.spec.js') ||
        lower.endsWith('.test.mjs') ||
        lower.endsWith('.spec.mjs') ||
        lower.endsWith('.test.cjs') ||
        lower.endsWith('.spec.cjs') ||
        lower.endsWith('.test.tsx') ||
        lower.endsWith('.spec.tsx') ||
        lower.endsWith('.test.jsx') ||
        lower.endsWith('.spec.jsx');

    if (isTestFile) {
        if (lower.endsWith('.tsx')) {
            return { type: 'badge', text: 'TSX', color: '#e37933' };
        }
        if (lower.endsWith('.jsx')) {
            return { type: 'badge', text: 'JSX', color: '#e37933' };
        }
        if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
            return { type: 'badge', text: 'JS', color: '#e37933' };
        }
        return { type: 'badge', text: 'TS', color: '#e37933' };
    }

    // 3. Extension matching
    const lastDot = lower.lastIndexOf('.');
    const ext = lastDot !== -1 ? lower.slice(lastDot) : '';

    switch (ext) {
        case '.ts':
        case '.mts':
        case '.cts':
            return { type: 'badge', text: 'TS', color: '#519aba' };
        case '.tsx':
            return { type: 'badge', text: 'TSX', color: '#519aba' };
        case '.js':
        case '.mjs':
        case '.cjs':
            return { type: 'badge', text: 'JS', color: '#cbcb41' };
        case '.jsx':
            return { type: 'badge', text: 'JSX', color: '#519aba' };
        case '.json':
        case '.jsonc':
        case '.json5':
            return { type: 'badge', text: '{}', color: '#cbcb41' };
        case '.svelte':
            return {
                type: 'svg',
                color: '#cc3e44',
                svg: '<svg width="14" height="14" viewBox="0 0 32 32" fill="#cc3e44"><path d="M10.617 10.473L14.809 7.8c2.387-1.52 5.688-.812 7.359 1.58a5.123 5.123 0 01.876 3.876 4.821 4.821 0 01-.72 1.798c.524.998.7 2.142.5 3.251a4.808 4.808 0 01-1.963 3.081l-.21.14-4.192 2.672c-2.386 1.52-5.688.812-7.36-1.58a5.125 5.125 0 01-.875-3.876c.116-.642.36-1.253.72-1.798a5.065 5.065 0 01-.5-3.251 4.81 4.81 0 011.962-3.081l.21-.14L14.81 7.8l-4.192 2.672zm9.825.008a3.33 3.33 0 00-3.573-1.324c-.226.06-.444.146-.65.256l-.202.118-4.192 2.671a2.891 2.891 0 00-1.306 1.937 3.081 3.081 0 00.526 2.33 3.33 3.33 0 003.574 1.326c.226-.06.444-.147.65-.256l.201-.118 1.6-1.02a.923.923 0 01.257-.113c.407-.105.837.054 1.077.4a.931.931 0 01.158.702.873.873 0 01-.295.512l-.099.072-4.192 2.671a.923.923 0 01-.257.113 1.003 1.003 0 01-1.076-.4.94.94 0 01-.171-.49l.002-.132.014-.156-.156-.047a5.407 5.407 0 01-1.387-.645l-.252-.174-.215-.158-.08.24a2.923 2.923 0 00-.1.392 3.082 3.082 0 00.527 2.33 3.33 3.33 0 003.38 1.37l.194-.045c.226-.06.444-.146.65-.256l.202-.118 4.192-2.671a2.892 2.892 0 001.306-1.937 3.081 3.081 0 00-.526-2.331 3.33 3.33 0 00-3.574-1.325 3.05 3.05 0 00-.65.257l-.201.117-1.6 1.02a.927.927 0 01-.257.113 1.003 1.003 0 01-1.077-.4.93.93 0 01-.158-.702.871.871 0 01.295-.512l.098-.072 4.192-2.671a.923.923 0 01.258-.113c.407-.106.836.053 1.076.399a.942.942 0 01.171.49l-.002.133-.014.156.155.047c.492.148.959.365 1.388.645l.252.175.215.157.079-.24c.042-.129.076-.26.1-.392a3.082 3.082 0 00-.526-2.33z"/></svg>',
            };
        case '.go':
            return {
                type: 'svg',
                color: '#00add8',
                svg: '<svg width="15" height="15" viewBox="0 0 16 16" fill="#00add8"><circle cx="4.5" cy="8" r="2.8"/><circle cx="11.5" cy="8" r="2.8"/><circle cx="4.5" cy="8" r="1.3" fill="#171717"/><circle cx="11.5" cy="8" r="1.3" fill="#171717"/><circle cx="5" cy="7.3" r="0.6" fill="#ffffff"/><circle cx="12" cy="7.3" r="0.6" fill="#ffffff"/><path d="M7.5 8h1" stroke="#00add8" stroke-width="1.2"/></svg>',
            };
        case '.yml':
        case '.yaml':
            return { type: 'badge', text: '!', color: '#cb171e' };
        case '.md':
        case '.markdown':
        case '.mdx':
            return { type: 'badge', text: 'M↓', color: '#519aba' };
        case '.html':
        case '.htm':
            return { type: 'badge', text: '<>', color: '#e37933' };
        case '.css':
            return { type: 'badge', text: '#', color: '#519aba' };
        case '.scss':
        case '.sass':
        case '.less':
            return { type: 'badge', text: '#', color: '#f55385' };
        case '.rs':
            return { type: 'badge', text: 'RS', color: '#dea584' };
        case '.py':
        case '.pyi':
        case '.pyw':
            return { type: 'badge', text: 'PY', color: '#3572a5' };
        case '.sh':
        case '.bash':
        case '.zsh':
        case '.fish':
            return { type: 'badge', text: '>_', color: '#4d9375' };
        case '.c':
        case '.h':
            return { type: 'badge', text: 'C', color: '#519aba' };
        case '.cpp':
        case '.cc':
        case '.cxx':
        case '.hpp':
            return { type: 'badge', text: 'C++', color: '#519aba' };
        case '.java':
            return { type: 'badge', text: '☕', color: '#cc3e44' };
        case '.kt':
        case '.kts':
            return { type: 'badge', text: 'K', color: '#a074c4' };
        case '.rb':
            return { type: 'badge', text: 'RB', color: '#cc3e44' };
        case '.php':
            return { type: 'badge', text: 'PHP', color: '#a074c4' };
        case '.swift':
            return { type: 'badge', text: 'SW', color: '#e37933' };
        case '.sql':
            return { type: 'codicon', codicon: 'codicon-database', color: '#dad8d8' };
        case '.toml':
            return { type: 'badge', text: 'TOML', color: '#9c4221' };
        case '.svg':
        case '.png':
        case '.jpg':
        case '.jpeg':
        case '.gif':
        case '.webp':
        case '.ico':
            return { type: 'codicon', codicon: 'codicon-file-media', color: '#a074c4' };
        case '.zip':
        case '.tar':
        case '.gz':
        case '.7z':
            return { type: 'codicon', codicon: 'codicon-file-zip', color: '#cbcb41' };
        default:
            return { type: 'codicon', codicon: 'codicon-file', color: 'var(--vscode-descriptionForeground, #8a8a8a)' };
    }
}
