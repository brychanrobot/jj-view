// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestInstanceDirAndFilePath(t *testing.T) {
	userDataDir := filepath.Join(t.TempDir(), "userdata")
	dir, err := InstanceDir(userDataDir)
	if err != nil {
		t.Fatalf("InstanceDir failed: %v", err)
	}
	wantDir := filepath.Join(userDataDir, "servers")
	if dir != wantDir {
		t.Fatalf("InstanceDir = %q, want %q", dir, wantDir)
	}

	p1 := InstanceFilePath(dir, "127.0.0.1", 8080)
	if filepath.Base(p1) != "127.0.0.1-8080.json" {
		t.Fatalf("unexpected instance filename: %s", p1)
	}

	p2 := InstanceFilePath(dir, "::1", 9090)
	if filepath.Base(p2) != "__1-9090.json" {
		t.Fatalf("unexpected ipv6 instance filename: %s", p2)
	}
}

func TestServerInstanceFileLifecycleAndFindInstance(t *testing.T) {
	tempDir := t.TempDir()
	userDataDir := filepath.Join(tempDir, "userdata")
	repoDir := filepath.Join(tempDir, "repo")
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatal(err)
	}

	srv, err := NewServer(Config{
		Host:        "127.0.0.1",
		Port:        0,
		RepoRoot:    repoDir,
		UserDataDir: userDataDir,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}

	if err := srv.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}

	port := srv.Port()
	info, path, err := FindInstance(userDataDir, "localhost", port)
	if err != nil {
		t.Fatalf("FindInstance via localhost alias failed: %v", err)
	}
	if info.PID != os.Getpid() || info.Port != port || info.SessionToken != srv.SessionToken() {
		t.Fatalf("unexpected InstanceInfo: %+v", info)
	}
	if runtime.GOOS != "windows" {
		dirSt, err := os.Stat(filepath.Dir(path))
		if err != nil {
			t.Fatalf("stat instance dir: %v", err)
		}
		if dirMode := dirSt.Mode().Perm(); dirMode != 0o700 {
			t.Fatalf("instance dir mode = %o, want 0700", dirMode)
		}
		st, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat instance file: %v", err)
		}
		if mode := st.Mode().Perm(); mode != 0o600 {
			t.Fatalf("instance file mode = %o, want 0600", mode)
		}
	}

	// Verify removing only removes if PID & token match
	otherPath := InstanceFilePath(filepath.Dir(path), "127.0.0.1", port+1)
	otherData, _ := json.Marshal(InstanceInfo{
		PID:          os.Getpid() + 99999,
		Host:         "127.0.0.1",
		Port:         port + 1,
		SessionToken: "other-token",
	})
	if err := os.WriteFile(otherPath, otherData, 0o600); err != nil {
		t.Fatal(err)
	}
	srv.removeInstanceFile(otherPath)
	if _, err := os.Stat(otherPath); err != nil {
		t.Fatalf("expected non-matching instance file to be preserved, got: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := srv.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, _, err := FindInstance(userDataDir, "127.0.0.1", port); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected os.ErrNotExist after Close, got %v", err)
	}

	// Verify sidecar servers do not write instance files
	sidecarDataDir := filepath.Join(tempDir, "sidecar-userdata")
	sidecarSrv, err := NewServer(Config{
		Host:         "127.0.0.1",
		Port:         0,
		RepoRoot:     repoDir,
		SidecarToken: "sidecar-token",
		CSRFToken:    "csrf-token",
		UserDataDir:  sidecarDataDir,
	})
	if err != nil {
		t.Fatalf("NewServer sidecar: %v", err)
	}
	if err := sidecarSrv.Listen(); err != nil {
		t.Fatalf("sidecar Listen: %v", err)
	}
	t.Cleanup(func() { _ = sidecarSrv.Close(context.Background()) })
	if _, _, err := FindInstance(sidecarDataDir, "127.0.0.1", sidecarSrv.Port()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected no instance file for sidecar server, got %v", err)
	}
}
