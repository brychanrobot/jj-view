// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package fs

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var chromiumSrcFlag = flag.String("chromium-src", "", "Path to a Chromium src checkout for fuzzy search benchmarking (or set CHROMIUM_SRC)")

func resolveChromiumSrc() string {
	if *chromiumSrcFlag != "" {
		return *chromiumSrcFlag
	}
	return os.Getenv("CHROMIUM_SRC")
}

func TestFuzzyFindFiles_RankingAndFeatures(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "fuzzy-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	files := []string{
		"README.md",
		"package.json",
		"src/main.ts",
		"src/core/jj-service.ts",
		"src/core/jj-repository-manager.ts",
		"src/core/change-detection-manager.ts",
		"web/src/App.svelte",
		"web/src/diff/PierreDiffViewer.svelte",
		"web/src/diff/PierreFileViewer.svelte",
		"web/src/quick-input/QuickInput.svelte",
		"web/src/quick-input/quick-input-service.ts",
		"chrome/browser/ui/views/frame/browser_view.cc",
		"chrome/browser/ui/views/frame/browser_view.h",
		"chrome/browser/ui/views/frame/browser_view_layout.cc",
		"chrome/browser/ui/views/frame/browser_view_unittest.cc",
		"chrome/browser/view_helpers.cc",
		"content/browser/web_contents/web_contents_impl.cc",
		"out_Default/gen/generated_view.cc",
		"node_modules/pkg/index.js",
	}

	for _, rel := range files {
		full := filepath.Join(tempDir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatalf("mkdir failed: %v", err)
		}
		if err := os.WriteFile(full, []byte("test"), 0644); err != nil {
			t.Fatalf("write failed: %v", err)
		}
	}

	sm, err := NewSandboxManager(tempDir)
	if err != nil {
		t.Fatalf("NewSandboxManager failed: %v", err)
	}

	t.Run("Exact filename ranks first", func(t *testing.T) {
		res, err := sm.FuzzyFindFiles(FuzzyFindOptions{
			BaseDir: tempDir,
			Query:   "browser_view.cc",
		})
		if err != nil {
			t.Fatalf("FuzzyFindFiles failed: %v", err)
		}
		if len(res) == 0 {
			t.Fatal("expected matches for browser_view.cc")
		}
		if res[0].RelPath != "chrome/browser/ui/views/frame/browser_view.cc" {
			t.Fatalf("expected top match to be chrome/browser/ui/views/frame/browser_view.cc, got %s (all: %+v)", res[0].RelPath, res)
		}
	})

	t.Run("Fuzzy snake_case word boundaries (bview.cc)", func(t *testing.T) {
		res, err := sm.FuzzyFindFiles(FuzzyFindOptions{
			BaseDir: tempDir,
			Query:   "bview.cc",
		})
		if err != nil {
			t.Fatalf("FuzzyFindFiles failed: %v", err)
		}
		if len(res) == 0 {
			t.Fatal("expected matches for bview.cc")
		}
		// browser_view.cc matches entirely inside basename (b + view.cc) and should beat chrome/browser/view_helpers.cc
		if res[0].RelPath != "chrome/browser/ui/views/frame/browser_view.cc" {
			t.Fatalf("expected browser_view.cc to rank #1 for bview.cc, got %s (all: %+v)", res[0].RelPath, res)
		}
	})

	t.Run("CamelCase fuzzy matching (PDV)", func(t *testing.T) {
		res, err := sm.FuzzyFindFiles(FuzzyFindOptions{
			BaseDir: tempDir,
			Query:   "PDV",
		})
		if err != nil {
			t.Fatalf("FuzzyFindFiles failed: %v", err)
		}
		if len(res) == 0 || res[0].RelPath != "web/src/diff/PierreDiffViewer.svelte" {
			t.Fatalf("expected PierreDiffViewer.svelte as #1 for PDV, got %+v", res)
		}
	})

	t.Run("Path segment + filename fuzzy match (frame/browser_view.cc)", func(t *testing.T) {
		res, err := sm.FuzzyFindFiles(FuzzyFindOptions{
			BaseDir: tempDir,
			Query:   "frame/browser_view.cc",
		})
		if err != nil {
			t.Fatalf("FuzzyFindFiles failed: %v", err)
		}
		if len(res) == 0 || res[0].RelPath != "chrome/browser/ui/views/frame/browser_view.cc" {
			t.Fatalf("expected frame/browser_view.cc to rank browser_view.cc #1, got %+v", res)
		}
	})

	t.Run("Multi-token space-separated query (quick service)", func(t *testing.T) {
		res, err := sm.FuzzyFindFiles(FuzzyFindOptions{
			BaseDir: tempDir,
			Query:   "quick service",
		})
		if err != nil {
			t.Fatalf("FuzzyFindFiles failed: %v", err)
		}
		if len(res) == 0 || res[0].RelPath != "web/src/quick-input/quick-input-service.ts" {
			t.Fatalf("expected quick-input-service.ts #1 for 'quick service', got %+v", res)
		}
	})

	t.Run("Built-in excludes skip out_Default and node_modules", func(t *testing.T) {
		res, err := sm.FuzzyFindFiles(FuzzyFindOptions{
			BaseDir: tempDir,
			Query:   "generated_view",
		})
		if err != nil {
			t.Fatalf("FuzzyFindFiles failed: %v", err)
		}
		if len(res) != 0 {
			t.Fatalf("expected out_Default/gen/generated_view.cc to be excluded, got %+v", res)
		}
	})

	t.Run("WriteFile and Rm invalidate cached file index", func(t *testing.T) {
		newFile := filepath.Join(tempDir, "src", "brand_new_feature.ts")
		if err := sm.WriteFile(newFile, []byte("export {};")); err != nil {
			t.Fatalf("WriteFile failed: %v", err)
		}
		res, err := sm.FuzzyFindFiles(FuzzyFindOptions{
			BaseDir: tempDir,
			Query:   "brand_new_feature",
		})
		if err != nil {
			t.Fatalf("FuzzyFindFiles failed: %v", err)
		}
		if len(res) != 1 || res[0].RelPath != "src/brand_new_feature.ts" {
			t.Fatalf("expected newly written file in fuzzy results, got %+v", res)
		}

		if err := sm.Rm(newFile, false, false); err != nil {
			t.Fatalf("Rm failed: %v", err)
		}
		resAfterRm, err := sm.FuzzyFindFiles(FuzzyFindOptions{
			BaseDir: tempDir,
			Query:   "brand_new_feature",
		})
		if err != nil {
			t.Fatalf("FuzzyFindFiles failed: %v", err)
		}
		if len(resAfterRm) != 0 {
			t.Fatalf("expected removed file to disappear from fuzzy results, got %+v", resAfterRm)
		}
	})

	t.Run("Root-anchored excludes do not exclude nested directories or files", func(t *testing.T) {
		nestedDataFile := filepath.Join(tempDir, "chrome", "test", "data", "browser_window_impl.cc")
		rootDataFile := filepath.Join(tempDir, "data", "root_ignored.cc")
		for _, p := range []string{nestedDataFile, rootDataFile} {
			if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
				t.Fatalf("mkdir failed: %v", err)
			}
			if err := os.WriteFile(p, []byte("test"), 0644); err != nil {
				t.Fatalf("write failed: %v", err)
			}
		}
		sm.InvalidateFileIndex()

		res, err := sm.FuzzyFindFiles(FuzzyFindOptions{
			BaseDir:  tempDir,
			Query:    "browser_window_impl.cc",
			Excludes: []string{"./data", "/out*"},
		})
		if err != nil {
			t.Fatalf("FuzzyFindFiles failed: %v", err)
		}
		if len(res) != 1 || res[0].RelPath != "chrome/test/data/browser_window_impl.cc" {
			t.Fatalf("expected nested chrome/test/data/browser_window_impl.cc to be found, got %+v", res)
		}

		resRoot, err := sm.FuzzyFindFiles(FuzzyFindOptions{
			BaseDir:  tempDir,
			Query:    "root_ignored.cc",
			Excludes: []string{"./data"},
		})
		if err != nil {
			t.Fatalf("FuzzyFindFiles failed: %v", err)
		}
		if len(resRoot) != 0 {
			t.Fatalf("expected root data/root_ignored.cc to be excluded by ./data, got %+v", resRoot)
		}
	})
}

func loadGitIgnoreExcludes(baseDir string) []string {
	data, err := os.ReadFile(filepath.Join(baseDir, ".gitignore"))
	if err != nil {
		return nil
	}
	seen := make(map[string]bool)
	var excludes []string
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "!") {
			continue
		}
		isRootAnchored := strings.HasPrefix(trimmed, "/")
		stripped := strings.Trim(trimmed, "/")
		if stripped == "" {
			continue
		}
		clean := stripped
		if isRootAnchored {
			clean = "./" + stripped
		}
		if !seen[clean] {
			seen[clean] = true
			excludes = append(excludes, clean)
		}
	}
	return excludes
}

func TestFuzzyFindFiles_ChromiumBaseBenchmarkSuite(t *testing.T) {
	chromiumSrc := resolveChromiumSrc()
	if chromiumSrc == "" {
		t.Skip("skipping Chromium benchmark test: pass -chromium-src=<path> or set CHROMIUM_SRC")
	}
	if _, err := os.Stat(chromiumSrc); os.IsNotExist(err) {
		t.Skipf("skipping Chromium benchmark test: %s not present", chromiumSrc)
	}

	sm, err := NewSandboxManager(chromiumSrc)
	if err != nil {
		t.Fatalf("NewSandboxManager(%s) failed: %v", chromiumSrc, err)
	}

	excludes := loadGitIgnoreExcludes(chromiumSrc)

	// 1. Cold index build + initial query
	coldStart := time.Now()
	initialRes, err := sm.FuzzyFindFiles(FuzzyFindOptions{
		BaseDir:    chromiumSrc,
		Query:      "",
		MaxResults: 100,
		Excludes:   excludes,
	})
	coldDuration := time.Since(coldStart)
	if err != nil {
		t.Fatalf("cold FuzzyFindFiles failed: %v", err)
	}
	if len(initialRes) != 100 {
		t.Fatalf("expected 100 initial files, got %d", len(initialRes))
	}

	sm.indexMu.Lock()
	var indexedCount int
	for _, entry := range sm.fileIndex {
		indexedCount = len(entry.files)
	}
	sm.indexMu.Unlock()
	t.Logf("[ChromiumBase] Indexed %d files in %v (cold build, %d excludes)", indexedCount, coldDuration, len(excludes))

	// 2. Diverse warm fuzzy query suite
	testCases := []struct {
		name           string
		query          string
		expectTopExact string
		expectInTop5   string
		minResults     int
	}{
		{
			name:           "Exact filename (browser_view.cc)",
			query:          "browser_view.cc",
			expectTopExact: "chrome/browser/ui/views/frame/browser_view.cc",
			minResults:     1,
		},
		{
			name:           "Exact header filename (browser_view.h)",
			query:          "browser_view.h",
			expectTopExact: "chrome/browser/ui/views/frame/browser_view.h",
			minResults:     1,
		},
		{
			name:           "Exact core implementation (web_contents_impl.cc)",
			query:          "web_contents_impl.cc",
			expectTopExact: "content/browser/web_contents/web_contents_impl.cc",
			minResults:     1,
		},
		{
			name:           "Exact core header (render_frame_host_impl.h)",
			query:          "render_frame_host_impl.h",
			expectTopExact: "content/browser/renderer_host/render_frame_host_impl.h",
			minResults:     1,
		},
		{
			name:         "Fuzzy abbreviation (bview.cc)",
			query:        "bview.cc",
			expectInTop5: "browser_view.cc",
			minResults:   5,
		},
		{
			name:         "Fuzzy word boundary (wci.cc)",
			query:        "wci.cc",
			expectInTop5: "web_contents_impl.cc",
			minResults:   5,
		},
		{
			name:         "Fuzzy word boundary (rfhi.cc)",
			query:        "rfhi.cc",
			expectInTop5: "render_frame_host_impl.cc",
			minResults:   1,
		},
		{
			name:           "Directory + filename (frame/browser_view.cc)",
			query:          "frame/browser_view.cc",
			expectTopExact: "chrome/browser/ui/views/frame/browser_view.cc",
			minResults:     1,
		},
		{
			name:           "Multi-token path + filename (chrome ui views browser_view.cc)",
			query:          "chrome ui views browser_view.cc",
			expectTopExact: "chrome/browser/ui/views/frame/browser_view.cc",
			minResults:     1,
		},
		{
			name:       "Mojom interface search (page_handler.mojom)",
			query:      "page_handler.mojom",
			minResults: 1,
		},
		{
			name:           "Python tool search (autotest.py)",
			query:          "autotest.py",
			expectTopExact: "tools/autotest.py",
			minResults:     1,
		},
		{
			name:       "High fan-out filename (BUILD.gn)",
			query:      "BUILD.gn",
			minResults: 100,
		},
		{
			name:       "High fan-out short query (DEPS)",
			query:      "DEPS",
			minResults: 100,
		},
		{
			name:           "Feature search (tab_strip_service.cc)",
			query:          "tab_strip_service.cc",
			expectTopExact: "chrome/browser/ui/tabs/tab_strip_service.cc",
			minResults:     1,
		},
		{
			name:           "Instance impl search (browser_window_impl.cc)",
			query:          "browser_window_impl.cc",
			expectTopExact: "chrome/browser/ui/views/browser_window_impl.cc",
			minResults:     1,
		},
		{
			name:       "Non-existent file (worst-case full scan)",
			query:      "zzz_nonexistent_chromium_file_98765.cc",
			minResults: 0,
		},
	}

	var totalWarmDuration time.Duration
	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			start := time.Now()
			res, err := sm.FuzzyFindFiles(FuzzyFindOptions{
				BaseDir:    chromiumSrc,
				Query:      tc.query,
				MaxResults: 100,
				Excludes:   excludes,
			})
			elapsed := time.Since(start)
			totalWarmDuration += elapsed

			if err != nil {
				t.Fatalf("FuzzyFindFiles(%q) failed: %v", tc.query, err)
			}
			if len(res) < tc.minResults {
				t.Fatalf("FuzzyFindFiles(%q): expected at least %d results, got %d", tc.query, tc.minResults, len(res))
			}
			if tc.expectTopExact != "" && (len(res) == 0 || res[0].RelPath != tc.expectTopExact) {
				top := "<none>"
				if len(res) > 0 {
					top = res[0].RelPath
				}
				t.Fatalf("FuzzyFindFiles(%q): expected #1 = %s, got %s", tc.query, tc.expectTopExact, top)
			}
			if tc.expectInTop5 != "" {
				found := false
				limit := len(res)
				if limit > 5 {
					limit = 5
				}
				for i := 0; i < limit; i++ {
					if strings.HasSuffix(res[i].RelPath, tc.expectInTop5) {
						found = true
						break
					}
				}
				if !found {
					t.Fatalf("FuzzyFindFiles(%q): expected suffix %q in top 5, got %+v", tc.query, tc.expectInTop5, res[:limit])
				}
			}
			if elapsed > 200*time.Millisecond {
				t.Errorf("FuzzyFindFiles(%q) took %v (expected < 200ms on warm index)", tc.query, elapsed)
			}
			topMatch := "<none>"
			if len(res) > 0 {
				topMatch = res[0].RelPath
			}
			t.Logf("Query %-42q -> %3d results in %8v (top: %s)", tc.query, len(res), elapsed, topMatch)
		})
	}
	t.Logf("[ChromiumBase] Average warm query latency across %d queries: %v", len(testCases), totalWarmDuration/time.Duration(len(testCases)))
}

func BenchmarkFuzzyFindFiles_ChromiumBase(b *testing.B) {
	chromiumSrc := resolveChromiumSrc()
	if chromiumSrc == "" {
		b.Skip("skipping Chromium benchmark: pass -chromium-src=<path> or set CHROMIUM_SRC")
	}
	if _, err := os.Stat(chromiumSrc); os.IsNotExist(err) {
		b.Skipf("skipping Chromium benchmark: %s not present", chromiumSrc)
	}
	sm, err := NewSandboxManager(chromiumSrc)
	if err != nil {
		b.Fatalf("NewSandboxManager failed: %v", err)
	}
	// Warm the index once before benchmarking queries
	if _, err := sm.FuzzyFindFiles(FuzzyFindOptions{BaseDir: chromiumSrc, Query: ""}); err != nil {
		b.Fatalf("warm-up failed: %v", err)
	}

	queries := []string{
		"browser_view.cc",
		"bview.cc",
		"frame/browser_view.cc",
		"chrome ui views browser_view.cc",
		"BUILD.gn",
		"zzz_nonexistent_chromium_file_98765.cc",
	}

	for _, q := range queries {
		b.Run(q, func(b *testing.B) {
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_, err := sm.FuzzyFindFiles(FuzzyFindOptions{
					BaseDir:    chromiumSrc,
					Query:      q,
					MaxResults: 100,
				})
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
