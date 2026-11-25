// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/brychanrobot/jj-view/internal/server"
)

func TestIsAddrInUseAndDialHost(t *testing.T) {
	if isAddrInUse(nil) {
		t.Fatalf("expected false for nil error")
	}
	if !isAddrInUse(syscall.EADDRINUSE) {
		t.Fatalf("expected true for EADDRINUSE")
	}
	if !isAddrInUse(errors.New("listen tcp 127.0.0.1:8080: bind: address already in use")) {
		t.Fatalf("expected true for 'address already in use'")
	}
	if isAddrInUse(errors.New("permission denied")) {
		t.Fatalf("expected false for unrelated error")
	}

	cases := []struct {
		in   string
		want string
	}{
		{"", "127.0.0.1"},
		{"0.0.0.0", "127.0.0.1"},
		{"::", "::1"},
		{"127.0.0.1", "127.0.0.1"},
		{"localhost", "localhost"},
	}
	for _, tc := range cases {
		if got := dialHostForConnect(tc.in); got != tc.want {
			t.Errorf("dialHostForConnect(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestOpenFolderOnExistingServer(t *testing.T) {
	t.Setenv("ANTIGRAVITY_CSRF_TOKEN", "")
	t.Setenv("ANTIGRAVITY_SIDECAR_UI_TOKEN", "")
	t.Setenv("ANTIGRAVITY_SIDECAR_WEB_PORT", "")
	t.Setenv("ANTIGRAVITY_EXECUTABLE_DATA_DIR", "")
	t.Setenv("JJ_VIEW_AGY_SIDECAR", "")

	tempDir := t.TempDir()
	repo1 := filepath.Join(tempDir, "repo1")
	repo2 := filepath.Join(tempDir, "repo2")
	userDataDir := filepath.Join(tempDir, "userdata")
	for _, d := range []string{repo1, repo2, userDataDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	notDirFile := filepath.Join(tempDir, "plain.txt")
	if err := os.WriteFile(notDirFile, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	srv, err := server.NewServer(server.Config{
		Host:        "127.0.0.1",
		Port:        0,
		RepoRoot:    repo1,
		UserDataDir: userDataDir,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	if err := srv.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	go func() {
		_ = srv.Start()
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Close(ctx)
	})

	// 1. Register repo2 as an allowed root on the running server and return a per-tab ?repo= URL
	res, err := openFolderOnExistingServer(openOptions{
		Host:        "127.0.0.1",
		Port:        srv.Port(),
		FolderPath:  repo2,
		UserDataDir: userDataDir,
	})
	if err != nil {
		t.Fatalf("openFolderOnExistingServer failed: %v", err)
	}
	if res.Path != repo2 {
		t.Fatalf("Path = %q, want %q", res.Path, repo2)
	}
	if !slices.Contains(srv.AllowedRoots(), repo2) {
		t.Fatalf("expected repo2 %q in server AllowedRoots %v", repo2, srv.AllowedRoots())
	}
	parsedTabURL, err := url.Parse(res.TabURL)
	if err != nil {
		t.Fatalf("failed to parse TabURL %q: %v", res.TabURL, err)
	}
	if parsedTabURL.Host != fmt.Sprintf("127.0.0.1:%d", srv.Port()) {
		t.Fatalf("TabURL host = %q, want 127.0.0.1:%d", parsedTabURL.Host, srv.Port())
	}
	if parsedTabURL.Query().Get("repo") != repo2 {
		t.Fatalf("TabURL repo = %q, want %q", parsedTabURL.Query().Get("repo"), repo2)
	}
	if parsedTabURL.Query().Get("token") != srv.SessionToken() {
		t.Fatalf("TabURL token mismatch")
	}

	// 2. Non-directory path returns an explicit error
	if _, err := openFolderOnExistingServer(openOptions{
		Host:        "127.0.0.1",
		Port:        srv.Port(),
		FolderPath:  notDirFile,
		UserDataDir: userDataDir,
	}); err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Fatalf("expected non-directory error, got %v", err)
	}

	// 3. Mismatched userDataDir returns helpful error instead of errNoExistingServer
	_, err = openFolderOnExistingServer(openOptions{
		Host:        "127.0.0.1",
		Port:        srv.Port(),
		FolderPath:  repo2,
		UserDataDir: filepath.Join(tempDir, "wrong-userdata"),
	})
	if err == nil || errors.Is(err, errNoExistingServer) || !strings.Contains(err.Error(), "session metadata") {
		t.Fatalf("expected session metadata error, got %v", err)
	}

	// 4. Non-jj-view HTTP server returns errNoExistingServer even when folder does not exist
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer foreign.Close()
	parsed, _ := url.Parse(foreign.URL)
	host, portStr, _ := net.SplitHostPort(parsed.Host)
	foreignPort, _ := strconv.Atoi(portStr)
	_, err = openFolderOnExistingServer(openOptions{
		Host:        host,
		Port:        foreignPort,
		FolderPath:  filepath.Join(tempDir, "nonexistent-folder"),
		UserDataDir: userDataDir,
	})
	if !errors.Is(err, errNoExistingServer) {
		t.Fatalf("expected errNoExistingServer for non-jj-view server, got %v", err)
	}

	// 5. Sidecar server without instance file reports sidecar management message
	sidecarSrv, err := server.NewServer(server.Config{
		Host:         "127.0.0.1",
		Port:         0,
		RepoRoot:     repo1,
		SidecarToken: "sidecar-tok",
		CSRFToken:    "csrf-tok",
		UserDataDir:  filepath.Join(tempDir, "sidecar-userdata"),
	})
	if err != nil {
		t.Fatalf("NewServer sidecar: %v", err)
	}
	if err := sidecarSrv.Listen(); err != nil {
		t.Fatalf("sidecar Listen: %v", err)
	}
	go func() {
		_ = sidecarSrv.Start()
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = sidecarSrv.Close(ctx)
	})
	_, err = openFolderOnExistingServer(openOptions{
		Host:        "127.0.0.1",
		Port:        sidecarSrv.Port(),
		FolderPath:  repo2,
		UserDataDir: userDataDir,
	})
	if err == nil || !strings.Contains(err.Error(), "sidecar") {
		t.Fatalf("expected sidecar error message, got %v", err)
	}

	// 6. runOpenCommandWithBrowser validates args and invokes browserFn even when UI clients are connected
	var stdout, stderr bytes.Buffer
	err = runOpenCommandWithBrowser([]string{"--repo", repo2, repo1}, &stdout, &stderr, nil)
	if err == nil || !strings.Contains(err.Error(), "not both") {
		t.Fatalf("expected error when passing both --repo and positional arg, got %v", err)
	}

	noProxyClient := &http.Client{
		Timeout:   2 * time.Second,
		Transport: &http.Transport{Proxy: nil},
	}
	sseResp, err := noProxyClient.Get(fmt.Sprintf("http://127.0.0.1:%d/api/events?token=%s&clientId=existing-tab", srv.Port(), srv.SessionToken()))
	if err != nil {
		t.Fatalf("SSE connect failed: %v", err)
	}
	defer sseResp.Body.Close()

	openedCh := make(chan string, 1)
	stdout.Reset()
	stderr.Reset()
	err = runOpenCommandWithBrowser(
		[]string{repo2, "--host", "127.0.0.1", "--port", strconv.Itoa(srv.Port()), "--user-data-dir", userDataDir},
		&stdout,
		&stderr,
		func(u string) {
			openedCh <- u
		},
	)
	if err != nil {
		t.Fatalf("runOpenCommandWithBrowser with trailing flags failed: %v", err)
	}
	if !strings.Contains(stdout.String(), res.TabURL) {
		t.Fatalf("expected tab URL %q in output, got:\n%s", res.TabURL, stdout.String())
	}
	select {
	case u := <-openedCh:
		if u != res.TabURL {
			t.Fatalf("browser opened %q, want %q", u, res.TabURL)
		}
	default:
		t.Fatal("expected browser callback to be invoked synchronously even with connected UI clients")
	}

	// 7. --no-open suppresses browser launch
	openedChNoOpen := make(chan string, 1)
	stdout.Reset()
	stderr.Reset()
	err = runOpenCommandWithBrowser(
		[]string{repo2, "--host", "127.0.0.1", "--port", strconv.Itoa(srv.Port()), "--user-data-dir", userDataDir, "--no-open"},
		&stdout,
		&stderr,
		func(u string) {
			openedChNoOpen <- u
		},
	)
	if err != nil {
		t.Fatalf("runOpenCommandWithBrowser --no-open failed: %v", err)
	}
	select {
	case u := <-openedChNoOpen:
		t.Fatalf("expected --no-open to suppress browser launch, got %q", u)
	default:
	}

	// 8. Stale primary alias instance file falls back to live candidate
	instanceDir, err := server.InstanceDir(userDataDir)
	if err != nil {
		t.Fatalf("InstanceDir: %v", err)
	}
	staleAliasPath := server.InstanceFilePath(instanceDir, "localhost", srv.Port())
	if err := os.WriteFile(
		staleAliasPath,
		[]byte(fmt.Sprintf(`{"pid":99999,"host":"localhost","port":%d,"sessionToken":"stale-token"}`, srv.Port())),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	fallbackRes, err := openFolderOnExistingServer(openOptions{
		Host:        "localhost",
		Port:        srv.Port(),
		FolderPath:  repo2,
		UserDataDir: userDataDir,
	})
	if err != nil {
		t.Fatalf("expected fallback from stale localhost instance file to live 127.0.0.1 candidate, got %v", err)
	}
	if !strings.Contains(fallbackRes.TabURL, srv.SessionToken()) {
		t.Fatalf("expected fallback TabURL to contain live session token, got %q", fallbackRes.TabURL)
	}

	// 9. Single stale instance token returns explicit authentication error
	_ = os.Remove(staleAliasPath)
	liveInstancePath := server.InstanceFilePath(instanceDir, "127.0.0.1", srv.Port())
	liveBytes, err := os.ReadFile(liveInstancePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.WriteFile(liveInstancePath, liveBytes, 0o600)
	})
	if err := os.WriteFile(
		liveInstancePath,
		[]byte(fmt.Sprintf(`{"pid":99999,"host":"127.0.0.1","port":%d,"sessionToken":"wrong-token"}`, srv.Port())),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	_, err = openFolderOnExistingServer(openOptions{
		Host:        "127.0.0.1",
		Port:        srv.Port(),
		FolderPath:  repo2,
		UserDataDir: userDataDir,
	})
	if err == nil || !errors.Is(err, errCandidateAuth) || !strings.Contains(err.Error(), "HTTP 401") {
		t.Fatalf("expected authentication failed error for stale token, got %v", err)
	}

	// 10. runOpenCommandWithBrowser reports friendly error when no server is listening
	closedLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	unusedPort := closedLn.Addr().(*net.TCPAddr).Port
	_ = closedLn.Close()
	stdout.Reset()
	stderr.Reset()
	err = runOpenCommandWithBrowser(
		[]string{repo2, "--host", "127.0.0.1", "--port", strconv.Itoa(unusedPort), "--no-open"},
		&stdout,
		&stderr,
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "no running JJ View server found") {
		t.Fatalf("expected 'no running JJ View server found' error, got %v", err)
	}
}
