// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package watcher

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

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
