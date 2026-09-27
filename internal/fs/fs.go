// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package fs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// FileStat contains metadata about a file or directory.
type FileStat struct {
	Size           int64   `json:"size"`
	MtimeMs        float64 `json:"mtimeMs"`
	IsFile         bool    `json:"isFile"`
	IsDirectory    bool    `json:"isDirectory"`
	IsSymbolicLink bool    `json:"isSymbolicLink"`
}

// SandboxManager manages sandboxed filesystem access.
type SandboxManager struct {
	mu            sync.RWMutex
	allowedRoots  []string
	repoRoot      string
	daemonTempDir string
}
func appendIfMissing(slice []string, val string) []string {
	clean := filepath.Clean(val)
	for _, s := range slice {
		if s == clean {
			return slice
		}
	}
	return append(slice, clean)
}

func appendRoot(roots []string, r string) []string {
	if r == "" {
		return roots
	}
	abs, err := filepath.Abs(r)
	if err != nil {
		abs = filepath.Clean(r)
	}
	roots = appendIfMissing(roots, abs)
	if resolved, err := filepath.EvalSymlinks(abs); err == nil && resolved != abs {
		roots = appendIfMissing(roots, resolved)
	}
	return roots
}

// NewSandboxManager initializes a filesystem sandbox with the repository root and optional extra allowed roots.
func NewSandboxManager(repoRoot string, extraRoots ...string) (*SandboxManager, error) {
	absRepo, err := filepath.Abs(repoRoot)
	if err != nil {
		return nil, fmt.Errorf("invalid repository root: %w", err)
	}

	// Create private scoped temporary directory with 0700 permissions
	uid := os.Getuid()
	if uid < 0 {
		uid = 0
	}
	daemonTempDir := filepath.Join(os.TempDir(), fmt.Sprintf("jj-view-%d", uid))
	if err := os.MkdirAll(daemonTempDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create daemon temp directory: %w", err)
	}

	var roots []string
	roots = appendRoot(roots, absRepo)
	roots = appendRoot(roots, daemonTempDir)
	if agyData := os.Getenv("ANTIGRAVITY_EXECUTABLE_DATA_DIR"); agyData != "" {
		if absAgy, err := filepath.Abs(agyData); err == nil {
			roots = appendRoot(roots, absAgy)
		} else {
			roots = appendRoot(roots, agyData)
		}
	}
	for _, extra := range extraRoots {
		if extra != "" {
			roots = appendRoot(roots, extra)
		}
	}

	if configHome := os.Getenv("XDG_CONFIG_HOME"); configHome != "" {
		roots = appendRoot(roots, filepath.Join(configHome, "jj-view"))
		roots = appendRoot(roots, configHome)
	}
	if stateHome := os.Getenv("XDG_STATE_HOME"); stateHome != "" {
		roots = appendRoot(roots, filepath.Join(stateHome, "jj-view"))
	}

	userHome, err := os.UserHomeDir()
	if err == nil {
		if runtime.GOOS == "windows" {
			if appData := os.Getenv("APPDATA"); appData != "" {
				roots = appendRoot(roots, filepath.Join(appData, "jj-view"))
			}
			if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
				roots = appendRoot(roots, filepath.Join(localAppData, "jj-view"))
			}
		} else if runtime.GOOS == "darwin" {
			roots = appendRoot(roots,
				filepath.Join(userHome, "Library", "Application Support", "jj-view"),
			)
		} else {
			roots = appendRoot(roots,
				filepath.Join(userHome, ".config", "jj-view"))
			roots = appendRoot(roots,
				filepath.Join(userHome, ".local", "state", "jj-view"))
		}
	}

	return &SandboxManager{
		repoRoot:      absRepo,
		allowedRoots:  roots,
		daemonTempDir: daemonTempDir,
	}, nil
}

// DaemonTempDir returns the private temporary directory for this daemon.
func (sm *SandboxManager) DaemonTempDir() string {
	return sm.daemonTempDir
}

// AddAllowedRoot adds a directory (e.g. secondary workspace) to the sandbox.
func (sm *SandboxManager) AddAllowedRoot(root string) {
	if root == "" {
		return
	}
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.allowedRoots = appendRoot(sm.allowedRoots, root)
}

func (sm *SandboxManager) isAllowed(p string, roots []string) bool {
	cleanP := filepath.Clean(p)
	for _, root := range roots {
		cleanRoot := filepath.Clean(root)
		rel, err := filepath.Rel(cleanRoot, cleanP)
		if err == nil && !strings.HasPrefix(rel, "..") && rel != ".." {
			return true
		}
	}
	return false
}

// ValidatePath validates that a path is contained within an allowed sandbox directory.
func (sm *SandboxManager) ValidatePath(path string) (string, error) {
	return sm.validatePathInternal(path, true)
}

// ValidatePathForLink validates a path for symlink-specific operations (Lstat/Rm) without following the link.
func (sm *SandboxManager) ValidatePathForLink(path string) (string, error) {
	return sm.validatePathInternal(path, false)
}

func (sm *SandboxManager) validatePathInternal(path string, resolveSymlinks bool) (string, error) {
	if path == "" {
		return "", errors.New("path cannot be empty")
	}

	var absPath string
	if filepath.IsAbs(path) {
		absPath = filepath.Clean(path)
	} else if runtime.GOOS == "windows" && (strings.HasPrefix(path, "/") || strings.HasPrefix(path, "\\")) {
		absPath, _ = filepath.Abs(path)
	} else {
		absPath = filepath.Clean(filepath.Join(sm.repoRoot, path))
	}

	sm.mu.RLock()
	roots := make([]string, len(sm.allowedRoots))
	copy(roots, sm.allowedRoots)
	sm.mu.RUnlock()

	// 1. Lexical check
	if !sm.isAllowed(absPath, roots) {
		return "", fmt.Errorf("access denied: path is outside allowed sandbox: %s", absPath)
	}

	// 2. Symlink checks
	if resolveSymlinks {
		fi, err := os.Lstat(absPath)
		if err == nil {
			// Path exists: resolve symlink and check target
			if fi.Mode()&os.ModeSymlink != 0 {
				target, err := filepath.EvalSymlinks(absPath)
				if err != nil {
					return "", fmt.Errorf("failed to resolve symlink %s: %w", absPath, err)
				}
				if !sm.isAllowed(target, roots) {
					return "", fmt.Errorf("access denied: symlink resolves outside allowed sandbox: %s -> %s", absPath, target)
				}
				return target, nil
			}
		} else if errors.Is(err, os.ErrNotExist) {
			// Path does not exist yet (e.g. WriteFile target):
			// Walk up to find nearest existing parent directory and resolve its symlinks
			parent := filepath.Dir(absPath)
			for parent != "/" && parent != "." && filepath.VolumeName(parent) != parent {
				if pfi, perr := os.Lstat(parent); perr == nil {
					if pfi.Mode()&os.ModeSymlink != 0 {
						target, err := filepath.EvalSymlinks(parent)
						if err != nil {
							return "", fmt.Errorf("failed to resolve ancestor symlink %s: %w", parent, err)
						}
						if !sm.isAllowed(target, roots) {
							return "", fmt.Errorf("access denied: ancestor symlink resolves outside sandbox: %s -> %s", parent, target)
						}
					}
					break
				}
				parent = filepath.Dir(parent)
			}
		}
	} else {
		// When not resolving the symlink itself (Lstat/Rm), verify ancestor directory symlinks
		parent := filepath.Dir(absPath)
		if parent != absPath {
			resolvedParent, err := filepath.EvalSymlinks(parent)
			if err == nil && !sm.isAllowed(resolvedParent, roots) {
				return "", fmt.Errorf("access denied: parent directory resolves outside sandbox: %s -> %s", parent, resolvedParent)
			}
		}
	}

	return absPath, nil
}

// ReadFile reads the entire file at path.
func (sm *SandboxManager) ReadFile(path string) ([]byte, error) {
	validated, err := sm.ValidatePath(path)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(validated)
}

// WriteFile writes data to path.
func (sm *SandboxManager) WriteFile(path string, data []byte) error {
	validated, err := sm.ValidatePath(path)
	if err != nil {
		return err
	}
	dir := filepath.Dir(validated)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	return os.WriteFile(validated, data, 0644)
}

// Mkdir creates a directory at path.
func (sm *SandboxManager) Mkdir(path string, recursive bool) error {
	validated, err := sm.ValidatePath(path)
	if err != nil {
		return err
	}
	if recursive {
		return os.MkdirAll(validated, 0755)
	}
	return os.Mkdir(validated, 0755)
}

// Stat retrieves metadata about path following symlinks.
func (sm *SandboxManager) Stat(path string) (*FileStat, error) {
	validated, err := sm.ValidatePath(path)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(validated)
	if err != nil {
		return nil, err
	}

	lstatInfo, _ := os.Lstat(validated)
	isSymlink := lstatInfo != nil && (lstatInfo.Mode()&os.ModeSymlink != 0)

	return &FileStat{
		Size:           info.Size(),
		MtimeMs:        float64(info.ModTime().UnixNano()) / 1e6,
		IsFile:         !info.IsDir(),
		IsDirectory:    info.IsDir(),
		IsSymbolicLink: isSymlink,
	}, nil
}

// Lstat retrieves metadata about path without following symlinks.
func (sm *SandboxManager) Lstat(path string) (*FileStat, error) {
	validated, err := sm.ValidatePathForLink(path)
	if err != nil {
		return nil, err
	}

	info, err := os.Lstat(validated)
	if err != nil {
		return nil, err
	}

	return &FileStat{
		Size:           info.Size(),
		MtimeMs:        float64(info.ModTime().UnixNano()) / 1e6,
		IsFile:         info.Mode().IsRegular(),
		IsDirectory:    info.IsDir(),
		IsSymbolicLink: (info.Mode() & os.ModeSymlink) != 0,
	}, nil
}

// Readdir lists the entry names in directory path.
func (sm *SandboxManager) Readdir(path string) ([]string, error) {
	validated, err := sm.ValidatePath(path)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(validated)
	if err != nil {
		return nil, err
	}

	names := make([]string, len(entries))
	for i, entry := range entries {
		names[i] = entry.Name()
	}
	return names, nil
}

// Exists checks if path exists.
func (sm *SandboxManager) Exists(path string) bool {
	validated, err := sm.ValidatePathForLink(path)
	if err != nil {
		return false
	}
	_, statErr := os.Lstat(validated)
	return statErr == nil || !os.IsNotExist(statErr)
}

// Realpath resolves symlinks and canonicalizes the path.
func (sm *SandboxManager) Realpath(path string) (string, error) {
	validated, err := sm.ValidatePath(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(validated)
	if err != nil {
		return "", err
	}
	return sm.ValidatePath(resolved)
}

// Mkdtemp creates a temporary directory with prefix under daemon temp directory or specified dir.
func (sm *SandboxManager) Mkdtemp(prefix string) (string, error) {
	cleanPrefix := filepath.Clean(prefix)
	var dir, pattern string
	if filepath.IsAbs(cleanPrefix) || strings.Contains(prefix, string(filepath.Separator)) || strings.Contains(prefix, "/") {
		dir = filepath.Dir(cleanPrefix)
		pattern = filepath.Base(cleanPrefix)
	} else {
		dir = sm.daemonTempDir
		pattern = prefix
	}

	validatedDir, err := sm.ValidatePath(dir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(validatedDir, 0700); err != nil {
		return "", err
	}
	return os.MkdirTemp(validatedDir, pattern)
}

// Rm removes the file or directory at path.
func (sm *SandboxManager) Rm(path string, recursive bool, force bool) error {
	validated, err := sm.ValidatePathForLink(path)
	if err != nil {
		return err
	}

	// Refuse removing root or repoRoot or any sandbox root
	sm.mu.RLock()
	roots := make([]string, len(sm.allowedRoots))
	copy(roots, sm.allowedRoots)
	sm.mu.RUnlock()

	for _, root := range roots {
		if validated == filepath.Clean(root) {
			return fmt.Errorf("cannot remove sandbox root directory: %s", validated)
		}
	}

	if validated == "/" || filepath.VolumeName(validated) == validated || validated == filepath.VolumeName(validated)+"\\" {
		return errors.New("cannot remove filesystem root")
	}

	// Refuse deletion of critical repository metadata
	if validated == filepath.Join(sm.repoRoot, ".jj") || validated == filepath.Join(sm.repoRoot, ".git") {
		return errors.New("cannot remove repository metadata directory (.jj or .git)")
	}

	var rmErr error
	if recursive {
		rmErr = os.RemoveAll(validated)
	} else {
		rmErr = os.Remove(validated)
	}

	if force && rmErr != nil && os.IsNotExist(rmErr) {
		return nil
	}
	return rmErr
}
