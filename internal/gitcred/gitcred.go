// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

// Package gitcred resolves the HTTP credentials git itself would send to a
// host, so the daemon can perform authenticated requests on behalf of the web
// UI without ever handing a token to the page.
//
// The chain mirrors depot_tools' gerrit_util.py and the Node implementation in
// src/utils/git-credential-utils.ts:
//
//  1. git-remote-sso (Google hosts only): `git-remote-sso -print_config`
//     yields an extraHeader include file and/or a cookie file.
//  2. gitcookies: http.cookiefile from git config, $GIT_COOKIES_PATH, or
//     ~/.gitcookies. Only the `o` cookie on path `/` is used.
//  3. `git credential fill`.
//
// Resolution results (including "no credential") are cached per host for a
// short TTL; callers invalidate on 401/403.
package gitcred

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Credential is an HTTP header that authenticates a request.
type Credential struct {
	HeaderName  string
	HeaderValue string
}

// Options configures a Resolver. Zero values select OS-backed defaults.
type Options struct {
	// Getenv reads environment variables (default os.Getenv).
	Getenv func(string) string
	// LookPath locates executables (default exec.LookPath).
	LookPath func(string) (string, error)
	// HomeDir is the user's home directory (default os.UserHomeDir).
	HomeDir string
	// TTL bounds how long a resolution result is reused (default 5 minutes).
	TTL time.Duration
	// Now returns the current time (default time.Now).
	Now func() time.Time
	// Logf receives diagnostic messages (default discard).
	Logf func(format string, args ...any)
	// SSOTimeout bounds the git-remote-sso helper (default 5 seconds).
	SSOTimeout time.Duration
	// HelperTimeout bounds `git credential fill` (default 15 seconds).
	HelperTimeout time.Duration
}

type cacheEntry struct {
	cred    *Credential
	expires time.Time
}

// Resolver resolves and caches git credentials for hosts.
type Resolver struct {
	opts  Options
	mu    sync.Mutex
	cache map[string]cacheEntry
}

// NewResolver creates a Resolver.
func NewResolver(opts Options) *Resolver {
	if opts.Getenv == nil {
		opts.Getenv = os.Getenv
	}
	if opts.LookPath == nil {
		opts.LookPath = exec.LookPath
	}
	if opts.HomeDir == "" {
		opts.HomeDir, _ = os.UserHomeDir()
	}
	if opts.TTL <= 0 {
		opts.TTL = 5 * time.Minute
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Logf == nil {
		opts.Logf = func(string, ...any) {}
	}
	if opts.SSOTimeout <= 0 {
		opts.SSOTimeout = 5 * time.Second
	}
	if opts.HelperTimeout <= 0 {
		opts.HelperTimeout = 15 * time.Second
	}
	return &Resolver{opts: opts, cache: make(map[string]cacheEntry)}
}

func cacheKey(target *url.URL, gitDir string) string {
	return strings.ToLower(target.Scheme+"://"+target.Host) + "|" + gitDir
}

// Resolve returns the credential git would use for target, or nil when none
// is available. gitDir may be empty; when set it scopes git config lookups
// and credential helpers to that repository.
func (r *Resolver) Resolve(ctx context.Context, target *url.URL, gitDir string) (*Credential, error) {
	if target == nil || target.Hostname() == "" {
		return nil, errors.New("gitcred: target URL has no host")
	}
	key := cacheKey(target, gitDir)

	r.mu.Lock()
	defer r.mu.Unlock()
	if entry, ok := r.cache[key]; ok && r.opts.Now().Before(entry.expires) {
		return entry.cred, nil
	}

	cred := r.resolveUncached(ctx, target, gitDir)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	r.cache[key] = cacheEntry{cred: cred, expires: r.opts.Now().Add(r.opts.TTL)}
	return cred, nil
}

// Invalidate drops the cached result for target so the next Resolve re-runs
// the chain. Call it after an upstream 401/403.
func (r *Resolver) Invalidate(target *url.URL, gitDir string) {
	if target == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.cache, cacheKey(target, gitDir))
}

func (r *Resolver) resolveUncached(ctx context.Context, target *url.URL, gitDir string) *Credential {
	host := target.Hostname()
	if IsGoogleHost(host) {
		if cred := r.ssoCredential(ctx, host); cred != nil {
			r.opts.Logf("gitcred: %s authenticated via git-remote-sso", host)
			return cred
		}
	}
	if cred := r.cookieCredential(ctx, gitDir, host); cred != nil {
		r.opts.Logf("gitcred: %s authenticated via gitcookies", host)
		return cred
	}
	if cred := r.helperCredential(ctx, gitDir, target); cred != nil {
		r.opts.Logf("gitcred: %s authenticated via git credential helper", host)
		return cred
	}
	r.opts.Logf("gitcred: no credential for %s", host)
	return nil
}

// IsGoogleHost reports whether hostname belongs to Google infrastructure.
func IsGoogleHost(hostname string) bool {
	h := strings.TrimRight(strings.ToLower(hostname), ".")
	for _, domain := range []string{"google.com", "googlesource.com", "googleplex.com"} {
		if h == domain || strings.HasSuffix(h, "."+domain) {
			return true
		}
	}
	return false
}

var loopbackV4 = regexp.MustCompile(`^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$`)

// IsLoopbackHost reports whether hostname refers to the local machine.
func IsLoopbackHost(hostname string) bool {
	h := strings.ToLower(strings.TrimSpace(hostname))
	h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
	if h == "localhost" || h == "localhost.localdomain" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	if h == "::1" || h == "0.0.0.0" {
		return true
	}
	return loopbackV4.MatchString(h)
}

// matchCookieDomain implements Netscape cookie-jar domain matching.
func matchCookieDomain(host, cookieDomain string) bool {
	h := strings.ToLower(host)
	cd := strings.ToLower(cookieDomain)
	if strings.HasPrefix(cd, ".") {
		return h == cd[1:] || strings.HasSuffix(h, cd)
	}
	return h == cd
}

func basicCredential(login, secret string) *Credential {
	encoded := base64.StdEncoding.EncodeToString([]byte(login + ":" + secret))
	return &Credential{HeaderName: "Authorization", HeaderValue: "Basic " + encoded}
}

// credentialFromCookieFile extracts the `o` cookie for host from a Netscape
// cookie file and converts it to an Authorization header the way
// gerrit_util.py does: `git-<user>=<secret>` becomes Basic, anything else
// Bearer.
func credentialFromCookieFile(path, host string) *Credential {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(content), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		fields := strings.Split(trimmed, "\t")
		if len(fields) < 7 {
			continue
		}
		domain, cookiePath, name, value := fields[0], fields[2], fields[5], fields[6]
		if cookiePath != "/" || name != "o" || !matchCookieDomain(host, domain) {
			continue
		}
		if !strings.HasPrefix(value, "git-") {
			return &Credential{HeaderName: "Authorization", HeaderValue: "Bearer " + value}
		}
		idx := strings.Index(value, "=")
		if idx == -1 {
			continue
		}
		return basicCredential(value[:idx], value[idx+1:])
	}
	return nil
}

// credentialFromExtraHeaderFile parses the include file written by
// git-remote-sso, which contains `extraHeader = Name: value` entries.
func credentialFromExtraHeaderFile(path string) *Credential {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(content), "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "extraHeader") {
			continue
		}
		eq := strings.Index(trimmed, "=")
		if eq == -1 {
			continue
		}
		header := strings.TrimSpace(trimmed[eq+1:])
		colon := strings.Index(header, ":")
		if colon == -1 {
			continue
		}
		return &Credential{
			HeaderName:  strings.TrimSpace(header[:colon]),
			HeaderValue: strings.TrimSpace(header[colon+1:]),
		}
	}
	return nil
}

// ssoConfigURL is the remote pattern git-remote-sso prints config for.
const ssoConfigURL = "sso://*.git.corp.google.com"

// ssoCredential runs git-remote-sso and converts its output into a header.
func (r *Resolver) ssoCredential(ctx context.Context, host string) *Credential {
	bin, err := r.opts.LookPath("git-remote-sso")
	if err != nil {
		return nil
	}
	var cred *Credential
	err = r.withSSOConfig(ctx, bin, func(cfg map[string]string) {
		if include := cfg["include.path"]; include != "" {
			cred = credentialFromExtraHeaderFile(include)
			if cred != nil {
				return
			}
		}
		if cookieFile := cfg["http.cookiefile"]; cookieFile != "" {
			cred = credentialFromCookieFile(cookieFile, host)
		}
	})
	if err != nil {
		r.opts.Logf("gitcred: git-remote-sso failed: %v", err)
		return nil
	}
	return cred
}

// withSSOConfig runs `git-remote-sso -print_config` and calls fn with the
// parsed key=value output. The helper writes temp files, prints config that
// references them, closes stdout, then waits for stdin to close before
// deleting the files, so stdin is held open until fn returns.
func (r *Resolver) withSSOConfig(ctx context.Context, bin string, fn func(cfg map[string]string)) error {
	ctx, cancel := context.WithTimeout(ctx, r.opts.SSOTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, "-print_config", ssoConfigURL)
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	cfg := make(map[string]string)
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		eq := strings.Index(line, "=")
		if eq == -1 {
			continue
		}
		cfg[strings.TrimSpace(line[:eq])] = strings.TrimSpace(line[eq+1:])
	}
	if ctx.Err() != nil {
		return fmt.Errorf("timed out reading config: %w", ctx.Err())
	}
	if len(cfg) == 0 {
		return errors.New("printed no config")
	}
	fn(cfg)
	return nil
}

func (r *Resolver) gitArgs(gitDir string, args ...string) []string {
	if gitDir == "" {
		return args
	}
	return append([]string{"--git-dir=" + gitDir}, args...)
}

// gitEnv is the environment for git subprocesses. HOME follows HomeDir so
// tests can isolate global git config; in production both are the same.
func (r *Resolver) gitEnv(extra ...string) []string {
	env := append(os.Environ(), extra...)
	if r.opts.HomeDir != "" {
		env = append(env, "HOME="+r.opts.HomeDir)
	}
	return env
}

// gitConfig returns a single git config value, or "" when unset.
func (r *Resolver) gitConfig(ctx context.Context, gitDir string, args ...string) string {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", r.gitArgs(gitDir, append([]string{"config"}, args...)...)...)
	cmd.Dir = r.opts.HomeDir
	cmd.Env = r.gitEnv()
	cmd.Stderr = io.Discard
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// cookieFilePath mirrors git's own lookup order for the cookie jar.
func (r *Resolver) cookieFilePath(ctx context.Context, gitDir string) string {
	if path := r.gitConfig(ctx, gitDir, "--path", "--get", "http.cookiefile"); path != "" {
		return path
	}
	if path := r.opts.Getenv("GIT_COOKIES_PATH"); path != "" {
		return path
	}
	if r.opts.HomeDir == "" {
		return ""
	}
	candidate := filepath.Join(r.opts.HomeDir, ".gitcookies")
	if _, err := os.Stat(candidate); err != nil {
		return ""
	}
	return candidate
}

func (r *Resolver) cookieCredential(ctx context.Context, gitDir, host string) *Credential {
	path := r.cookieFilePath(ctx, gitDir)
	if path == "" {
		return nil
	}
	return credentialFromCookieFile(path, host)
}

// helperCredential asks `git credential fill`. Loopback hosts are skipped
// unless the repository itself configures a helper, so local test servers do
// not trigger OS keychain prompts.
func (r *Resolver) helperCredential(ctx context.Context, gitDir string, target *url.URL) *Credential {
	host := target.Hostname()
	if IsLoopbackHost(host) {
		if gitDir == "" || r.gitConfig(ctx, gitDir, "--local", "--get-all", "credential.helper") == "" {
			return nil
		}
	}

	ctx, cancel := context.WithTimeout(ctx, r.opts.HelperTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", r.gitArgs(gitDir, "credential", "fill")...)
	cmd.Dir = r.opts.HomeDir
	cmd.Env = r.gitEnv("GIT_TERMINAL_PROMPT=0")
	cmd.Stderr = io.Discard

	hostWithPort := host
	if strings.Contains(host, ":") {
		hostWithPort = "[" + host + "]"
	}
	if port := target.Port(); port != "" {
		hostWithPort += ":" + port
	}
	input := fmt.Sprintf("protocol=%s\nhost=%s\n\n", target.Scheme, hostWithPort)
	cmd.Stdin = strings.NewReader(input)

	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var username, password string
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "username=") {
			username = strings.TrimPrefix(line, "username=")
		} else if strings.HasPrefix(line, "password=") {
			password = strings.TrimPrefix(line, "password=")
		}
	}
	if password == "" {
		return nil
	}
	if username == "" || username == "Host" {
		return &Credential{HeaderName: "Authorization", HeaderValue: "Bearer " + password}
	}
	return basicCredential(username, password)
}
