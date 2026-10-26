// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/brychanrobot/jj-view/internal/gitcred"
	"github.com/brychanrobot/jj-view/internal/protocol"
)

type recordedRequest struct {
	Method        string
	Path          string
	Authorization string
	Cookie        string
	Body          string
	XCustom       string
}

// startUpstream returns a loopback server that records requests and answers
// with the configured status.
func startUpstream(t *testing.T, status *atomic.Int32) (*httptest.Server, *recordedRequest) {
	t.Helper()
	var last recordedRequest
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAllString(r)
		last = recordedRequest{
			Method:        r.Method,
			Path:          r.URL.Path,
			Authorization: r.Header.Get("Authorization"),
			Cookie:        r.Header.Get("Cookie"),
			Body:          body,
			XCustom:       r.Header.Get("X-Custom"),
		}
		w.Header().Set("Set-Cookie", "leak=1")
		w.Header().Set("X-Upstream", "yes")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(int(status.Load()))
		_, _ = w.Write([]byte(`)]}'` + "\n" + `{"ok":true}`))
	}))
	t.Cleanup(upstream.Close)
	return upstream, &last
}

func readAllString(r *http.Request) (string, error) {
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := r.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return sb.String(), nil
}

func decodeFetchResult(t *testing.T, res protocol.Response) httpFetchResult {
	t.Helper()
	if res.Error != nil {
		t.Fatalf("http.fetch error: %+v", res.Error)
	}
	raw, _ := json.Marshal(res.Result)
	var out httpFetchResult
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	return out
}

func TestHTTPFetchRelaysRequestAndResponse(t *testing.T) {
	srv, _ := setupTestServer(t)
	var status atomic.Int32
	status.Store(http.StatusCreated)
	upstream, last := startUpstream(t, &status)

	body := `{"message":"hi"}`
	res := postRPC(t, srv, 1, "http.fetch", map[string]any{
		"url":    upstream.URL + "/a/changes/42/drafts",
		"method": "put",
		"headers": map[string]string{
			"Content-Type": "application/json",
			"X-Custom":     "custom",
			"Cookie":       "stolen=1",
			"Host":         "evil.example",
		},
		"body": body,
	})
	out := decodeFetchResult(t, res)

	if out.Status != http.StatusCreated || out.StatusText != "Created" {
		t.Fatalf("unexpected status: %d %q", out.Status, out.StatusText)
	}
	if !strings.HasSuffix(out.Body, `{"ok":true}`) {
		t.Fatalf("unexpected body: %q", out.Body)
	}
	if out.Headers["X-Upstream"] != "yes" {
		t.Fatalf("upstream header not relayed: %+v", out.Headers)
	}
	if _, leaked := out.Headers["Set-Cookie"]; leaked {
		t.Fatalf("Set-Cookie must not be relayed: %+v", out.Headers)
	}
	if last.Method != http.MethodPut || last.Path != "/a/changes/42/drafts" || last.Body != body {
		t.Fatalf("unexpected upstream request: %+v", *last)
	}
	if last.XCustom != "custom" {
		t.Fatalf("custom header not forwarded: %+v", *last)
	}
	if last.Cookie != "" {
		t.Fatalf("Cookie header must not be forwarded: %+v", *last)
	}
	if last.Authorization != "" {
		t.Fatalf("no auth requested, but Authorization was sent: %q", last.Authorization)
	}
}

func TestHTTPFetchRejectsNonLoopbackHTTPAndBadSchemes(t *testing.T) {
	srv, _ := setupTestServer(t)
	for _, target := range []string{
		"http://api.github.com/user",
		"ftp://example.com/file",
		"file:///etc/passwd",
		"/relative/path",
	} {
		res := postRPC(t, srv, 1, "http.fetch", map[string]any{"url": target})
		if res.Error == nil {
			t.Fatalf("expected error for %s, got result %+v", target, res.Result)
		}
	}
}

func TestHTTPFetchSecretAuthNeverLeavesDaemon(t *testing.T) {
	srv, _ := setupTestServer(t)
	var status atomic.Int32
	status.Store(http.StatusOK)
	upstream, last := startUpstream(t, &status)

	if res := postRPC(t, srv, 1, "secrets.store", map[string]string{"key": "github_token", "value": "ghp_secret"}); res.Error != nil {
		t.Fatalf("secrets.store: %+v", res.Error)
	}

	res := postRPC(t, srv, 2, "http.fetch", map[string]any{
		"url":  upstream.URL + "/user",
		"auth": map[string]string{"kind": "secret", "key": "github_token"},
	})
	out := decodeFetchResult(t, res)
	if out.Status != http.StatusOK {
		t.Fatalf("status %d", out.Status)
	}
	if last.Authorization != "Bearer ghp_secret" {
		t.Fatalf("secret not injected, got %q", last.Authorization)
	}
	raw, _ := json.Marshal(res.Result)
	if strings.Contains(string(raw), "ghp_secret") {
		t.Fatalf("secret leaked into the RPC result: %s", raw)
	}

	// Missing secret: request still goes out, unauthenticated.
	res = postRPC(t, srv, 3, "http.fetch", map[string]any{
		"url":  upstream.URL + "/user",
		"auth": map[string]string{"kind": "secret", "key": "missing"},
	})
	decodeFetchResult(t, res)
	if last.Authorization != "" {
		t.Fatalf("expected no Authorization for missing secret, got %q", last.Authorization)
	}
}

func TestHTTPFetchBearerAuth(t *testing.T) {
	srv, _ := setupTestServer(t)
	var status atomic.Int32
	status.Store(http.StatusOK)
	upstream, last := startUpstream(t, &status)

	res := postRPC(t, srv, 1, "http.fetch", map[string]any{
		"url":  upstream.URL + "/user",
		"auth": map[string]string{"kind": "bearer", "token": "oauth-token"},
	})
	decodeFetchResult(t, res)
	if last.Authorization != "Bearer oauth-token" {
		t.Fatalf("got %q", last.Authorization)
	}
}

func TestHTTPFetchGitAuthFromCookiesAndInvalidation(t *testing.T) {
	srv, tempRepo := setupTestServer(t)
	var status atomic.Int32
	status.Store(http.StatusOK)
	upstream, last := startUpstream(t, &status)

	// Point the daemon's resolver at an isolated home with a cookie for the
	// upstream's loopback host.
	home := t.TempDir()
	cookies := filepath.Join(home, ".gitcookies")
	if err := os.WriteFile(cookies, []byte("127.0.0.1\tTRUE\t/\tTRUE\t0\to\tgit-user=pw\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv.gitCreds = gitcred.NewResolver(gitcred.Options{
		Getenv:   func(string) string { return "" },
		LookPath: func(string) (string, error) { return "", os.ErrNotExist },
		HomeDir:  home,
	})

	has := postRPC(t, srv, 1, "http.hasGitCredentials", map[string]string{"url": upstream.URL + "/"})
	if has.Error != nil || has.Result.(map[string]any)["available"] != true {
		t.Fatalf("hasGitCredentials: %+v / %+v", has.Error, has.Result)
	}

	res := postRPC(t, srv, 2, "http.fetch", map[string]any{
		"url":  upstream.URL + "/a/changes/",
		"auth": map[string]string{"kind": "git"},
	})
	decodeFetchResult(t, res)
	if !strings.HasPrefix(last.Authorization, "Basic ") {
		t.Fatalf("expected cookie-derived Basic auth, got %q", last.Authorization)
	}

	// Remove the cookie: the cached credential is still used until the
	// upstream rejects it.
	_ = os.Remove(cookies)
	res = postRPC(t, srv, 3, "http.fetch", map[string]any{"url": upstream.URL + "/a/changes/", "auth": map[string]string{"kind": "git"}})
	decodeFetchResult(t, res)
	if last.Authorization == "" {
		t.Fatal("expected cached credential to be reused")
	}
	status.Store(http.StatusUnauthorized)
	res = postRPC(t, srv, 4, "http.fetch", map[string]any{"url": upstream.URL + "/a/changes/", "auth": map[string]string{"kind": "git"}})
	if out := decodeFetchResult(t, res); out.Status != http.StatusUnauthorized {
		t.Fatalf("expected upstream 401 to be relayed, got %d", out.Status)
	}
	status.Store(http.StatusOK)
	res = postRPC(t, srv, 5, "http.fetch", map[string]any{"url": upstream.URL + "/a/changes/", "auth": map[string]string{"kind": "git"}})
	decodeFetchResult(t, res)
	if last.Authorization != "" {
		t.Fatalf("expected credential to be re-resolved (and absent) after 401, got %q", last.Authorization)
	}

	// gitDir outside the sandbox is rejected.
	outside := postRPC(t, srv, 6, "http.hasGitCredentials", map[string]string{"url": upstream.URL, "gitDir": filepath.Join(os.TempDir(), "not-a-repo")})
	if outside.Error == nil || outside.Error.Code != protocol.CodeSecurityError {
		t.Fatalf("expected security error for gitDir outside sandbox, got %+v", outside.Error)
	}
	inside := postRPC(t, srv, 7, "http.hasGitCredentials", map[string]string{"url": upstream.URL, "gitDir": filepath.Join(tempRepo, ".git")})
	if inside.Error != nil {
		t.Fatalf("expected gitDir inside repo to be accepted, got %+v", inside.Error)
	}
}
