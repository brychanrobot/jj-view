// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestStateIsolation(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "state.json")

	store, err := NewStore(Options{Path: stateFile})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}

	rawVal := json.RawMessage(`"testVal"`)
	if err := store.Set("testKey", rawVal); err != nil {
		t.Fatalf("set failed: %v", err)
	}

	val, ok := store.Get("testKey")
	if !ok || string(val) != `"testVal"` {
		t.Fatalf("expected testVal, got %s (ok=%v)", string(val), ok)
	}

	// Verify file was written to tempDir and nowhere else
	if _, err := os.Stat(stateFile); os.IsNotExist(err) {
		t.Fatalf("state.json was not created in tempDir")
	}
}

func TestStateConcurrencyRace(t *testing.T) {
	tempDir := t.TempDir()
	store, err := NewStore(Options{Path: filepath.Join(tempDir, "state.json")})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}

	var wg sync.WaitGroup
	workers := 25
	iterations := 20

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				key := fmt.Sprintf("key-%d", j%5)
				val := json.RawMessage(fmt.Sprintf(`{"worker":%d,"iter":%d}`, workerID, j))
				_ = store.Set(key, val)
				_, _ = store.Get(key)
				_ = store.GetAll()
			}
		}(i)
	}

	wg.Wait()

	// Verify file integrity on disk
	raw, err := os.ReadFile(filepath.Join(tempDir, "state.json"))
	if err != nil {
		t.Fatalf("failed to read state file: %v", err)
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("state file contains invalid JSON: %v", err)
	}
}

func TestStateCorruptRecovery(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "state.json")

	// Seed corrupt JSON
	_ = os.WriteFile(stateFile, []byte(`{"key": "incomplete`), 0600)

	store, err := NewStore(Options{Path: stateFile})
	if err != nil {
		t.Fatalf("NewStore should recover from corrupt file, got err: %v", err)
	}

	// Store should be empty
	if len(store.GetAll()) != 0 {
		t.Fatalf("expected empty store, got: %+v", store.GetAll())
	}

	// Should be able to write valid state
	if err := store.Set("recovered", json.RawMessage(`true`)); err != nil {
		t.Fatalf("failed to set key after recovery: %v", err)
	}

	val, ok := store.Get("recovered")
	if !ok || string(val) != `true` {
		t.Fatalf("expected true, got %s (ok=%v)", string(val), ok)
	}
}

func TestStateZeroByteFile(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "state.json")

	// Seed 0-byte file
	_ = os.WriteFile(stateFile, []byte{}, 0600)

	store, err := NewStore(Options{Path: stateFile})
	if err != nil {
		t.Fatalf("NewStore should handle 0-byte file cleanly, got err: %v", err)
	}

	if len(store.GetAll()) != 0 {
		t.Fatalf("expected empty store, got: %+v", store.GetAll())
	}
}

func TestStateDeletion(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "state.json")

	store, err := NewStore(Options{Path: stateFile})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}

	_ = store.Set("toDelete", json.RawMessage(`"hello"`))
	if _, ok := store.Get("toDelete"); !ok {
		t.Fatalf("expected toDelete to exist")
	}

	if err := store.Delete("toDelete"); err != nil {
		t.Fatalf("delete failed: %v", err)
	}

	if _, ok := store.Get("toDelete"); ok {
		t.Fatalf("expected toDelete to be removed")
	}

	// Setting null also deletes
	_ = store.Set("another", json.RawMessage(`123`))
	_ = store.Set("another", json.RawMessage(`null`))
	if _, ok := store.Get("another"); ok {
		t.Fatalf("expected another to be removed by null")
	}
}

func TestDefaultStatePathHonorsEnv(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("XDG_STATE_HOME", tempDir)

	path, err := DefaultStatePath()
	if err != nil {
		t.Fatalf("DefaultStatePath failed: %v", err)
	}

	expectedPrefix := tempDir
	if len(path) < len(expectedPrefix) || path[:len(expectedPrefix)] != expectedPrefix {
		t.Fatalf("expected path to start with %s, got %s", expectedPrefix, path)
	}
}
