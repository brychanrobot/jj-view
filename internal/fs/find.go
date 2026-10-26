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
	case ".git", "node_modules", ".vscode-test", "dist", "out", ".cache", ".cipd", "__pycache__":
		return true
	case ".jj":
		return !patternIncludesJj
	case "repo", "op_store":
		return relPathSlash == ".jj/"+name || strings.HasSuffix(relPathSlash, "/.jj/"+name)
	}
	if (relPathSlash == name && strings.HasPrefix(name, "out")) ||
		strings.HasPrefix(name, "out_") ||
		strings.HasPrefix(name, "out-") ||
		strings.HasPrefix(name, "bazel-") ||
		strings.HasPrefix(name, "blaze-") {
		return true
	}
	return false
}

type parsedExcludes struct {
	anyDepthNames map[string]bool
	rootPaths     map[string]bool
	anyDepthGlobs []string
	rootGlobs     []string
}

func (p parsedExcludes) isEmpty() bool {
	return len(p.anyDepthNames) == 0 && len(p.rootPaths) == 0 && len(p.anyDepthGlobs) == 0 && len(p.rootGlobs) == 0
}

func parseExcludes(excludes []string, validBaseDir, cleanBaseDir string) parsedExcludes {
	p := parsedExcludes{
		anyDepthNames: make(map[string]bool),
		rootPaths:     make(map[string]bool),
	}
	for _, ex := range excludes {
		if ex == "" {
			continue
		}
		trimmedWildcard := strings.TrimSuffix(filepath.ToSlash(ex), "/**")
		if !strings.ContainsAny(trimmedWildcard, "*?[") && (filepath.IsAbs(ex) || strings.HasPrefix(ex, "/")) {
			cleanEx := filepath.Clean(filepath.FromSlash(trimmedWildcard))
			if rel, relErr := filepath.Rel(validBaseDir, cleanEx); relErr == nil && rel != "." && !strings.HasPrefix(rel, "..") {
				p.rootPaths[filepath.ToSlash(rel)] = true
				continue
			}
			if rel, relErr := filepath.Rel(cleanBaseDir, cleanEx); relErr == nil && rel != "." && !strings.HasPrefix(rel, "..") {
				p.rootPaths[filepath.ToSlash(rel)] = true
				continue
			}
		}

		normEx := strings.ReplaceAll(filepath.ToSlash(ex), "\\", "/")
		rootAnchored := strings.HasPrefix(normEx, "/") || strings.HasPrefix(normEx, "./")
		normEx = strings.TrimPrefix(normEx, "./")
		normEx = strings.TrimPrefix(normEx, "/")
		normEx = strings.TrimSuffix(normEx, "/")
		if normEx == "" {
			continue
		}
		if strings.HasSuffix(normEx, "/**") {
			normEx = strings.TrimSuffix(normEx, "/**")
			if normEx == "" {
				continue
			}
		}
		if !rootAnchored && strings.HasPrefix(normEx, "**/") {
			rem := strings.TrimPrefix(normEx, "**/")
			if rem == "" {
				continue
			}
			if !strings.Contains(rem, "/") {
				normEx = rem
			}
		}

		if rootAnchored || strings.Contains(normEx, "/") {
			if strings.ContainsAny(normEx, "*?[") {
				p.rootGlobs = append(p.rootGlobs, normEx)
			} else {
				p.rootPaths[normEx] = true
			}
		} else {
			if strings.ContainsAny(normEx, "*?[") {
				p.anyDepthGlobs = append(p.anyDepthGlobs, normEx)
			} else {
				p.anyDepthNames[normEx] = true
			}
		}
	}
	return p
}

func isExcludedEntry(name, relPathSlash string, p parsedExcludes) bool {
	if p.anyDepthNames[name] || p.rootPaths[relPathSlash] {
		return true
	}
	for _, ex := range p.rootGlobs {
		if matched, _ := doublestar.Match(ex, relPathSlash); matched {
			return true
		}
	}
	for _, ex := range p.anyDepthGlobs {
		if matched, _ := doublestar.Match(ex, name); matched {
			return true
		}
	}
	return false
}

func isExcludedRelPath(relPathSlash string, baseOffset int32, p parsedExcludes) bool {
	if p.isEmpty() {
		return false
	}
	basename := relPathSlash[baseOffset:]
	if isExcludedEntry(basename, relPathSlash, p) {
		return true
	}
	if baseOffset > 0 {
		hasGlobsOrAnyDepth := len(p.anyDepthNames) > 0 || len(p.anyDepthGlobs) > 0 || len(p.rootGlobs) > 0
		start := 0
		for i := 0; i < int(baseOffset); i++ {
			if relPathSlash[i] == '/' {
				dirPrefix := relPathSlash[:i]
				if p.rootPaths[dirPrefix] {
					return true
				}
				if hasGlobsOrAnyDepth {
					seg := relPathSlash[start:i]
					if isExcludedEntry(seg, dirPrefix, p) {
						return true
					}
				}
				start = i + 1
			}
		}
	}
	return false
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

	excludes := parseExcludes(opts.Excludes, validBaseDir, filepath.Clean(baseDir))

	var mu sync.Mutex
	results := make([]string, 0)
	var matchCount atomic.Int64
	var dirsVisited atomic.Int64

	prefixLen := len(validBaseDir)
	if !strings.HasSuffix(validBaseDir, string(filepath.Separator)) {
		prefixLen++
	}

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
		if path == validBaseDir || len(path) <= prefixLen {
			return nil
		}

		relPathSlash := filepath.ToSlash(path[prefixLen:])
		name := d.Name()

		// Directory branch pruning based on built-in and caller-specified excludes
		if d.IsDir() {
			if isBuiltInExcludedDir(name, relPathSlash, patternIncludesJj) || isExcludedEntry(name, relPathSlash, excludes) {
				return fastwalk.SkipDir
			}
			if dirsVisited.Add(1) > int64(maxDirs) {
				return errLimitExceeded
			}
			return nil
		}

		// File-level exclusions
		if isExcludedEntry(name, relPathSlash, excludes) {
			return nil
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
