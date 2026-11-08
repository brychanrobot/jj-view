// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestRunUpdateCommandCheckAndApplyAndPluginRefresh(t *testing.T) {
	const assetName = "jj-view-linux-amd64"
	t.Setenv("JJ_VIEW_RELEASE_ASSET", assetName)

	newBinaryContent := []byte("#!/bin/sh\necho jj-view-3.2.0\n")
	sum := sha256.Sum256(newBinaryContent)
	checksumHex := hex.EncodeToString(sum[:])

	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/releases":
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `[
				{
					"tag_name": "v3.3.0-rc.1",
					"prerelease": true,
					"html_url": "https://github.com/brychanrobot/jj-view/releases/tag/v3.3.0-rc.1",
					"assets": [
						{"name": %q, "browser_download_url": %q, "size": %d},
						{"name": "checksums.txt", "browser_download_url": %q, "size": 90}
					]
				},
				{
					"tag_name": "v3.2.0",
					"prerelease": false,
					"html_url": "https://github.com/brychanrobot/jj-view/releases/tag/v3.2.0",
					"assets": [
						{"name": %q, "browser_download_url": %q, "size": %d},
						{"name": "checksums.txt", "browser_download_url": %q, "size": 90}
					]
				}
			]`,
				assetName, srvURL+"/download/"+assetName, len(newBinaryContent), srvURL+"/download/checksums.txt",
				assetName, srvURL+"/download/"+assetName, len(newBinaryContent), srvURL+"/download/checksums.txt",
			)
		case "/download/checksums.txt":
			_, _ = fmt.Fprintf(w, "%s  %s\n", checksumHex, assetName)
		case "/download/" + assetName:
			_, _ = w.Write(newBinaryContent)
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
	homeDir := filepath.Join(tempDir, "home")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("SHELL", "/bin/sh")

	// Pre-populate Antigravity plugin.json so maybeRefreshAntigravityPlugin runs
	pluginDir := filepath.Join(homeDir, ".gemini", "config", "plugins", "jj-view")
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "plugin.json"), []byte(`{"name":"jj-view"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	binPath := filepath.Join(tempDir, "jj-view")
	if err := os.WriteFile(binPath, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	// 1. --check reports stable v3.2.0 without modifying binary
	var stdout, stderr bytes.Buffer
	err = runUpdateCommand([]string{"--check", "--update-url", srv.URL + "/releases", "--binary-path", binPath}, &stdout, &stderr)
	if err != nil {
		t.Fatalf("runUpdateCommand --check failed: %v (stderr: %s)", err, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Update available: v3.0.0 -> v3.2.0") {
		t.Fatalf("unexpected --check output: %s", stdout.String())
	}
	diskBytes, _ := os.ReadFile(binPath)
	if string(diskBytes) != "old-binary" {
		t.Fatalf("--check should not modify binary on disk")
	}

	// 2. --check --prerelease reports v3.3.0-rc.1
	stdout.Reset()
	stderr.Reset()
	err = runUpdateCommand([]string{"--check", "--prerelease", "--update-url", srv.URL + "/releases", "--binary-path", binPath}, &stdout, &stderr)
	if err != nil {
		t.Fatalf("runUpdateCommand --check --prerelease failed: %v", err)
	}
	if !strings.Contains(stdout.String(), "Update available: v3.0.0 -> v3.3.0-rc.1") {
		t.Fatalf("unexpected --check --prerelease output: %s", stdout.String())
	}

	// 3. Apply update replaces binary on disk and refreshes sidecar.json
	stdout.Reset()
	stderr.Reset()
	err = runUpdateCommand([]string{"--update-url", srv.URL + "/releases", "--binary-path", binPath}, &stdout, &stderr)
	if err != nil {
		t.Fatalf("runUpdateCommand apply failed: %v (stderr: %s)", err, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Successfully updated") {
		t.Fatalf("expected success output, got: %s", stdout.String())
	}

	updatedBytes, err := os.ReadFile(binPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(updatedBytes) != string(newBinaryContent) {
		t.Fatalf("binary content = %q, want %q", string(updatedBytes), string(newBinaryContent))
	}

	sidecarPath := filepath.Join(pluginDir, "sidecars", "jj-view", "sidecar.json")
	sidecarBytes, err := os.ReadFile(sidecarPath)
	if err != nil {
		t.Fatalf("expected sidecar.json to be refreshed by maybeRefreshAntigravityPlugin: %v", err)
	}
	var sidecarManifest map[string]any
	if err := json.Unmarshal(sidecarBytes, &sidecarManifest); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(fmt.Sprint(sidecarManifest["args"]), binPath) && sidecarManifest["command"] != binPath {
		t.Fatalf("expected sidecar.json to reference %s, got %+v", binPath, sidecarManifest)
	}
}

func TestRunUpdateCommandFailsWithoutReleaseAsset(t *testing.T) {
	t.Setenv("JJ_VIEW_RELEASE_ASSET", "")
	origAsset := releaseAsset
	releaseAsset = ""
	defer func() { releaseAsset = origAsset }()

	var stdout, stderr bytes.Buffer
	err := runUpdateCommand([]string{"--check"}, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "self-update is not available") {
		t.Fatalf("expected self-update unavailable error, got %v", err)
	}
}

func TestFindRunningDaemonsMatchesSymlinkedPaths(t *testing.T) {
	tempDir := t.TempDir()
	realBin := filepath.Join(tempDir, "real-jj-view")
	linkBin := filepath.Join(tempDir, "symlink-jj-view")
	if err := os.WriteFile(realBin, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realBin, linkBin); err != nil {
		t.Fatal(err)
	}

	procs := []runningProcess{
		{pid: 42, args: []string{linkBin, "--host", "127.0.0.1"}},
		{pid: 43, args: []string{realBin, "--host", "127.0.0.1"}},
	}

	got := findRunningDaemons(realBin, procs, 99)
	want := []int{42, 43}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("findRunningDaemons with symlinks = %v, want %v", got, want)
	}
}

func TestGeneratedVersionMatchesPackageJSON(t *testing.T) {
	pkgBytes, err := os.ReadFile(filepath.Join("..", "..", "package.json"))
	if err != nil {
		t.Fatalf("failed to read package.json: %v", err)
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(pkgBytes, &pkg); err != nil {
		t.Fatalf("failed to parse package.json: %v", err)
	}
	if pkg.Version == "" {
		t.Fatal("package.json version is empty")
	}
	if version != pkg.Version {
		t.Fatalf("generated version = %q, want package.json version %q (run `node tooling/generate-version.ts`)", version, pkg.Version)
	}
}

