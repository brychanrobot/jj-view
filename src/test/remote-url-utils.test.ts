/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
    encodeRemoteFilePath,
    extractRemoteLineRange,
    formatRemoteFileUrl,
    normalizeRemoteHttpUrl,
    parseRemoteUrlToWebBaseUrl,
    resolveRemoteTarget,
    toOneBasedLineRange,
} from '../utils/remote-url-utils';

describe('remote-url-utils', () => {
    describe('normalizeRemoteHttpUrl', () => {
        it('normalizes trailing slashes and defaults missing scheme to https', () => {
            expect(normalizeRemoteHttpUrl('gerrit.example.com/r/')).toBe('https://gerrit.example.com/r');
            expect(normalizeRemoteHttpUrl('http://gitlab.local:8080/')).toBe('http://gitlab.local:8080');
        });

        it('rejects empty or local filesystem paths', () => {
            expect(normalizeRemoteHttpUrl('')).toBeUndefined();
            expect(normalizeRemoteHttpUrl('file:///tmp/bare.git')).toBeUndefined();
            expect(normalizeRemoteHttpUrl('/tmp/bare.git')).toBeUndefined();
        });
    });

    describe('parseRemoteUrlToWebBaseUrl', () => {
        it('converts SSH, SCP, git://, and credentialed HTTPS URLs to web base URLs', () => {
            expect(parseRemoteUrlToWebBaseUrl('https://user:token@github.com/org/repo.git')).toBe(
                'https://github.com/org/repo',
            );
            expect(parseRemoteUrlToWebBaseUrl('ssh://git@github.com:22/org/repo.git')).toBe(
                'https://github.com/org/repo',
            );
            expect(parseRemoteUrlToWebBaseUrl('git@gitlab.company.com:team/sub/service.git')).toBe(
                'https://gitlab.company.com/team/sub/service',
            );
            expect(parseRemoteUrlToWebBaseUrl('git://example.org/org/repo.git')).toBe('https://example.org/org/repo');
            expect(parseRemoteUrlToWebBaseUrl('ssh://alice@gerrit.example.com:29418/platform/core.git')).toBe(
                'https://gerrit.example.com/platform/core',
            );
            expect(parseRemoteUrlToWebBaseUrl('sso://chromium/a/chromium/src.git')).toBe(
                'https://chromium.googlesource.com/chromium/src',
            );
        });

        it('returns undefined for local paths', () => {
            expect(parseRemoteUrlToWebBaseUrl('/tmp/local-bare.git')).toBeUndefined();
            expect(parseRemoteUrlToWebBaseUrl('file:///tmp/local-bare.git')).toBeUndefined();
        });
    });

    describe('resolveRemoteTarget', () => {
        it('detects GitHub and GitLab from git_web_url or fallback remote URL', () => {
            expect(
                resolveRemoteTarget({
                    gitWebUrl: 'https://github.com/brychanrobot/jj-view',
                    remoteUrl: 'https://github.com/brychanrobot/jj-view.git',
                }),
            ).toEqual({
                kind: 'github',
                baseUrl: 'https://github.com/brychanrobot/jj-view',
            });

            expect(
                resolveRemoteTarget({
                    remoteUrl: 'git@gitlab.com:group/sub/project.git',
                }),
            ).toEqual({
                kind: 'gitlab',
                baseUrl: 'https://gitlab.com/group/sub/project',
            });
        });

        it('honors jj-view.gitlab.host when matching custom self-hosted GitLab', () => {
            expect(
                resolveRemoteTarget({
                    remoteUrl: 'git@code.internal.corp:eng/my-app.git',
                    settings: {
                        gitlabHost: 'https://code.internal.corp',
                    },
                }),
            ).toEqual({
                kind: 'gitlab',
                baseUrl: 'https://code.internal.corp/eng/my-app',
            });

            expect(
                resolveRemoteTarget({
                    gitWebUrl: 'https://code.internal.corp/gitlab/eng/my-app',
                    settings: {
                        gitlabHost: 'https://code.internal.corp/gitlab',
                    },
                }),
            ).toEqual({
                kind: 'gitlab',
                baseUrl: 'https://code.internal.corp/gitlab/eng/my-app',
            });
            // Preserves GitLab group paths starting with 'a/' without treating them as Gerrit auth prefixes
            expect(
                resolveRemoteTarget({
                    remoteUrl: 'git@code.internal.corp:a/service.git',
                    settings: {
                        gitlabHost: 'https://code.internal.corp',
                    },
                }),
            ).toEqual({
                kind: 'gitlab',
                baseUrl: 'https://code.internal.corp/a/service',
            });
        });

        it('honors jj-view.gerrit.host and jj-view.gerrit.project when applicable', () => {
            expect(
                resolveRemoteTarget({
                    remoteUrl: 'file:///tmp/bare.git',
                    settings: {
                        gerritHost: 'https://gerrit.example.com',
                        gerritProject: 'team/product',
                    },
                }),
            ).toEqual({
                kind: 'gerrit',
                host: 'https://gerrit.example.com',
                project: 'team/product',
            });

            // Derives project from remote URL when gerrit.project is omitted
            expect(
                resolveRemoteTarget({
                    remoteUrl: 'ssh://user@gerrit.example.com:29418/r/a/platform/tools.git',
                    settings: {
                        gerritHost: 'https://gerrit.example.com/r',
                    },
                }),
            ).toEqual({
                kind: 'gerrit',
                host: 'https://gerrit.example.com/r',
                project: 'platform/tools',
            });

            // Does not hijack explicit GitHub or unrelated self-hosted forges (GHE, Codeberg) when global gerrit.host is configured
            expect(
                resolveRemoteTarget({
                    gitWebUrl: 'https://github.com/org/repo',
                    settings: {
                        gerritHost: 'https://gerrit.example.com',
                        gerritProject: 'other/proj',
                    },
                }),
            ).toEqual({
                kind: 'github',
                baseUrl: 'https://github.com/org/repo',
            });

            expect(
                resolveRemoteTarget({
                    gitWebUrl: 'https://github.internal.corp/org/repo',
                    settings: {
                        gerritHost: 'https://gerrit.example.com',
                        gerritProject: 'other/proj',
                    },
                }),
            ).toEqual({
                kind: 'github',
                baseUrl: 'https://github.internal.corp/org/repo',
            });

            expect(
                resolveRemoteTarget({
                    gitWebUrl: 'https://codeberg.org/user/project',
                    settings: {
                        gerritHost: 'https://gerrit.example.com',
                    },
                }),
            ).toEqual({
                kind: 'github',
                baseUrl: 'https://codeberg.org/user/project',
            });

            // Auto-detects self-hosted Gerrit /a/ and /r/a/ URLs even without gerrit.host setting
            expect(
                resolveRemoteTarget({
                    gitWebUrl: 'https://gerrit.example.com/a/platform/tools',
                }),
            ).toEqual({
                kind: 'gerrit',
                host: 'https://gerrit.example.com',
                project: 'platform/tools',
            });

            expect(
                resolveRemoteTarget({
                    remoteUrl: 'https://review.example.com/gerrit/a/team/app.git',
                }),
            ).toEqual({
                kind: 'gerrit',
                host: 'https://review.example.com/gerrit',
                project: 'team/app',
            });
        });

        it('maps googlesource remotes and -review settings to Gitiles hosts', () => {
            expect(
                resolveRemoteTarget({
                    gitWebUrl: 'https://chromium.googlesource.com/chromium/src',
                }),
            ).toEqual({
                kind: 'googlesource',
                host: 'https://chromium.googlesource.com',
                project: 'chromium/src',
            });

            expect(
                resolveRemoteTarget({
                    remoteUrl: 'sso://android/platform/manifest',
                    settings: {
                        gerritHost: 'https://android-review.googlesource.com',
                    },
                }),
            ).toEqual({
                kind: 'googlesource',
                host: 'https://android.googlesource.com',
                project: 'platform/manifest',
            });
        });
    });

    describe('encodeRemoteFilePath & line helpers', () => {
        it('normalizes backslashes and encodes segments while preserving slashes', () => {
            expect(encodeRemoteFilePath('src\\my folder\\file#1?v=2%.ts')).toBe(
                'src/my%20folder/file%231%3Fv%3D2%25.ts',
            );
            expect(encodeRemoteFilePath('/leading/and/trailing/')).toBe('leading/and/trailing');
        });

        it('converts 0-based selection ranges to normalized 1-based ranges', () => {
            expect(toOneBasedLineRange({ startLine: 0, endLine: 0 })).toEqual({ startLine: 1 });
            expect(toOneBasedLineRange({ startLine: 4, endLine: 9 })).toEqual({ startLine: 5, endLine: 10 });
            expect(toOneBasedLineRange({ startLine: 9, endLine: 4 })).toEqual({ startLine: 5, endLine: 10 });
        });

        it('validates line ranges cleanly', () => {
            expect(extractRemoteLineRange({ startLine: 3, endLine: 7 })).toEqual({ startLine: 3, endLine: 7 });
            expect(extractRemoteLineRange({ startLine: 0 })).toBeUndefined();
            expect(extractRemoteLineRange(null)).toBeUndefined();
        });
    });

    describe('formatRemoteFileUrl', () => {
        const sha = '0123456789abcdef0123456789abcdef01234567';

        it('formats GitHub URLs with optional #Lstart or #Lstart-Lend', () => {
            const target = { kind: 'github', baseUrl: 'https://github.com/org/repo' } as const;
            expect(formatRemoteFileUrl({ target, commitSha: sha, relativePath: 'src/app.ts' })).toBe(
                `https://github.com/org/repo/blob/${sha}/src/app.ts`,
            );
            expect(
                formatRemoteFileUrl({
                    target,
                    commitSha: sha,
                    relativePath: 'src\\my file.ts',
                    lineRange: { startLine: 12 },
                }),
            ).toBe(`https://github.com/org/repo/blob/${sha}/src/my%20file.ts#L12`);
            expect(
                formatRemoteFileUrl({
                    target,
                    commitSha: sha,
                    relativePath: 'src/app.ts',
                    lineRange: { startLine: 12, endLine: 18 },
                }),
            ).toBe(`https://github.com/org/repo/blob/${sha}/src/app.ts#L12-L18`);
        });

        it('formats GitLab URLs with /-/blob/ and #Lstart-end ranges', () => {
            const target = { kind: 'gitlab', baseUrl: 'https://gitlab.com/group/sub/repo' } as const;
            expect(formatRemoteFileUrl({ target, commitSha: sha, relativePath: 'README.md' })).toBe(
                `https://gitlab.com/group/sub/repo/-/blob/${sha}/README.md`,
            );
            expect(
                formatRemoteFileUrl({
                    target,
                    commitSha: sha,
                    relativePath: 'README.md',
                    lineRange: { startLine: 5 },
                }),
            ).toBe(`https://gitlab.com/group/sub/repo/-/blob/${sha}/README.md#L5`);
            expect(
                formatRemoteFileUrl({
                    target,
                    commitSha: sha,
                    relativePath: 'README.md',
                    lineRange: { startLine: 5, endLine: 11 },
                }),
            ).toBe(`https://gitlab.com/group/sub/repo/-/blob/${sha}/README.md#L5-11`);
        });

        it('formats Gerrit plugin Gitiles and Googlesource URLs with #start line anchor', () => {
            const gerritTarget = {
                kind: 'gerrit',
                host: 'https://gerrit.example.com',
                project: 'platform/frameworks/base',
            } as const;
            expect(
                formatRemoteFileUrl({
                    target: gerritTarget,
                    commitSha: sha,
                    relativePath: 'core/Main.java',
                    lineRange: { startLine: 42, endLine: 50 },
                }),
            ).toBe(`https://gerrit.example.com/plugins/gitiles/platform/frameworks/base/+/${sha}/core/Main.java#42`);

            const googleTarget = {
                kind: 'googlesource',
                host: 'https://chromium.googlesource.com',
                project: 'chromium/src',
            } as const;
            expect(
                formatRemoteFileUrl({
                    target: googleTarget,
                    commitSha: sha,
                    relativePath: 'base/main.cc',
                    lineRange: { startLine: 9 },
                }),
            ).toBe(`https://chromium.googlesource.com/chromium/src/+/${sha}/base/main.cc#9`);
        });
    });
});
