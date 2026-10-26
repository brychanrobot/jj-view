// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package gitcred

import (
	"context"
	"encoding/base64"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return u
}

func writeFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func basic(login, secret string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(login+":"+secret))
}

// newTestResolver returns a resolver isolated from the developer's real
// credentials: empty env, an empty temp home, and no git-remote-sso.
func newTestResolver(t *testing.T, env map[string]string) (*Resolver, string) {
	t.Helper()
	home := t.TempDir()
	r := NewResolver(Options{
		Getenv: func(k string) string { return env[k] },
		LookPath: func(string) (string, error) {
			return "", exec.ErrNotFound
		},
		HomeDir: home,
		Logf:    t.Logf,
	})
	return r, home
}

func TestIsGoogleHost(t *testing.T) {
	for host, want := range map[string]bool{
		"chromium-review.googlesource.com": true,
		"google.com":                       true,
		"foo.googleplex.com.":              true,
		"gerrit.example.com":               false,
		"notgoogle.com":                    false,
	} {
		if got := IsGoogleHost(host); got != want {
			t.Errorf("IsGoogleHost(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestIsLoopbackHost(t *testing.T) {
	for host, want := range map[string]bool{
		"localhost":     true,
		"127.0.0.1":     true,
		"127.1.2.3":     true,
		"[::1]":         true,
		"app.localhost": true,
		"10.0.0.1":      false,
		"example.com":   false,
	} {
		if got := IsLoopbackHost(host); got != want {
			t.Errorf("IsLoopbackHost(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestCookieFileCredential(t *testing.T) {
	dir := t.TempDir()
	cookies := filepath.Join(dir, "cookies.txt")
	writeFile(t, cookies, "# Netscape HTTP Cookie File\n"+
		".googlesource.com\tTRUE\t/\tTRUE\t2147483647\to\tgit-user.google.com=1//secret\n"+
		"gerrit.example.com\tTRUE\t/\tTRUE\t2147483647\to\tbearer-token\n"+
		"other.example.com\tTRUE\t/\tTRUE\t2147483647\tsession\tignored\n", 0o600)

	got := credentialFromCookieFile(cookies, "chromium-review.googlesource.com")
	if got == nil || got.HeaderValue != basic("git-user.google.com", "1//secret") {
		t.Fatalf("googlesource cookie: got %+v", got)
	}
	got = credentialFromCookieFile(cookies, "gerrit.example.com")
	if got == nil || got.HeaderValue != "Bearer bearer-token" {
		t.Fatalf("bearer cookie: got %+v", got)
	}
	if got := credentialFromCookieFile(cookies, "other.example.com"); got != nil {
		t.Fatalf("non-o cookie should be ignored, got %+v", got)
	}
}

func TestResolveUsesGitCookiesPathEnv(t *testing.T) {
	cookies := filepath.Join(t.TempDir(), "gitcookies")
	writeFile(t, cookies, "gerrit.example.com\tTRUE\t/\tTRUE\t0\to\ttok\n", 0o600)
	r, _ := newTestResolver(t, map[string]string{"GIT_COOKIES_PATH": cookies})

	cred, err := r.Resolve(context.Background(), mustURL(t, "https://gerrit.example.com/a/changes"), "")
	if err != nil {
		t.Fatal(err)
	}
	if cred == nil || cred.HeaderValue != "Bearer tok" {
		t.Fatalf("got %+v", cred)
	}
}

func TestResolveUsesHomeGitcookies(t *testing.T) {
	r, home := newTestResolver(t, nil)
	writeFile(t, filepath.Join(home, ".gitcookies"), "gerrit.example.com\tTRUE\t/\tTRUE\t0\to\tgit-me=pw\n", 0o600)

	cred, err := r.Resolve(context.Background(), mustURL(t, "https://gerrit.example.com/"), "")
	if err != nil {
		t.Fatal(err)
	}
	if cred == nil || cred.HeaderValue != basic("git-me", "pw") {
		t.Fatalf("got %+v", cred)
	}
}

func TestResolveCachesAndInvalidates(t *testing.T) {
	cookies := filepath.Join(t.TempDir(), "gitcookies")
	r, _ := newTestResolver(t, map[string]string{"GIT_COOKIES_PATH": cookies})
	target := mustURL(t, "https://gerrit.example.com/")

	// No cookie file yet: resolves to nil and caches that.
	cred, err := r.Resolve(context.Background(), target, "")
	if err != nil || cred != nil {
		t.Fatalf("expected no credential, got %+v, %v", cred, err)
	}
	writeFile(t, cookies, "gerrit.example.com\tTRUE\t/\tTRUE\t0\to\ttok\n", 0o600)
	cred, _ = r.Resolve(context.Background(), target, "")
	if cred != nil {
		t.Fatalf("expected cached nil, got %+v", cred)
	}
	r.Invalidate(target, "")
	cred, _ = r.Resolve(context.Background(), target, "")
	if cred == nil || cred.HeaderValue != "Bearer tok" {
		t.Fatalf("expected refreshed credential, got %+v", cred)
	}
}

func TestResolveCacheExpires(t *testing.T) {
	cookies := filepath.Join(t.TempDir(), "gitcookies")
	now := time.Unix(1_000_000, 0)
	r := NewResolver(Options{
		Getenv:   func(k string) string { return map[string]string{"GIT_COOKIES_PATH": cookies}[k] },
		LookPath: func(string) (string, error) { return "", exec.ErrNotFound },
		HomeDir:  t.TempDir(),
		TTL:      time.Minute,
		Now:      func() time.Time { return now },
	})
	target := mustURL(t, "https://gerrit.example.com/")
	if cred, _ := r.Resolve(context.Background(), target, ""); cred != nil {
		t.Fatalf("expected nil, got %+v", cred)
	}
	writeFile(t, cookies, "gerrit.example.com\tTRUE\t/\tTRUE\t0\to\ttok\n", 0o600)
	now = now.Add(2 * time.Minute)
	if cred, _ := r.Resolve(context.Background(), target, ""); cred == nil {
		t.Fatal("expected credential after TTL expiry")
	}
}

func TestResolveSSOExtraHeader(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script helper")
	}
	dir := t.TempDir()
	include := filepath.Join(dir, "git-authentication.config")
	writeFile(t, include, "[http]\n\textraHeader = Authorization: Bearer sso-token\n", 0o600)
	cookieFile := filepath.Join(dir, "cookies.txt")
	writeFile(t, cookieFile, "", 0o600)
	// Mimic the real helper: print config, close stdout, then block until
	// stdin closes.
	helper := filepath.Join(dir, "git-remote-sso")
	writeFile(t, helper, "#!/bin/sh\n"+
		"echo http.cookiefile="+cookieFile+"\n"+
		"echo include.path="+include+"\n"+
		"exec 1>&-\n"+
		"cat >/dev/null\n", 0o755)

	r := NewResolver(Options{
		Getenv:   func(string) string { return "" },
		LookPath: func(name string) (string, error) { return helper, nil },
		HomeDir:  t.TempDir(),
		Logf:     t.Logf,
	})

	start := time.Now()
	cred, err := r.Resolve(context.Background(), mustURL(t, "https://chromium-review.googlesource.com/"), "")
	if err != nil {
		t.Fatal(err)
	}
	if cred == nil || cred.HeaderName != "Authorization" || cred.HeaderValue != "Bearer sso-token" {
		t.Fatalf("got %+v", cred)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("resolution should not wait for the helper's timeout, took %v", elapsed)
	}

	// Non-Google hosts never consult the SSO helper.
	cred, err = r.Resolve(context.Background(), mustURL(t, "https://gerrit.example.com/"), "")
	if err != nil || cred != nil {
		t.Fatalf("expected no credential for non-Google host, got %+v, %v", cred, err)
	}
}

func TestResolveSSOCookieFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script helper")
	}
	dir := t.TempDir()
	cookieFile := filepath.Join(dir, "cookies.txt")
	writeFile(t, cookieFile, ".googlesource.com\tTRUE\t/\tTRUE\t0\to\tgit-sso.google.com=cookie-secret\n", 0o600)
	helper := filepath.Join(dir, "git-remote-sso")
	writeFile(t, helper, "#!/bin/sh\necho http.cookiefile="+cookieFile+"\n", 0o755)

	r := NewResolver(Options{
		Getenv:   func(string) string { return "" },
		LookPath: func(string) (string, error) { return helper, nil },
		HomeDir:  t.TempDir(),
	})
	cred, err := r.Resolve(context.Background(), mustURL(t, "https://chromium-review.googlesource.com/"), "")
	if err != nil {
		t.Fatal(err)
	}
	if cred == nil || cred.HeaderValue != basic("git-sso.google.com", "cookie-secret") {
		t.Fatalf("got %+v", cred)
	}
}

func TestResolveCredentialHelper(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell helper")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "credential.helper", "!f() { echo username=git-helper; echo password=helper-pw; }; f")
	gitDir := filepath.Join(repo, ".git")

	r, _ := newTestResolver(t, nil)
	cred, err := r.Resolve(context.Background(), mustURL(t, "https://gerrit.example.com/"), gitDir)
	if err != nil {
		t.Fatal(err)
	}
	if cred == nil || cred.HeaderValue != basic("git-helper", "helper-pw") {
		t.Fatalf("got %+v", cred)
	}

	// Loopback hosts use the helper only when the repo configures one.
	cred, _ = r.Resolve(context.Background(), mustURL(t, "http://127.0.0.1:8080/"), gitDir)
	if cred == nil {
		t.Fatal("expected loopback credential from repo-local helper")
	}
	cred, _ = r.Resolve(context.Background(), mustURL(t, "http://127.0.0.1:8080/"), "")
	if cred != nil {
		t.Fatalf("expected no loopback credential without a repo helper, got %+v", cred)
	}
}
