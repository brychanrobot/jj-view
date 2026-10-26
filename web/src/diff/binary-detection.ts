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
    '.bmp',
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

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
};

export function getFileExtension(filename: string): string {
    const cleanName = filename.replace(/\s*\([^)]*\)$/, '').trim();
    const lastSlash = Math.max(cleanName.lastIndexOf('/'), cleanName.lastIndexOf('\\'));
    const dotIdx = cleanName.lastIndexOf('.');
    if (dotIdx === -1 || dotIdx < lastSlash) {
        return '';
    }
    return cleanName.slice(dotIdx).toLowerCase();
}

export function isBinaryByExtension(filename: string): boolean {
    const ext = getFileExtension(filename);
    if (!ext) {
        return false;
    }
    return BINARY_EXTENSIONS.has(ext);
}

export function getImageMimeType(filename: string): string | undefined {
    const ext = getFileExtension(filename);
    if (!ext) {
        return undefined;
    }
    return IMAGE_MIME_TYPES[ext];
}

export function isImageByExtension(filename: string): boolean {
    return Boolean(getImageMimeType(filename));
}

export function isSvgByExtension(filename: string): boolean {
    return getFileExtension(filename) === '.svg';
}

export function uint8ArrayToDataUrl(bytes: Uint8Array, mimeType: string): string {
    if (bytes.length === 0) {
        return '';
    }
    const chunkSize = 0x2000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    const base64 = btoa(binary);
    return `data:${mimeType};base64,${base64}`;
}

export function toImageDataUrl(content: string | undefined, filename: string): string {
    if (!content) {
        return '';
    }
    if (
        content.startsWith('data:image/') ||
        content.startsWith('blob:') ||
        content.startsWith('http://') ||
        content.startsWith('https://')
    ) {
        return content;
    }
    if (isSvgByExtension(filename)) {
        return uint8ArrayToDataUrl(new TextEncoder().encode(content), 'image/svg+xml');
    }
    const mimeType = getImageMimeType(filename) ?? 'image/png';
    const bytes = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) {
        bytes[i] = content.charCodeAt(i) & 0xff;
    }
    return uint8ArrayToDataUrl(bytes, mimeType);
}

export function getDataUrlByteLength(content: string | undefined): number {
    if (!content) {
        return 0;
    }
    if (content.startsWith('data:')) {
        const commaIdx = content.indexOf(',');
        if (commaIdx !== -1 && content.slice(0, commaIdx).includes(';base64')) {
            const base64 = content.slice(commaIdx + 1).trim();
            if (base64.length === 0) {
                return 0;
            }
            let padding = 0;
            if (base64.endsWith('==')) {
                padding = 2;
            } else if (base64.endsWith('=')) {
                padding = 1;
            }
            return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
        }
    }
    return new TextEncoder().encode(content).byteLength;
}

export function formatByteSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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
