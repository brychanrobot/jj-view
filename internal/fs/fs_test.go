// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package fs

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSandboxIsolation(t *testing.T) {
	tempRepo, err := os.MkdirTemp("", "jj-view-fs-test")
	if err != nil {
		t.Fatalf("failed to create temp repo: %v", err)
	}
	defer os.RemoveAll(tempRepo)

	sm, err := NewSandboxManager(tempRepo)
	if err != nil {
		t.Fatalf("failed to create sandbox manager: %v", err)
	}

	// Paths inside repo are allowed
	validPath := filepath.Join(tempRepo, "test.txt")
	if _, err := sm.ValidatePath(validPath); err != nil {
		t.Fatalf("expected valid path inside repo, got: %v", err)
	}

	// Relative paths are resolved against repo root and allowed
	if _, err := sm.ValidatePath("sub/dir/test.txt"); err != nil {
		t.Fatalf("expected relative path to resolve inside repo, got: %v", err)
	}

	// Paths in sm.DaemonTempDir() are allowed
	validTemp := filepath.Join(sm.DaemonTempDir(), "some-temp-file.tmp")
	if _, err := sm.ValidatePath(validTemp); err != nil {
		t.Fatalf("expected path in sm.DaemonTempDir() to be allowed, got: %v", err)
	}

	// Arbitrary paths outside daemon temp dir in /tmp are rejected
	arbitraryTemp := filepath.Join(os.TempDir(), "arbitrary-other-user.tmp")
	if _, err := sm.ValidatePath(arbitraryTemp); err == nil {
		t.Fatalf("expected arbitrary path in /tmp outside daemon dir to be rejected, got nil")
	}

	// Arbitrary system paths outside sandbox are rejected
	forbiddenPath := "/etc/passwd"
	if runtime.GOOS == "windows" {
		if sysRoot := os.Getenv("SystemRoot"); sysRoot != "" {
			forbiddenPath = filepath.Join(sysRoot, "win.ini")
		} else {
			forbiddenPath = `C:\Windows\win.ini`
		}
	}
	if _, err := sm.ValidatePath(forbiddenPath); err == nil {
		t.Fatalf("expected forbidden path %s to be rejected, but it succeeded", forbiddenPath)
	}
	if runtime.GOOS == "windows" {
		if _, err := sm.ValidatePath("/etc/passwd"); err == nil {
			t.Fatalf("expected forbidden path /etc/passwd to be rejected, but it succeeded")
		}
	}

	// Path traversal with ../.. escaping sandbox is rejected
	traversalPath := filepath.Join(tempRepo, "../../../../../etc/passwd")
	if _, err := sm.ValidatePath(traversalPath); err == nil {
		t.Fatalf("expected traversal path %s to be rejected, but it succeeded", traversalPath)
	}
}

func TestFileOperations(t *testing.T) {
	tempRepo, err := os.MkdirTemp("", "jj-view-fs-ops-test")
	if err != nil {
		t.Fatalf("failed to create temp repo: %v", err)
	}
	defer os.RemoveAll(tempRepo)

	sm, err := NewSandboxManager(tempRepo)
	if err != nil {
		t.Fatalf("failed to create sandbox manager: %v", err)
	}

	testFile := filepath.Join(tempRepo, "hello.txt")
	testData := []byte("Hello, JJ View!")

	// 1. WriteFile
	if err := sm.WriteFile(testFile, testData); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	// 2. Exists
	if !sm.Exists(testFile) {
		t.Fatalf("Exists returned false for written file")
	}

	// 3. ReadFile
	readData, err := sm.ReadFile(testFile)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	if string(readData) != string(testData) {
		t.Fatalf("ReadFile content mismatch: expected %q, got %q", string(testData), string(readData))
	}

	// 4. Stat
	st, err := sm.Stat(testFile)
	if err != nil {
		t.Fatalf("Stat failed: %v", err)
	}
	if !st.IsFile || st.IsDirectory {
		t.Fatalf("Stat unexpected file attributes: %+v", st)
	}
	if st.Size != int64(len(testData)) {
		t.Fatalf("Stat size mismatch: expected %d, got %d", len(testData), st.Size)
	}

	// 5. Mkdir & Readdir
	subDir := filepath.Join(tempRepo, "nested", "dir")
	if err := sm.Mkdir(subDir, true); err != nil {
		t.Fatalf("Mkdir failed: %v", err)
	}
	names, err := sm.Readdir(tempRepo)
	if err != nil {
		t.Fatalf("Readdir failed: %v", err)
	}
	if len(names) < 2 {
		t.Fatalf("expected at least 2 entries in readdir, got: %v", names)
	}

	// 6. Mkdtemp
	tmpSubDir, err := sm.Mkdtemp("test-prefix-")
	if err != nil {
		t.Fatalf("Mkdtemp failed: %v", err)
	}
	defer os.RemoveAll(tmpSubDir)
	if !sm.Exists(tmpSubDir) {
		t.Fatalf("created tmp dir does not exist")
	}

	// 7. Rm
	if err := sm.Rm(testFile, false, false); err != nil {
		t.Fatalf("Rm failed: %v", err)
	}
	if sm.Exists(testFile) {
		t.Fatalf("file still exists after Rm")
	}

	// Rm repository root must be forbidden
	if err := sm.Rm(tempRepo, true, false); err == nil {
		t.Fatal("expected error when trying to remove repoRoot, got nil")
	}
}
