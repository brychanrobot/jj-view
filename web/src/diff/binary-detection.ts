/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const BINARY_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.ico',
    '.webp',
    '.avif',
    '.pdf',
    '.zip',
    '.tar',
    '.gz',
    '.tgz',
    '.bz2',
    '.7z',
    '.wasm',
    '.exe',
    '.bin',
    '.so',
    '.dylib',
    '.dll',
    '.woff',
    '.woff2',
    '.ttf',
    '.otf',
    '.eot',
    '.mp3',
    '.mp4',
    '.wav',
    '.ogg',
    '.flac',
    '.webm',
    '.iso',
    '.dmg',
    '.pkg',
    '.deb',
    '.rpm',
]);

export function isBinaryByExtension(filename: string): boolean {
    const cleanFilename = filename.replace(/\s*\([^)]*\)$/, '');
    const lastSlash = Math.max(cleanFilename.lastIndexOf('/'), cleanFilename.lastIndexOf('\\'));
    const dotIdx = cleanFilename.lastIndexOf('.');
    if (dotIdx === -1 || dotIdx < lastSlash) {
        return false;
    }
    const ext = cleanFilename.slice(dotIdx).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

export function isBinaryString(content: string, maxBytesToCheck = 8192): boolean {
    const slice = content.slice(0, maxBytesToCheck);
    return slice.includes('\0');
}

export function isBinaryBuffer(buffer: Uint8Array, maxBytesToCheck = 8192): boolean {
    const checkLen = Math.min(buffer.length, maxBytesToCheck);
    for (let i = 0; i < checkLen; i++) {
        if (buffer[i] === 0) {
            return true;
        }
    }
    return false;
}

export function isBinaryFile(filename: string, content?: string): boolean {
    if (isBinaryByExtension(filename)) {
        return true;
    }
    if (content !== undefined) {
        return isBinaryString(content);
    }
    return false;
}
