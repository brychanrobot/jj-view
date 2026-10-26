// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package watcher

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWatcherMaxDirsLimit(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "jj-view-watcher-limit-test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	for i := 0; i < 6; i++ {
		if err := os.MkdirAll(filepath.Join(tempDir, fmt.Sprintf("dir-%d", i)), 0755); err != nil {
			t.Fatalf("failed to create subdir: %v", err)
		}
	}

	hub := NewHub()
	defer hub.Close()

	_, err = hub.Watch(tempDir, WatchOptions{
		MaxDirs: 3,
	}, func(subID string, events []FileEvent) {})
	if !errors.Is(err, ErrWatchLimitExceeded) {
		t.Fatalf("expected ErrWatchLimitExceeded when directory count exceeds MaxDirs, got: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = hub.Watch(tempDir, WatchOptions{
		Context: ctx,
	}, func(subID string, events []FileEvent) {})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled when context is already canceled, got: %v", err)
	}
}

func TestIgnoreMatcherPatterns(t *testing.T) {
	matcher := newIgnoreMatcher([]string{
		"**/build/**",
		"/custom-out/",
		"packages/ignored-ws",
		"**/*.tmp",
	})

	root := "/repo"
	if !matcher.isIgnored("/repo/a/b/build", root) {
		t.Error("expected /repo/a/b/build to match **/build/**")
	}
	if !matcher.isIgnored("/repo/a/b/build/output.js", root) {
		t.Error("expected /repo/a/b/build/output.js to match **/build/**")
	}
	if !matcher.isIgnored("/repo/custom-out/file.txt", root) {
		t.Error("expected /repo/custom-out/file.txt to match /custom-out/")
	}
	if !matcher.isIgnored("/repo/packages/ignored-ws/src/index.ts", root) {
		t.Error("expected /repo/packages/ignored-ws/src/index.ts to match packages/ignored-ws")
	}
	if !matcher.isIgnored("/repo/deep/nested/file.tmp", root) {
		t.Error("expected /repo/deep/nested/file.tmp to match **/*.tmp")
	}
	if matcher.isIgnored("/repo/packages/active-ws/src/index.ts", root) {
		t.Error("did not expect /repo/packages/active-ws/src/index.ts to be ignored")
	}
}

func TestWatcherHub(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "jj-view-watcher-test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	hub := NewHub()
	defer hub.Close()

	eventsCh := make(chan []FileEvent, 10)

	subID, err := hub.Watch(tempDir, WatchOptions{
		Ignore: []string{"ignored-dir/**", "*.ignored"},
	}, func(subID string, events []FileEvent) {
		eventsCh <- events
	})
	if err != nil {
		t.Fatalf("hub.Watch failed: %v", err)
	}

	// Wait for watcher to initialize
	time.Sleep(50 * time.Millisecond)

	// 1. Create a regular file
	regularFile := filepath.Join(tempDir, "sample.txt")
	if err := os.WriteFile(regularFile, []byte("content"), 0644); err != nil {
		t.Fatalf("failed to write sample file: %v", err)
	}

	select {
	case events := <-eventsCh:
		if len(events) == 0 {
			t.Fatal("received empty events slice")
		}
		found := false
		for _, e := range events {
			if filepath.Base(e.Path) == "sample.txt" {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("sample.txt event not found in: %+v", events)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for file creation event")
	}

	// 2. Write to an ignored file pattern
	ignoredFile := filepath.Join(tempDir, "file.ignored")
	if err := os.WriteFile(ignoredFile, []byte("ignored"), 0644); err != nil {
		t.Fatalf("failed to write ignored file: %v", err)
	}

	select {
	case events := <-eventsCh:
		for _, e := range events {
			if filepath.Base(e.Path) == "file.ignored" {
				t.Fatalf("expected file.ignored to be ignored, but received event: %+v", e)
			}
		}
	case <-time.After(200 * time.Millisecond):
		// Success: no event received for ignored file
	}

	// 3. Unwatch
	hub.Unwatch(subID)

	// Write again, no events should be received
	_ = os.WriteFile(filepath.Join(tempDir, "after-unwatch.txt"), []byte("data"), 0644)
	select {
	case events := <-eventsCh:
		t.Fatalf("unexpected events after unwatch: %+v", events)
	case <-time.After(200 * time.Millisecond):
		// Success
	}
}
