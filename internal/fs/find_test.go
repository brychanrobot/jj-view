// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package fs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
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

	t.Run("Built-in excludes skip node_modules and .jj/repo automatically", func(t *testing.T) {
		repoInternalFile := filepath.Join(tempDir, ".jj", "repo", "nested", ".jj", "working_copy", "type")
		if err := os.MkdirAll(filepath.Dir(repoInternalFile), 0755); err != nil {
			t.Fatalf("failed to create .jj/repo dir: %v", err)
		}
		if err := os.WriteFile(repoInternalFile, []byte("test"), 0644); err != nil {
			t.Fatalf("failed to write file inside .jj/repo: %v", err)
		}

		res, err := sm.FindFiles(FindFilesOptions{
			BaseDir: tempDir,
			Pattern: "**/.jj/working_copy/type",
		})
		if err != nil {
			t.Fatalf("FindFiles failed: %v", err)
		}

		for _, r := range res {
			if r == repoInternalFile {
				t.Errorf("expected .jj/repo internals to be skipped, but found: %s", r)
			}
			if r == filepath.Join(tempDir, "node_modules", "pkg", ".jj", "working_copy", "type") {
				t.Errorf("expected node_modules to be skipped by default, but found: %s", r)
			}
		}
	})

	t.Run("MaxDirs stops walk gracefully without error", func(t *testing.T) {
		res, err := sm.FindFiles(FindFilesOptions{
			BaseDir: tempDir,
			Pattern: "**/.jj/working_copy/type",
			MaxDirs: 1,
		})
		if err != nil {
			t.Fatalf("expected nil error when MaxDirs is reached, got: %v", err)
		}
		if len(res) != 0 {
			t.Fatalf("expected 0 results when MaxDirs=1 stops before depth-2 .jj/working_copy/type, got %d: %v", len(res), res)
		}
	})

	t.Run("Absolute path excludes and /** glob excludes prune directories", func(t *testing.T) {
		res, err := sm.FindFiles(FindFilesOptions{
			BaseDir: tempDir,
			Pattern: "**/.jj/working_copy/type",
			Excludes: []string{
				filepath.Join(tempDir, "sub1"),
				"**/sub2/**",
			},
		})
		if err != nil {
			t.Fatalf("FindFiles failed: %v", err)
		}
		expected := []string{
			filepath.Join(tempDir, ".jj", "working_copy", "type"),
		}
		if len(res) != len(expected) || res[0] != expected[0] {
			t.Fatalf("expected only root .jj/working_copy/type %v, got %v", expected, res)
		}
	})

	t.Run("Context cancellation returns context error", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := sm.FindFiles(FindFilesOptions{
			Context: ctx,
			BaseDir: tempDir,
			Pattern: "**/.jj/working_copy/type",
		})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context.Canceled, got: %v", err)
		}
	})
}

func TestFindFiles_CitcPruning(t *testing.T) {
	rawParentDir := t.TempDir()
	parentDir, err := filepath.EvalSymlinks(rawParentDir)
	if err != nil {
		t.Fatalf("EvalSymlinks(%s) failed: %v", rawParentDir, err)
	}

	citcWs := filepath.Join(parentDir, "citc-ws")
	citcChild := filepath.Join(citcWs, "subproject")
	citcRepoType := filepath.Join(citcWs, ".jj", "working_copy", "type")
	citcNestedType := filepath.Join(citcChild, "nested", ".jj", "working_copy", "type")
	citcCacheType := filepath.Join(citcWs, ".citc", "internal", ".jj", "working_copy", "type")
	citcGoFile := filepath.Join(citcChild, "main.go")
	citcJjIgnore := filepath.Join(citcChild, ".jjignore")
	citcJjTs := filepath.Join(citcChild, "types.jj.ts")
	normalSubrepoType := filepath.Join(parentDir, "normal-dir", "nested-subrepo", ".jj", "working_copy", "type")

	for _, f := range []string{
		citcRepoType,
		citcNestedType,
		citcCacheType,
		citcGoFile,
		citcJjIgnore,
		citcJjTs,
		normalSubrepoType,
	} {
		if err := os.MkdirAll(filepath.Dir(f), 0755); err != nil {
			t.Fatalf("failed to create dir for %s: %v", f, err)
		}
		if err := os.WriteFile(f, []byte("test"), 0644); err != nil {
			t.Fatalf("failed to write file %s: %v", f, err)
		}
	}

	sm, err := NewSandboxManager(parentDir)
	if err != nil {
		t.Fatalf("failed to create sandbox manager: %v", err)
	}

	t.Run("Parent dir finds .citc root and non-.citc subrepo while pruning .citc children and .citc", func(t *testing.T) {
		res, err := sm.FindFiles(FindFilesOptions{
			BaseDir: parentDir,
			Pattern: "**/.jj/working_copy/type",
		})
		if err != nil {
			t.Fatalf("FindFiles failed: %v", err)
		}
		sort.Strings(res)
		expected := []string{citcRepoType, normalSubrepoType}
		sort.Strings(expected)
		if len(res) != len(expected) {
			t.Fatalf("expected %v, got %v", expected, res)
		}
		for i := range expected {
			if res[i] != expected[i] {
				t.Errorf("at index %d: expected %s, got %s", i, expected[i], res[i])
			}
		}
	})

	t.Run(".citc workspace root finds its own .jj while pruning subproject child and .citc", func(t *testing.T) {
		res, err := sm.FindFiles(FindFilesOptions{
			BaseDir: citcWs,
			Pattern: "**/.jj/working_copy/type",
		})
		if err != nil {
			t.Fatalf("FindFiles failed: %v", err)
		}
		if len(res) != 1 || res[0] != citcRepoType {
			t.Fatalf("expected [%s], got %v", citcRepoType, res)
		}
	})

	t.Run("Child inside .citc workspace returns empty immediately for .jj discovery", func(t *testing.T) {
		res, err := sm.FindFiles(FindFilesOptions{
			BaseDir: citcChild,
			Pattern: "**/.jj/working_copy/type",
		})
		if err != nil {
			t.Fatalf("FindFiles failed: %v", err)
		}
		if len(res) != 0 {
			t.Fatalf("expected empty results for .citc child BaseDir, got %v", res)
		}
	})

	t.Run("Non-.jj searches inside .citc child directory still find regular files", func(t *testing.T) {
		for _, tc := range []struct {
			pattern string
			want    string
		}{
			{pattern: "**/*.go", want: citcGoFile},
			{pattern: "**/.jjignore", want: citcJjIgnore},
			{pattern: "**/*.jj.ts", want: citcJjTs},
		} {
			res, err := sm.FindFiles(FindFilesOptions{
				BaseDir: citcChild,
				Pattern: tc.pattern,
			})
			if err != nil {
				t.Fatalf("FindFiles(%q) failed: %v", tc.pattern, err)
			}
			if len(res) != 1 || res[0] != tc.want {
				t.Fatalf("FindFiles(%q): expected [%s], got %v", tc.pattern, tc.want, res)
			}
		}

		braceRes, err := sm.FindFiles(FindFilesOptions{
			BaseDir: citcChild,
			Pattern: "{**/.jj/working_copy/type,**/*.go}",
		})
		if err != nil {
			t.Fatalf("FindFiles(brace pattern) failed: %v", err)
		}
		sort.Strings(braceRes)
		expectedBrace := []string{citcNestedType, citcGoFile}
		sort.Strings(expectedBrace)
		if len(braceRes) != len(expectedBrace) || braceRes[0] != expectedBrace[0] || braceRes[1] != expectedBrace[1] {
			t.Fatalf("FindFiles(brace pattern): expected %v, got %v", expectedBrace, braceRes)
		}
	})

	t.Run("patternTargetsJjDir only matches .jj directory segments", func(t *testing.T) {
		cases := []struct {
			pattern string
			want    bool
		}{
			{".jj", true},
			{".jj/**", true},
			{"**/.jj/working_copy/type", true},
			{"*/.jj/working_copy/type", true},
			{"*/.jj", true},
			{"**/.jjignore", false},
			{"**/*.jj.ts", false},
			{"**/.jj-config/settings.toml", false},
			{"**/*.go", false},
			{"", false},
		}
		for _, tc := range cases {
			if got := patternTargetsJjDir(tc.pattern); got != tc.want {
				t.Errorf("patternTargetsJjDir(%q) = %v, want %v", tc.pattern, got, tc.want)
			}
		}
	})

	t.Run("Symlink .citc pointing to external directory is not treated as .citc root", func(t *testing.T) {
		rawExternalDir := t.TempDir()
		externalDir, err := filepath.EvalSymlinks(rawExternalDir)
		if err != nil {
			t.Fatalf("EvalSymlinks(%s) failed: %v", rawExternalDir, err)
		}

		rawWsDir := t.TempDir()
		symlinkWs, err := filepath.EvalSymlinks(rawWsDir)
		if err != nil {
			t.Fatalf("EvalSymlinks(%s) failed: %v", rawWsDir, err)
		}

		wsType := filepath.Join(symlinkWs, ".jj", "working_copy", "type")
		nestedType := filepath.Join(symlinkWs, "nested-subrepo", ".jj", "working_copy", "type")
		for _, f := range []string{wsType, nestedType} {
			if err := os.MkdirAll(filepath.Dir(f), 0755); err != nil {
				t.Fatalf("failed to create dir for %s: %v", f, err)
			}
			if err := os.WriteFile(f, []byte("test"), 0644); err != nil {
				t.Fatalf("failed to write file %s: %v", f, err)
			}
		}

		citcLink := filepath.Join(symlinkWs, ".citc")
		if err := os.Symlink(externalDir, citcLink); err != nil {
			if runtime.GOOS == "windows" && (errors.Is(err, os.ErrPermission) || strings.Contains(strings.ToLower(err.Error()), "privilege")) {
				t.Skipf("skipping symlink test on Windows without symlink privilege: %v", err)
			}
			t.Fatalf("os.Symlink(%s, %s) failed: %v", externalDir, citcLink, err)
		}

		if hasCitcDir(symlinkWs) {
			t.Fatalf("expected hasCitcDir(%s) to return false for .citc symlink", symlinkWs)
		}

		localSm, err := NewSandboxManager(symlinkWs)
		if err != nil {
			t.Fatalf("NewSandboxManager failed: %v", err)
		}

		res, err := localSm.FindFiles(FindFilesOptions{
			BaseDir: symlinkWs,
			Pattern: "**/.jj/working_copy/type",
		})
		if err != nil {
			t.Fatalf("FindFiles failed: %v", err)
		}
		sort.Strings(res)
		expected := []string{wsType, nestedType}
		sort.Strings(expected)
		if len(res) != len(expected) || res[0] != expected[0] || res[1] != expected[1] {
			t.Fatalf("expected .citc symlink not to prune nested subrepos (%v), got %v", expected, res)
		}
	})

	t.Run("POSIX preserves literal backslashes in filenames and excludes", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("POSIX literal backslash test")
		}
		posixDir := t.TempDir()
		keptRoot := filepath.Join(posixDir, "foo\\bar.txt")
		keptNested := filepath.Join(posixDir, "sub", "a\\b.txt")
		excludedBackslash := filepath.Join(posixDir, "ignored\\dir", "secret.txt")
		keptSlash := filepath.Join(posixDir, "ignored", "dir", "keep.txt")
		for _, f := range []string{keptRoot, keptNested, excludedBackslash, keptSlash} {
			if err := os.MkdirAll(filepath.Dir(f), 0755); err != nil {
				t.Fatalf("mkdir failed: %v", err)
			}
			if err := os.WriteFile(f, []byte("ok"), 0644); err != nil {
				t.Fatalf("write failed: %v", err)
			}
		}

		localSm, err := NewSandboxManager(posixDir)
		if err != nil {
			t.Fatalf("NewSandboxManager failed: %v", err)
		}
		res, err := localSm.FindFiles(FindFilesOptions{
			BaseDir:  posixDir,
			Pattern:  "**/*",
			Excludes: []string{"ignored\\dir"},
		})
		if err != nil {
			t.Fatalf("FindFiles failed: %v", err)
		}
		found := make(map[string]bool, len(res))
		for _, r := range res {
			found[r] = true
		}
		if !found[keptRoot] || !found[keptNested] || !found[keptSlash] {
			t.Fatalf("expected keptRoot, keptNested, keptSlash in results, got %v", res)
		}
		if found[excludedBackslash] {
			t.Fatalf("expected %s to be excluded without mangling %s", excludedBackslash, keptSlash)
		}
	})
}
