/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { HostHttp, HostHttpAuth, HostHttpRequest, HostSecrets } from '../core/host/host-environment';
import { Duration } from './duration';
import { fetchWithTimeout } from './fetch-utils';
import { resolveGitAuthHeader } from './git-credential-utils';
import type { LoggerChannel } from './output-channel';

const DEFAULT_TIMEOUT_MS = 15000;
const GIT_CREDENTIAL_TTL = Duration.minutes(5);

interface AuthHeader {
    readonly name: string;
    readonly value: string;
}

interface CachedGitCredential {
    readonly header: AuthHeader | undefined;
    readonly expiresAt: number;
}

/**
 * {@link HostHttp} for Node hosts (the VS Code extension host). Requests run
 * in-process; git credentials come from the same chain git uses, resolved via
 * {@link resolveGitAuthHeader} and cached per origin for a short TTL.
 */
export class NodeHostHttp implements HostHttp {
    private readonly gitCredentials = new Map<string, CachedGitCredential>();
    private readonly inFlight = new Map<string, Promise<AuthHeader | undefined>>();

    constructor(
        private readonly secrets: HostSecrets,
        private readonly logger?: LoggerChannel,
        private readonly now: () => number = () => Date.now(),
    ) {}

    public async fetch(url: string, request: HostHttpRequest = {}): Promise<Response> {
        const headers = new Headers(request.headers);
        const gitCacheKey = request.auth ? await this.applyAuth(url, headers, request.auth) : undefined;

        const response = await fetchWithTimeout(url, request.timeoutMs ?? DEFAULT_TIMEOUT_MS, {
            method: request.method,
            headers,
            body: request.body,
            signal: request.signal,
        });

        if (gitCacheKey && (response.status === 401 || response.status === 403)) {
            this.logger?.warn(`[NodeHostHttp] ${response.status} from ${url}; dropping cached git credential`);
            this.gitCredentials.delete(gitCacheKey);
        }
        return response;
    }

    public async hasGitCredentials(url: string, gitDir?: string): Promise<boolean> {
        const credential = await this.resolveGitCredential(url, gitDir);
        return credential.header !== undefined;
    }

    /**
     * Applies the selected credential to `headers`. Returns the git credential
     * cache key when a git credential was attached, so the caller can
     * invalidate it on rejection.
     */
    private async applyAuth(url: string, headers: Headers, auth: HostHttpAuth): Promise<string | undefined> {
        switch (auth.kind) {
            case 'git': {
                const credential = await this.resolveGitCredential(url, auth.gitDir);
                if (!credential.header) {
                    return undefined;
                }
                headers.set(credential.header.name, credential.header.value);
                return credential.cacheKey;
            }
            case 'secret': {
                const token = await this.secrets.get(auth.key);
                if (token) {
                    headers.set('Authorization', `Bearer ${token}`);
                }
                return undefined;
            }
            case 'bearer':
                headers.set('Authorization', `Bearer ${auth.token}`);
                return undefined;
        }
    }

    private async resolveGitCredential(
        url: string,
        gitDir: string | undefined,
    ): Promise<{ header: AuthHeader | undefined; cacheKey: string }> {
        const origin = new URL(url).origin;
        const cacheKey = `${origin}|${gitDir ?? ''}`;
        const cached = this.gitCredentials.get(cacheKey);
        if (cached && cached.expiresAt > this.now()) {
            return { header: cached.header, cacheKey };
        }
        const inFlight = this.inFlight.get(cacheKey);
        if (inFlight) {
            return { header: await inFlight, cacheKey };
        }
        const resolution = resolveGitAuthHeader(origin, gitDir ?? null, this.logger).finally(() => {
            this.inFlight.delete(cacheKey);
        });
        this.inFlight.set(cacheKey, resolution);
        const header = await resolution;
        this.gitCredentials.set(cacheKey, {
            header,
            expiresAt: this.now() + GIT_CREDENTIAL_TTL.toMilliseconds(),
        });
        return { header, cacheKey };
    }
}
