// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package fs

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/charlievieth/fastwalk"
)

// FindFilesOptions configures file search.
type FindFilesOptions struct {
	BaseDir    string   `json:"baseDir"`
	Pattern    string   `json:"pattern"`
	MaxResults int      `json:"maxResults,omitempty"`
	Excludes   []string `json:"excludes,omitempty"`
}

var errStop = errors.New("find: max results reached")

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

	// Build custom excludes set
	excludeMap := make(map[string]bool, len(opts.Excludes))
	for _, ex := range opts.Excludes {
		if ex != "" {
			excludeMap[filepath.ToSlash(ex)] = true
		}
	}

	var mu sync.Mutex
	results := make([]string, 0)
	var matchCount atomic.Int64

	conf := fastwalk.Config{
		Follow: false,
	}

	walkErr := fastwalk.Walk(&conf, validBaseDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			// Skip unreadable files or permission denied errors gracefully
			return nil
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

		// Directory branch pruning based on caller-specified excludes
		if d.IsDir() {
			// Check caller-specified excludes (by directory name, relative path, or glob)
			if excludeMap[name] || excludeMap[relPathSlash] {
				return fastwalk.SkipDir
			}
			for ex := range excludeMap {
				if matched, _ := doublestar.Match(ex, relPathSlash); matched {
					return fastwalk.SkipDir
				}
				if matched, _ := doublestar.Match(ex, name); matched {
					return fastwalk.SkipDir
				}
			}
			return nil
		}

		// File-level exclusions
		if excludeMap[name] || excludeMap[relPathSlash] {
			return nil
		}
		for ex := range excludeMap {
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

	if walkErr != nil && !errors.Is(walkErr, errStop) {
		return nil, walkErr
	}

	return results, nil
}
