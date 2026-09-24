// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package watcher

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

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
	Ignore []string `json:"ignore,omitempty"`
}

// CallbackFunc is invoked when filesystem changes occur.
type CallbackFunc func(subID string, events []FileEvent)

type subscription struct {
	id       string
	dirPath  string
	ignores  []string
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

	sub := &subscription{
		id:       subID,
		dirPath:  absDir,
		ignores:  opts.Ignore,
		callback: callback,
		done:     make(chan struct{}),
		watcher:  fsw,
	}

	// Add directories recursively, skipping ignored paths
	if err := h.addRecursive(fsw, absDir, opts.Ignore); err != nil {
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

func (h *Hub) isIgnored(path string, root string, ignores []string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	relSlash := filepath.ToSlash(rel)

	parts := strings.Split(relSlash, "/")
	for _, part := range parts {
		if part == ".jj" || part == ".git" || part == "node_modules" || part == ".vscode-test" || part == "dist" || part == "out" {
			return true
		}
	}

	for _, pattern := range ignores {
		cleanPat := filepath.ToSlash(pattern)

		// Support globstar **
		if strings.HasSuffix(cleanPat, "/**") {
			prefix := strings.TrimSuffix(cleanPat, "/**")
			if relSlash == prefix || strings.HasPrefix(relSlash, prefix+"/") {
				return true
			}
		}

		matched, _ := filepath.Match(cleanPat, relSlash)
		if matched {
			return true
		}
		matchedBase, _ := filepath.Match(cleanPat, filepath.Base(path))
		if matchedBase {
			return true
		}
	}
	return false
}

func (h *Hub) addRecursive(w *fsnotify.Watcher, root string, ignores []string) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // Skip inaccessible directories
		}
		if !d.IsDir() {
			return nil
		}

		if path != root && h.isIgnored(path, root, ignores) {
			return filepath.SkipDir
		}

		_ = w.Add(path)
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

			if h.isIgnored(event.Name, sub.dirPath, sub.ignores) {
				continue
			}

			var cType ChangeType
			switch {
			case event.Op&fsnotify.Create != 0:
				cType = ChangeCreate
				// Use Lstat to avoid recursively watching external symlinks
				if fi, err := os.Lstat(event.Name); err == nil && fi.IsDir() && (fi.Mode()&os.ModeSymlink == 0) {
					_ = h.addRecursive(sub.watcher, event.Name, sub.ignores)
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
