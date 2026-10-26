// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package fs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/charlievieth/fastwalk"
)

const (
	// DefaultMaxFindDirs is the maximum number of directories a FindFiles walk will visit before stopping.
	DefaultMaxFindDirs = 500_000
	// DefaultMaxFindTimeout is the maximum duration a FindFiles walk may run before stopping.
	DefaultMaxFindTimeout = 20 * time.Second
)

// FindFilesOptions configures file search.
type FindFilesOptions struct {
	Context    context.Context `json:"-"`
	BaseDir    string          `json:"baseDir"`
	Pattern    string          `json:"pattern"`
	MaxResults int             `json:"maxResults,omitempty"`
	Excludes   []string        `json:"excludes,omitempty"`
	MaxDirs    int             `json:"maxDirs,omitempty"`
	Timeout    time.Duration   `json:"-"`
}

var (
	errStop          = errors.New("find: max results reached")
	errLimitExceeded = errors.New("find: directory limit or timeout exceeded")
)

func isBuiltInExcludedDir(name string, relPathSlash string, patternIncludesJj bool) bool {
	switch name {
	case ".git", "node_modules", ".vscode-test", "dist", "out":
		return true
	case ".jj":
		return !patternIncludesJj
	case "repo", "op_store":
		return relPathSlash == ".jj/"+name || strings.HasSuffix(relPathSlash, "/.jj/"+name)
	default:
		return false
	}
}

// FindFiles concurrently searches for files matching pattern under baseDir.
// It uses fastwalk for multi-threaded traversal and doublestar for glob matching.
func (sm *SandboxManager) FindFiles(opts FindFilesOptions) ([]string, error) {
	if opts.Pattern == "" {
		return nil, errors.New("pattern cannot be empty")
	}

	baseDir := opts.BaseDir
	if baseDir == "" {
		baseDir = sm.repoRoot
	}

	validBaseDir, err := sm.ValidatePath(baseDir)
	if err != nil {
		return nil, err
	}

	normPattern := filepath.ToSlash(opts.Pattern)
	patternIncludesJj := strings.Contains(normPattern, ".jj")

	maxDirs := opts.MaxDirs
	if maxDirs <= 0 {
		maxDirs = DefaultMaxFindDirs
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultMaxFindTimeout
	}

	baseCtx := opts.Context
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	ctx, cancel := context.WithTimeout(baseCtx, timeout)
	defer cancel()

	// Separate exact excludes from glob excludes so exact lookups remain O(1).
	excludeMap := make(map[string]bool, len(opts.Excludes))
	var excludeGlobs []string
	cleanBaseDir := filepath.Clean(baseDir)
	for _, ex := range opts.Excludes {
		if ex == "" {
			continue
		}
		if !strings.ContainsAny(ex, "*?[") && (filepath.IsAbs(ex) || strings.HasPrefix(ex, "/")) {
			cleanEx := filepath.Clean(ex)
			if rel, relErr := filepath.Rel(validBaseDir, cleanEx); relErr == nil && rel != "." && !strings.HasPrefix(rel, "..") {
				excludeMap[filepath.ToSlash(rel)] = true
				continue
			}
			if rel, relErr := filepath.Rel(cleanBaseDir, cleanEx); relErr == nil && rel != "." && !strings.HasPrefix(rel, "..") {
				excludeMap[filepath.ToSlash(rel)] = true
				continue
			}
		}

		normEx := strings.ReplaceAll(filepath.ToSlash(ex), "\\", "/")
		normEx = strings.TrimPrefix(normEx, "./")
		normEx = strings.TrimPrefix(normEx, "/")
		normEx = strings.TrimSuffix(normEx, "/")
		if normEx == "" {
			continue
		}
		if strings.HasSuffix(normEx, "/**") {
			prefix := strings.TrimSuffix(normEx, "/**")
			if prefix == "" {
				continue
			}
			if strings.ContainsAny(prefix, "*?[") {
				excludeGlobs = append(excludeGlobs, prefix, normEx)
			} else {
				excludeMap[prefix] = true
			}
			continue
		}
		if strings.ContainsAny(normEx, "*?[") {
			excludeGlobs = append(excludeGlobs, normEx)
		} else {
			excludeMap[normEx] = true
		}
	}

	var mu sync.Mutex
	results := make([]string, 0)
	var matchCount atomic.Int64
	var dirsVisited atomic.Int64

	conf := fastwalk.Config{
		Follow: false,
	}

	walkErr := fastwalk.Walk(&conf, validBaseDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			// Skip unreadable files or permission denied errors gracefully
			return nil
		}

		if ctx.Err() != nil {
			return errLimitExceeded
		}

		if opts.MaxResults > 0 && matchCount.Load() >= int64(opts.MaxResults) {
			return errStop
		}

		// Don't match the root directory itself against the pattern
		if path == validBaseDir {
			return nil
		}

		relPath, relErr := filepath.Rel(validBaseDir, path)
		if relErr != nil {
			return nil
		}
		relPathSlash := filepath.ToSlash(relPath)
		name := d.Name()

		// Directory branch pruning based on built-in and caller-specified excludes
		if d.IsDir() {
			if isBuiltInExcludedDir(name, relPathSlash, patternIncludesJj) {
				return fastwalk.SkipDir
			}
			if excludeMap[name] || excludeMap[relPathSlash] {
				return fastwalk.SkipDir
			}
			for _, ex := range excludeGlobs {
				if matched, _ := doublestar.Match(ex, relPathSlash); matched {
					return fastwalk.SkipDir
				}
				if matched, _ := doublestar.Match(ex, name); matched {
					return fastwalk.SkipDir
				}
			}
			if dirsVisited.Add(1) > int64(maxDirs) {
				return errLimitExceeded
			}
			return nil
		}

		// File-level exclusions
		if excludeMap[name] || excludeMap[relPathSlash] {
			return nil
		}
		for _, ex := range excludeGlobs {
			if matched, _ := doublestar.Match(ex, relPathSlash); matched {
				return nil
			}
			if matched, _ := doublestar.Match(ex, name); matched {
				return nil
			}
		}

		// Check if relative path matches pattern
		matched, matchErr := doublestar.Match(normPattern, relPathSlash)
		if matchErr == nil && matched {
			mu.Lock()
			if opts.MaxResults <= 0 || len(results) < opts.MaxResults {
				results = append(results, filepath.Clean(path))
				matchCount.Add(1)
			}
			reachedLimit := opts.MaxResults > 0 && len(results) >= opts.MaxResults
			mu.Unlock()

			if reachedLimit {
				return errStop
			}
		}

		return nil
	})

	if opts.Context != nil && opts.Context.Err() != nil {
		return nil, opts.Context.Err()
	}

	if walkErr != nil && !errors.Is(walkErr, errStop) && !errors.Is(walkErr, errLimitExceeded) {
		return nil, walkErr
	}

	return results, nil
}
