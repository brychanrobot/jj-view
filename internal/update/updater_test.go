// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCompareSemver(t *testing.T) {
	tests := []struct {
		v1      string
		v2      string
		want    int
		wantErr bool
	}{
		{"3.0.0", "3.0.0", 0, false},
		{"v3.0.0", "3.0.0", 0, false},
		{"3.0.0+build123", "3.0.0+build456", 0, false},
		{"3.0.1", "3.0.0", 1, false},
		{"3.0.0", "3.0.1", -1, false},
		{"3.1.0", "3.0.9", 1, false},
		{"4.0.0", "3.9.9", 1, false},
		{"3.0.0", "3.0.0-alpha.1", 1, false},
		{"3.0.0-alpha.1", "3.0.0", -1, false},
		{"3.0.0-alpha.2", "3.0.0-alpha.1", 1, false},
		{"3.0.0-alpha.10", "3.0.0-alpha.2", 1, false},
		{"3.0.0-beta.1", "3.0.0-alpha.9", 1, false},
		{"3.0.0-1", "3.0.0-alpha", -1, false},
		{"3.0.0-alpha.1", "3.0.0-alpha", 1, false},
		{"", "3.0.0", 0, true},
		{"3.0", "3.0.0", 0, true},
		{"3.0.0-", "3.0.0", 0, true},
		{"3.0.0-alpha..1", "3.0.0", 0, true},
		{"invalid", "3.0.0", 0, true},
	}

	for _, tc := range tests {
		got, err := CompareSemver(tc.v1, tc.v2)
		if (err != nil) != tc.wantErr {
			t.Errorf("CompareSemver(%q, %q) error = %v, wantErr %v", tc.v1, tc.v2, err, tc.wantErr)
			continue
		}
		if got != tc.want {
			t.Errorf("CompareSemver(%q, %q) = %d, want %d", tc.v1, tc.v2, got, tc.want)
		}
	}
}

func TestValidateUpdateURL(t *testing.T) {
	tests := []struct {
		url     string
		wantErr bool
	}{
		{"https://api.github.com/repos/brychanrobot/jj-view/releases", false},
		{"https://github.com/brychanrobot/jj-view/releases/download/v3.1.0/jj-view-linux-amd64", false},
		{"http://127.0.0.1:8080/releases", false},
		{"http://localhost:8080/releases", false},
		{"http://[::1]:8080/releases", false},
		{"http://example.com/releases", true},
		{"http://0.0.0.0:8080/releases", true},
		{"https://0.0.0.0:8443/releases", true},
		{"http://[::]:8080/releases", true},
		{"http://169.254.169.254/latest/meta-data", true},
		{"https://169.254.169.254/latest/meta-data", true},
		{"https://user:pass@api.github.com/releases", true},
		{"ftp://api.github.com/releases", true},
		{"", true},
	}

	for _, tc := range tests {
		err := ValidateUpdateURL(tc.url)
		if (err != nil) != tc.wantErr {
			t.Errorf("ValidateUpdateURL(%q) error = %v, wantErr %v", tc.url, err, tc.wantErr)
		}
	}
}

func TestCheckRedirectRejectsInsecureTargetAndStripsAuthOnCrossHost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://example.com/evil-binary", http.StatusFound)
	}))
	defer srv.Close()

	execPath := filepath.Join(t.TempDir(), "jj-view")
	if err := os.WriteFile(execPath, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}

	u := NewUpdater(Options{
		CurrentVersion: "3.0.0",
		ReleaseAsset:   "jj-view-linux-amd64",
		ExecutablePath: execPath,
		ReleasesURL:    srv.URL + "/releases",
	})

	_, err := u.Check(context.Background(), CheckOptions{Force: true})
	if err == nil || !strings.Contains(err.Error(), "redirect target rejected") {
		t.Fatalf("expected redirect target rejected error, got %v", err)
	}
}

func TestCanSelfUpdateDisabledWhenReleaseAssetEmpty(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	u := NewUpdater(Options{
		CurrentVersion: "3.0.0",
		ReleaseAsset:   "",
		ExecutablePath: "/usr/local/bin/jj-view",
		ReleasesURL:    srv.URL,
	})
	if u.CanSelfUpdate() {
		t.Fatal("expected CanSelfUpdate() to be false when ReleaseAsset is empty")
	}

	info, err := u.Check(context.Background(), CheckOptions{Force: true})
	if err != nil {
		t.Fatalf("Check returned error: %v", err)
	}
	if info.CanSelfUpdate || info.UpdateAvailable {
		t.Fatalf("unexpected UpdateInfo: %+v", info)
	}
	if hits.Load() != 0 {
		t.Fatalf("expected 0 HTTP requests when CanSelfUpdate is false, got %d", hits.Load())
	}
}

func TestCheckCachingForceAndPrereleaseFiltering(t *testing.T) {
	const assetName = "jj-view-linux-amd64"
	var hits atomic.Int32
	var srvURL string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		releases := []githubRelease{
			{
				TagName:    "v3.3.0",
				Draft:      true,
				Prerelease: false,
				HTMLURL:    "https://github.com/brychanrobot/jj-view/releases/tag/v3.3.0",
				Assets: []githubAsset{
					{Name: assetName, BrowserDownloadURL: srvURL + "/v3.3.0/" + assetName, Size: 100},
					{Name: "checksums.txt", BrowserDownloadURL: srvURL + "/v3.3.0/checksums.txt", Size: 64},
				},
			},
			{
				TagName:     "v3.2.0-rc.1",
				Draft:       false,
				Prerelease:  true,
				HTMLURL:     "https://github.com/brychanrobot/jj-view/releases/tag/v3.2.0-rc.1",
				Body:        "RC notes",
				PublishedAt: "2026-11-08T12:00:00Z",
				Assets: []githubAsset{
					{Name: assetName, BrowserDownloadURL: srvURL + "/v3.2.0-rc.1/" + assetName, Size: 100},
					{Name: "checksums.txt", BrowserDownloadURL: srvURL + "/v3.2.0-rc.1/checksums.txt", Size: 64},
				},
			},
			{
				TagName:     "v3.1.0",
				Draft:       false,
				Prerelease:  false,
				HTMLURL:     "https://github.com/brychanrobot/jj-view/releases/tag/v3.1.0",
				Body:        "Stable notes",
				PublishedAt: "2026-11-07T12:00:00Z",
				Assets: []githubAsset{
					{Name: assetName, BrowserDownloadURL: srvURL + "/v3.1.0/" + assetName, Size: 100},
					{Name: "checksums.txt", BrowserDownloadURL: srvURL + "/v3.1.0/checksums.txt", Size: 64},
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(releases)
	}))
	defer srv.Close()
	srvURL = srv.URL

	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	var nowMu sync.Mutex
	u := NewUpdater(Options{
		CurrentVersion: "3.0.0",
		ReleaseAsset:   assetName,
		ExecutablePath: filepath.Join(t.TempDir(), "jj-view"),
		ReleasesURL:    srv.URL,
		CacheTTL:       15 * time.Minute,
		Now: func() time.Time {
			nowMu.Lock()
			defer nowMu.Unlock()
			return now
		},
	})

	// 1. Standard check skips draft (3.3.0) and prerelease (3.2.0-rc.1) -> selects 3.1.0
	info1, err := u.Check(context.Background(), CheckOptions{})
	if err != nil {
		t.Fatalf("Check failed: %v", err)
	}
	if !info1.UpdateAvailable || info1.LatestVersion != "3.1.0" || info1.Prerelease {
		t.Fatalf("unexpected info1: %+v", info1)
	}
	if hits.Load() != 1 {
		t.Fatalf("expected 1 hit, got %d", hits.Load())
	}

	// 2. Second standard check within TTL uses cache
	info2, err := u.Check(context.Background(), CheckOptions{})
	if err != nil {
		t.Fatalf("cached Check failed: %v", err)
	}
	if info2.LatestVersion != "3.1.0" || hits.Load() != 1 {
		t.Fatalf("expected cached response with 1 hit, got %d hits", hits.Load())
	}

	// 3. Force bypasses cache
	_, err = u.Check(context.Background(), CheckOptions{Force: true})
	if err != nil {
		t.Fatalf("forced Check failed: %v", err)
	}
	if hits.Load() != 2 {
		t.Fatalf("expected 2 hits after Force, got %d", hits.Load())
	}

	// 4. Prerelease check selects 3.2.0-rc.1
	preInfo, err := u.Check(context.Background(), CheckOptions{Prerelease: true})
	if err != nil {
		t.Fatalf("prerelease Check failed: %v", err)
	}
	if !preInfo.UpdateAvailable || preInfo.LatestVersion != "3.2.0-rc.1" || !preInfo.Prerelease {
		t.Fatalf("unexpected prerelease info: %+v", preInfo)
	}
	if hits.Load() != 3 {
		t.Fatalf("expected 3 hits, got %d", hits.Load())
	}

	// 5. Advance clock past TTL -> triggers network fetch
	nowMu.Lock()
	now = now.Add(16 * time.Minute)
	nowMu.Unlock()
	_, err = u.Check(context.Background(), CheckOptions{})
	if err != nil {
		t.Fatalf("post-TTL Check failed: %v", err)
	}
	if hits.Load() != 4 {
		t.Fatalf("expected 4 hits after TTL expiration, got %d", hits.Load())
	}
}

func TestApplyAtomicSwapSymlinkIdempotencyAndReloadCallback(t *testing.T) {
	const assetName = "jj-view-linux-amd64"
	newBinaryPayload := []byte("#!/bin/sh\necho jj-view-3.1.0\n")
	sum := sha256.Sum256(newBinaryPayload)
	expectedChecksum := hex.EncodeToString(sum[:])

	var downloadHits atomic.Int32
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/releases":
			releases := []githubRelease{
				{
					TagName: "v3.1.0",
					HTMLURL: "https://github.com/brychanrobot/jj-view/releases/tag/v3.1.0",
					Assets: []githubAsset{
						{
							Name:               assetName,
							BrowserDownloadURL: srvURL + "/download/" + assetName,
							Size:               int64(len(newBinaryPayload)),
						},
						{
							Name:               "checksums.txt",
							BrowserDownloadURL: srvURL + "/download/checksums.txt",
							Size:               int64(len(expectedChecksum) + len(assetName) + 3),
						},
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(releases)
		case "/download/checksums.txt":
			fmt.Fprintf(w, "%s  %s\n", expectedChecksum, assetName)
		case "/download/" + assetName:
			downloadHits.Add(1)
			_, _ = w.Write(newBinaryPayload)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	rawTempDir := t.TempDir()
	tempDir, err := filepath.EvalSymlinks(rawTempDir)
	if err != nil {
		tempDir = rawTempDir
	}
	realBinDir := filepath.Join(tempDir, "real")
	linkBinDir := filepath.Join(tempDir, "link")
	if err := os.MkdirAll(realBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(linkBinDir, 0o755); err != nil {
		t.Fatal(err)
	}

	realExecPath := filepath.Join(realBinDir, "jj-view")
	if err := os.WriteFile(realExecPath, []byte("old-binary-3.0.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	symlinkPath := filepath.Join(linkBinDir, "jj-view")
	if err := os.Symlink(realExecPath, symlinkPath); err != nil {
		t.Fatal(err)
	}

	reloadedCh := make(chan struct{}, 4)
	var reloadCount atomic.Int32
	u := NewUpdater(Options{
		CurrentVersion: "3.0.0",
		ReleaseAsset:   assetName,
		ExecutablePath: symlinkPath,
		ReleasesURL:    srv.URL + "/releases",
		OnReload: func() error {
			reloadCount.Add(1)
			reloadedCh <- struct{}{}
			return nil
		},
	})

	// Apply update with TriggerReload
	res1, err := u.Apply(context.Background(), ApplyOptions{TriggerReload: true})
	if err != nil {
		t.Fatalf("Apply failed: %v", err)
	}
	if res1.PreviousVersion != "3.0.0" || res1.UpdatedVersion != "3.1.0" || !res1.Restarting {
		t.Fatalf("unexpected ApplyResult: %+v", res1)
	}
	if res1.BinaryPath != realExecPath {
		t.Fatalf("expected symlink-resolved BinaryPath %q, got %q", realExecPath, res1.BinaryPath)
	}

	// Verify real file on disk was atomically updated and permissions preserved
	updatedBytes, err := os.ReadFile(realExecPath)
	if err != nil {
		t.Fatalf("failed to read updated binary: %v", err)
	}
	if string(updatedBytes) != string(newBinaryPayload) {
		t.Fatalf("updated binary content = %q, want %q", string(updatedBytes), string(newBinaryPayload))
	}
	st, err := os.Stat(realExecPath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm()&0o111 == 0 {
		t.Fatalf("expected executable mode on updated binary, got %v", st.Mode())
	}

	// Verify second Apply call (e.g. from second browser tab) is idempotent and does not re-download
	res2, err := u.Apply(context.Background(), ApplyOptions{TriggerReload: true})
	if err != nil {
		t.Fatalf("second Apply failed: %v", err)
	}
	if res2.UpdatedVersion != "3.1.0" || downloadHits.Load() != 1 {
		t.Fatalf("expected 1 download hit across idempotent Apply calls, got %d", downloadHits.Load())
	}

	// Verify Check after Apply reports UpdateAvailable: false with UpdatedVersion
	postInfo, err := u.Check(context.Background(), CheckOptions{Force: true})
	if err != nil {
		t.Fatalf("Check after Apply failed: %v", err)
	}
	if postInfo.UpdateAvailable || postInfo.CurrentVersion != "3.1.0" {
		t.Fatalf("expected UpdateAvailable=false and CurrentVersion=3.1.0 after Apply, got %+v", postInfo)
	}

	// Wait for OnReload callback and confirm it fires exactly once
	select {
	case <-reloadedCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for OnReload callback")
	}
	if reloadCount.Load() != 1 {
		t.Fatalf("expected OnReload to be called once, got %d", reloadCount.Load())
	}
}

func TestApplyRejectsCorruptChecksumAndCleansUpTempFile(t *testing.T) {
	const assetName = "jj-view-linux-amd64"
	corruptPayload := []byte("corrupted-binary-payload")
	wrongChecksum := strings.Repeat("a", 64)

	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/releases":
			releases := []githubRelease{
				{
					TagName: "v3.1.0",
					Assets: []githubAsset{
						{
							Name:               assetName,
							BrowserDownloadURL: srvURL + "/download/" + assetName,
							Size:               int64(len(corruptPayload)),
						},
						{
							Name:               "checksums.txt",
							BrowserDownloadURL: srvURL + "/download/checksums.txt",
							Size:               80,
						},
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(releases)
		case "/download/checksums.txt":
			fmt.Fprintf(w, "%s  %s\n", wrongChecksum, assetName)
		case "/download/" + assetName:
			_, _ = w.Write(corruptPayload)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	tempDir := t.TempDir()
	execPath := filepath.Join(tempDir, "jj-view")
	originalContent := []byte("original-binary-3.0.0")
	if err := os.WriteFile(execPath, originalContent, 0o755); err != nil {
		t.Fatal(err)
	}

	u := NewUpdater(Options{
		CurrentVersion: "3.0.0",
		ReleaseAsset:   assetName,
		ExecutablePath: execPath,
		ReleasesURL:    srv.URL + "/releases",
	})

	_, err := u.Apply(context.Background(), ApplyOptions{})
	if err == nil || !strings.Contains(err.Error(), "SHA-256 checksum mismatch") {
		t.Fatalf("expected SHA-256 checksum mismatch error, got %v", err)
	}

	// Original binary must be untouched
	gotBytes, err := os.ReadFile(execPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotBytes) != string(originalContent) {
		t.Fatalf("original binary was modified on failed update: got %q", string(gotBytes))
	}

	// Temp file must be cleaned up
	entries, err := os.ReadDir(tempDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".jj-view-update-") {
			t.Fatalf("leftover temporary update file was not removed: %s", entry.Name())
		}
	}
}

func TestCleanupStaleFiles(t *testing.T) {
	tempDir := t.TempDir()
	execPath := filepath.Join(tempDir, "jj-view")
	oldPath := execPath + ".old"
	staleTmp := filepath.Join(tempDir, ".jj-view-update-12345")

	for _, p := range []string{execPath, oldPath, staleTmp} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	CleanupStaleFiles(execPath)

	if _, err := os.Stat(execPath); err != nil {
		t.Fatalf("expected active executable to remain, got %v", err)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("expected .old file to be removed, got %v", err)
	}
	if _, err := os.Stat(staleTmp); !os.IsNotExist(err) {
		t.Fatalf("expected stale .jj-view-update-* file to be removed, got %v", err)
	}
}
