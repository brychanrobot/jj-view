// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package secret

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

func TestSecretPermissionsAndIsolation(t *testing.T) {
	tempDir := t.TempDir()
	secretDir := filepath.Join(tempDir, "secrets")
	secretFile := filepath.Join(secretDir, "credentials.json")

	store, err := NewStore(Options{Path: secretFile})
	if err != nil {
		t.Fatalf("failed to create secret store: %v", err)
	}

	if err := store.Store("pat", "secret_token_123"); err != nil {
		t.Fatalf("failed to store secret: %v", err)
	}

	val, ok := store.Get("pat")
	if !ok || val != "secret_token_123" {
		t.Fatalf("expected secret_token_123, got %s (ok=%v)", val, ok)
	}

	if runtime.GOOS != "windows" {
		fi, err := os.Stat(secretFile)
		if err != nil {
			t.Fatalf("stat failed: %v", err)
		}
		if perm := fi.Mode().Perm(); perm != 0600 {
			t.Fatalf("expected file permission 0600, got %#o", perm)
		}

		di, err := os.Stat(secretDir)
		if err != nil {
			t.Fatalf("stat dir failed: %v", err)
		}
		if perm := di.Mode().Perm(); perm != 0700 {
			t.Fatalf("expected dir permission 0700, got %#o", perm)
		}
	}
}

func TestSecretCRUD(t *testing.T) {
	tempDir := t.TempDir()
	secretFile := filepath.Join(tempDir, "credentials.json")

	var changes []string
	var mu sync.Mutex
	store, err := NewStore(Options{
		Path: secretFile,
		OnChange: func(key, action string) {
			mu.Lock()
			changes = append(changes, fmt.Sprintf("%s:%s", key, action))
			mu.Unlock()
		},
	})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}

	// Store
	if err := store.Store("github_token", "ghp_abc"); err != nil {
		t.Fatalf("store failed: %v", err)
	}
	if v, ok := store.Get("github_token"); !ok || v != "ghp_abc" {
		t.Fatalf("unexpected get: %s, %v", v, ok)
	}

	// Delete
	if err := store.Delete("github_token"); err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	if _, ok := store.Get("github_token"); ok {
		t.Fatalf("expected token to be deleted")
	}

	// Reopen store from disk
	store2, err := NewStore(Options{Path: secretFile})
	if err != nil {
		t.Fatalf("failed to reload store: %v", err)
	}
	if _, ok := store2.Get("github_token"); ok {
		t.Fatalf("expected token to stay deleted on reload")
	}
}

func TestSecretConcurrencyRace(t *testing.T) {
	tempDir := t.TempDir()
	store, err := NewStore(Options{Path: filepath.Join(tempDir, "credentials.json")})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}

	var wg sync.WaitGroup
	workers := 20
	iterations := 20

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				key := fmt.Sprintf("key-%d", j%4)
				val := fmt.Sprintf("token-%d-%d", workerID, j)
				_ = store.Store(key, val)
				_, _ = store.Get(key)
			}
		}(i)
	}

	wg.Wait()
}

func TestSecretCorruptRecovery(t *testing.T) {
	tempDir := t.TempDir()
	secretFile := filepath.Join(tempDir, "credentials.json")

	// Seed corrupt JSON
	_ = os.WriteFile(secretFile, []byte(`{"token": "incompl`), 0600)

	store, err := NewStore(Options{Path: secretFile})
	if err != nil {
		t.Fatalf("NewStore should recover from corrupt file, got: %v", err)
	}

	if len(store.GetAll()) != 0 {
		t.Fatalf("expected empty store, got: %+v", store.GetAll())
	}

	// Able to store after recovery
	if err := store.Store("token", "val"); err != nil {
		t.Fatalf("store after recovery failed: %v", err)
	}
}

func TestDefaultSecretPathHonorsEnv(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tempDir)

	path, err := DefaultSecretPath()
	if err != nil {
		t.Fatalf("DefaultSecretPath failed: %v", err)
	}

	expectedPrefix := tempDir
	if len(path) < len(expectedPrefix) || path[:len(expectedPrefix)] != expectedPrefix {
		t.Fatalf("expected path to start with %s, got %s", expectedPrefix, path)
	}
}
