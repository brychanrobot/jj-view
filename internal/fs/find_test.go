// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package fs

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestFindFiles_Basic(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "findfiles-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create test directory tree
	paths := []string{
		filepath.Join(tempDir, ".jj", "working_copy", "type"),
		filepath.Join(tempDir, "sub1", ".jj", "working_copy", "type"),
		filepath.Join(tempDir, "nested", "sub2", ".jj", "working_copy", "type"),
		filepath.Join(tempDir, "node_modules", "pkg", ".jj", "working_copy", "type"),
		filepath.Join(tempDir, "src", "main.go"),
		filepath.Join(tempDir, "README.md"),
	}

	for _, p := range paths {
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatalf("failed to create dir for %s: %v", p, err)
		}
		if err := os.WriteFile(p, []byte("test"), 0644); err != nil {
			t.Fatalf("failed to write file %s: %v", p, err)
		}
	}

	sm, err := NewSandboxManager(tempDir)
	if err != nil {
		t.Fatalf("failed to create sandbox manager: %v", err)
	}

	t.Run("Recursive pattern **/.jj/working_copy/type", func(t *testing.T) {
		res, err := sm.FindFiles(FindFilesOptions{
			BaseDir:  tempDir,
			Pattern:  "**/.jj/working_copy/type",
			Excludes: []string{"node_modules"},
		})
		if err != nil {
			t.Fatalf("FindFiles failed: %v", err)
		}

		sort.Strings(res)

		expected := []string{
			filepath.Join(tempDir, ".jj", "working_copy", "type"),
			filepath.Join(tempDir, "nested", "sub2", ".jj", "working_copy", "type"),
			filepath.Join(tempDir, "sub1", ".jj", "working_copy", "type"),
		}
		sort.Strings(expected)

		if len(res) != len(expected) {
			t.Fatalf("expected %d results, got %d: %v", len(expected), len(res), res)
		}
		for i := range expected {
			if res[i] != expected[i] {
				t.Errorf("at index %d: expected %s, got %s", i, expected[i], res[i])
			}
		}
	})

	t.Run("Immediate subfolder pattern */.jj/working_copy/type", func(t *testing.T) {
		res, err := sm.FindFiles(FindFilesOptions{
			BaseDir: tempDir,
			Pattern: "*/.jj/working_copy/type",
		})
		if err != nil {
			t.Fatalf("FindFiles failed: %v", err)
		}

		expected := []string{
			filepath.Join(tempDir, "sub1", ".jj", "working_copy", "type"),
		}

		if len(res) != len(expected) {
			t.Fatalf("expected %d results, got %d: %v", len(expected), len(res), res)
		}
		if res[0] != expected[0] {
			t.Errorf("expected %s, got %s", expected[0], res[0])
		}
	})

	t.Run("MaxResults enforcement", func(t *testing.T) {
		res, err := sm.FindFiles(FindFilesOptions{
			BaseDir:    tempDir,
			Pattern:    "**/.jj/working_copy/type",
			MaxResults: 2,
		})
		if err != nil {
			t.Fatalf("FindFiles failed: %v", err)
		}

		if len(res) != 2 {
			t.Fatalf("expected exactly 2 results, got %d", len(res))
		}
	})

	t.Run("Custom excludes", func(t *testing.T) {
		res, err := sm.FindFiles(FindFilesOptions{
			BaseDir:  tempDir,
			Pattern:  "**/.jj/working_copy/type",
			Excludes: []string{"nested"},
		})
		if err != nil {
			t.Fatalf("FindFiles failed: %v", err)
		}

		for _, r := range res {
			if filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(r)))) == "sub2" {
				t.Errorf("nested subproject should have been excluded, but found: %s", r)
			}
		}
	})

	t.Run("Empty pattern error", func(t *testing.T) {
		_, err := sm.FindFiles(FindFilesOptions{
			BaseDir: tempDir,
			Pattern: "",
		})
		if err == nil {
			t.Fatal("expected error for empty pattern, got nil")
		}
	})

	t.Run("Outside sandbox rejection", func(t *testing.T) {
		outsideDir, err := os.MkdirTemp("", "outside-sandbox-*")
		if err != nil {
			t.Fatalf("failed to create outside dir: %v", err)
		}
		defer os.RemoveAll(outsideDir)

		_, err = sm.FindFiles(FindFilesOptions{
			BaseDir: outsideDir,
			Pattern: "*",
		})
		if err == nil {
			t.Fatal("expected error for directory outside sandbox, got nil")
		}
	})
}
