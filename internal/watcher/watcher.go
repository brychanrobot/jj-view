// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package watcher

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/fsnotify/fsnotify"
)

const (
	// DefaultMaxWatchDirs is the maximum number of directories a recursive watch walk will visit before aborting.
	DefaultMaxWatchDirs = 500_000
	// DefaultMaxWatchTimeout is the maximum duration a recursive watch setup walk may take before aborting.
	DefaultMaxWatchTimeout = 20 * time.Second
)

// ErrWatchLimitExceeded is returned when setting up a recursive directory watcher exceeds DefaultMaxWatchDirs or DefaultMaxWatchTimeout.
var ErrWatchLimitExceeded = errors.New("watcher: directory limit or timeout exceeded")

// ChangeType represents the type of filesystem change.
type ChangeType string

const (
	ChangeCreate ChangeType = "create"
	ChangeUpdate ChangeType = "update"
	ChangeDelete ChangeType = "delete"
)

// FileEvent represents a single file change event.
type FileEvent struct {
	Path string     `json:"path"`
	Type ChangeType `json:"type"`
}

// WatchOptions configures file watching behavior.
type WatchOptions struct {
	Context context.Context `json:"-"`
	Ignore  []string        `json:"ignore,omitempty"`
	MaxDirs int             `json:"maxDirs,omitempty"`
	Timeout time.Duration   `json:"-"`
}

// CallbackFunc is invoked when filesystem changes occur.
type CallbackFunc func(subID string, events []FileEvent)

type ignoreMatcher struct {
	exact map[string]struct{}
	globs []string
}

func normalizeIgnorePattern(pattern string) string {
	cleanPat := strings.ReplaceAll(filepath.ToSlash(pattern), "\\", "/")
	cleanPat = strings.TrimPrefix(cleanPat, "./")
	cleanPat = strings.TrimPrefix(cleanPat, "/")
	cleanPat = strings.TrimSuffix(cleanPat, "/")
	return cleanPat
}

func newIgnoreMatcher(ignores []string) *ignoreMatcher {
	m := &ignoreMatcher{
		exact: make(map[string]struct{}, len(ignores)),
	}
	for _, pattern := range ignores {
		cleanPat := normalizeIgnorePattern(pattern)
		if cleanPat == "" {
			continue
		}
		if strings.HasSuffix(cleanPat, "/**") {
			prefix := strings.TrimSuffix(cleanPat, "/**")
			if prefix == "" {
				continue
			}
			if strings.ContainsAny(prefix, "*?[") {
				m.globs = append(m.globs, prefix, cleanPat)
			} else {
				m.exact[prefix] = struct{}{}
			}
			continue
		}
		if strings.ContainsAny(cleanPat, "*?[") {
			m.globs = append(m.globs, cleanPat)
		} else {
			m.exact[cleanPat] = struct{}{}
		}
	}
	return m
}

func isBuiltInIgnoredSegment(part string) bool {
	return part == ".jj" || part == ".git" || part == "node_modules" || part == ".vscode-test" || part == "dist" || part == "out"
}

func (m *ignoreMatcher) isIgnored(path string, root string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return false
	}
	relSlash := filepath.ToSlash(rel)

	start := 0
	for i := 0; i <= len(relSlash); i++ {
		if i == len(relSlash) || relSlash[i] == '/' {
			part := relSlash[start:i]
			if isBuiltInIgnoredSegment(part) {
				return true
			}
			if _, ok := m.exact[part]; ok {
				return true
			}
			prefix := relSlash[:i]
			if _, ok := m.exact[prefix]; ok {
				return true
			}
			start = i + 1
		}
	}

	if len(m.globs) > 0 {
		base := filepath.Base(path)
		for _, cleanPat := range m.globs {
			if matched, _ := doublestar.Match(cleanPat, relSlash); matched {
				return true
			}
			if matchedBase, _ := doublestar.Match(cleanPat, base); matchedBase {
				return true
			}
		}
	}

	return false
}

type subscription struct {
	id       string
	dirPath  string
	ignores  []string
	matcher  *ignoreMatcher
	maxDirs  int
	timeout  time.Duration
	callback CallbackFunc
	done     chan struct{}
	watcher  *fsnotify.Watcher
}

// Hub manages file system watch subscriptions.
type Hub struct {
	mu            sync.RWMutex
	subscriptions map[string]*subscription
}

// NewHub creates a new watcher hub.
func NewHub() *Hub {
	return &Hub{
		subscriptions: make(map[string]*subscription),
	}
}

// Watch begins watching dirPath and calls callback on file changes.
func (h *Hub) Watch(dirPath string, opts WatchOptions, callback CallbackFunc) (string, error) {
	absDir, err := filepath.Abs(dirPath)
	if err != nil {
		return "", fmt.Errorf("invalid watch path: %w", err)
	}

	subIDBytes := make([]byte, 16)
	if _, err := rand.Read(subIDBytes); err != nil {
		return "", err
	}
	subID := hex.EncodeToString(subIDBytes)

	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return "", fmt.Errorf("failed to create fsnotify watcher: %w", err)
	}

	maxDirs := opts.MaxDirs
	if maxDirs <= 0 {
		maxDirs = DefaultMaxWatchDirs
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultMaxWatchTimeout
	}

	matcher := newIgnoreMatcher(opts.Ignore)
	sub := &subscription{
		id:       subID,
		dirPath:  absDir,
		ignores:  opts.Ignore,
		matcher:  matcher,
		maxDirs:  maxDirs,
		timeout:  timeout,
		callback: callback,
		done:     make(chan struct{}),
		watcher:  fsw,
	}

	// Add directories recursively, skipping ignored paths
	if err := h.addRecursive(opts.Context, fsw, absDir, absDir, matcher, maxDirs, timeout); err != nil {
		_ = fsw.Close()
		return "", err
	}

	h.mu.Lock()
	h.subscriptions[subID] = sub
	h.mu.Unlock()

	go h.runSubscription(sub)

	return subID, nil
}

// Unwatch cancels an active watch subscription.
func (h *Hub) Unwatch(subscriptionID string) {
	h.mu.Lock()
	sub, ok := h.subscriptions[subscriptionID]
	if ok {
		delete(h.subscriptions, subscriptionID)
	}
	h.mu.Unlock()

	if !ok {
		return
	}

	close(sub.done)
	_ = sub.watcher.Close()
}

func (h *Hub) addRecursive(
	ctx context.Context,
	w *fsnotify.Watcher,
	walkRoot string,
	baseRoot string,
	matcher *ignoreMatcher,
	maxDirs int,
	timeout time.Duration,
) error {
	dirsVisited := 0
	deadline := time.Now().Add(timeout)

	return filepath.WalkDir(walkRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // Skip inaccessible directories
		}
		if ctx != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%w: walk exceeded %s", ErrWatchLimitExceeded, timeout)
		}
		if !d.IsDir() {
			return nil
		}

		if path != baseRoot && matcher.isIgnored(path, baseRoot) {
			return filepath.SkipDir
		}

		dirsVisited++
		if dirsVisited > maxDirs {
			return fmt.Errorf("%w: visited more than %d directories", ErrWatchLimitExceeded, maxDirs)
		}

		if addErr := w.Add(path); addErr != nil {
			if !os.IsNotExist(addErr) && !os.IsPermission(addErr) {
				return fmt.Errorf("failed to watch directory %s: %w", path, addErr)
			}
		}
		return nil
	})
}

func (h *Hub) runSubscription(sub *subscription) {
	const (
		debounceInterval = 50 * time.Millisecond
		maxDebounceDelay = 500 * time.Millisecond
	)
	var (
		pendingEvents = make(map[string]ChangeType)
		timer         *time.Timer
		timerCh       <-chan time.Time
		firstEventAt  time.Time
	)

	subCtx, cancelSub := context.WithCancel(context.Background())
	defer cancelSub()
	go func() {
		<-sub.done
		cancelSub()
	}()

	flush := func() {
		if len(pendingEvents) == 0 {
			return
		}
		events := make([]FileEvent, 0, len(pendingEvents))
		for path, cType := range pendingEvents {
			events = append(events, FileEvent{Path: path, Type: cType})
		}
		pendingEvents = make(map[string]ChangeType)
		firstEventAt = time.Time{}
		sub.callback(sub.id, events)
	}

	for {
		select {
		case <-sub.done:
			if timer != nil {
				timer.Stop()
			}
			return

		case event, ok := <-sub.watcher.Events:
			if !ok {
				return
			}

			if sub.matcher.isIgnored(event.Name, sub.dirPath) {
				continue
			}

			var cType ChangeType
			switch {
			case event.Op&fsnotify.Create != 0:
				cType = ChangeCreate
				// Use Lstat to avoid recursively watching external symlinks
				if fi, err := os.Lstat(event.Name); err == nil && fi.IsDir() && (fi.Mode()&os.ModeSymlink == 0) {
					go func(dir string) {
						_ = h.addRecursive(subCtx, sub.watcher, dir, sub.dirPath, sub.matcher, sub.maxDirs, sub.timeout)
					}(event.Name)
				}
			case event.Op&fsnotify.Write != 0:
				cType = ChangeUpdate
			case event.Op&fsnotify.Remove != 0 || event.Op&fsnotify.Rename != 0:
				cType = ChangeDelete
			default:
				continue
			}

			pendingEvents[event.Name] = cType

			now := time.Now()
			if firstEventAt.IsZero() {
				firstEventAt = now
			}

			// If we reached maxDebounceDelay, flush immediately to prevent starvation
			if now.Sub(firstEventAt) >= maxDebounceDelay {
				if timer != nil {
					timer.Stop()
					timer = nil
					timerCh = nil
				}
				flush()
				continue
			}

			if timer == nil {
				timer = time.NewTimer(debounceInterval)
				timerCh = timer.C
			} else {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(debounceInterval)
			}

		case <-timerCh:
			flush()
			timer = nil
			timerCh = nil

		case _, ok := <-sub.watcher.Errors:
			if !ok {
				return
			}
		}
	}
}

// Close terminates all active watchers.
func (h *Hub) Close() {
	h.mu.Lock()
	subs := make([]*subscription, 0, len(h.subscriptions))
	for _, s := range h.subscriptions {
		subs = append(subs, s)
	}
	h.subscriptions = make(map[string]*subscription)
	h.mu.Unlock()

	for _, s := range subs {
		close(s.done)
		_ = s.watcher.Close()
	}
}
