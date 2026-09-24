// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestConfigStoreUser(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "jj-view-config-test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	configPath := filepath.Join(tempDir, "config.json")
	store, err := NewStore(Options{UserConfigPath: configPath})
	if err != nil {
		t.Fatalf("failed to create config store: %v", err)
	}
	defer store.Close()

	// 1. Initial empty
	_, found := store.Get("key1")
	if found {
		t.Fatal("expected key1 not found")
	}

	// 2. Set value
	if err := store.Set("key1", "val1"); err != nil {
		t.Fatalf("Set failed: %v", err)
	}
	val, found := store.Get("key1")
	if !found || val != "val1" {
		t.Fatalf("expected val1, got %v", val)
	}

	// 3. Set another value
	if err := store.Set("num", float64(42)); err != nil {
		t.Fatalf("Set failed: %v", err)
	}

	all := store.GetAll()
	if all["key1"] != "val1" || all["num"] != float64(42) {
		t.Fatalf("unexpected GetAll result: %+v", all)
	}

	// 4. Persistence check: load in a new store instance
	store2, err := NewStore(Options{UserConfigPath: configPath})
	if err != nil {
		t.Fatalf("failed to reload store: %v", err)
	}
	defer store2.Close()

	val2, found2 := store2.Get("key1")
	if !found2 || val2 != "val1" {
		t.Fatalf("expected persisted val1, got %v", val2)
	}

	// 5. Delete key (Set to nil)
	if err := store.Set("key1", nil); err != nil {
		t.Fatalf("Set nil failed: %v", err)
	}
	_, foundAfterDelete := store.Get("key1")
	if foundAfterDelete {
		t.Fatal("expected key1 to be deleted")
	}
}

func TestConfigStoreWorkspacePrecedence(t *testing.T) {
	tempRepo, err := os.MkdirTemp("", "jj-view-ws-test")
	if err != nil {
		t.Fatalf("failed to create temp repo: %v", err)
	}
	defer os.RemoveAll(tempRepo)

	userDir, err := os.MkdirTemp("", "jj-view-user-test")
	if err != nil {
		t.Fatalf("failed to create user dir: %v", err)
	}
	defer os.RemoveAll(userDir)

	userConfigPath := filepath.Join(userDir, "config.json")
	vscodeDir := filepath.Join(tempRepo, ".vscode")
	if err := os.MkdirAll(vscodeDir, 0755); err != nil {
		t.Fatalf("failed to create .vscode: %v", err)
	}

	// Create initial .vscode/settings.json with an existing unrelated setting and a comment
	initialSettings := `// VS Code settings file
{
  /* editor indentation */
  "editor.tabSize": 2,
  "jj-view.logTheme": "workspace-theme"
}`
	if err := os.WriteFile(filepath.Join(vscodeDir, "settings.json"), []byte(initialSettings), 0644); err != nil {
		t.Fatalf("failed to write settings.json: %v", err)
	}

	store, err := NewStore(Options{
		UserConfigPath: userConfigPath,
		RepoRoot:       tempRepo,
	})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Set user-level config for logTheme
	if err := store.SetScoped(string(ScopeUser), "logTheme", "user-theme"); err != nil {
		t.Fatalf("failed to set user config: %v", err)
	}
	if err := store.SetScoped(string(ScopeUser), "onlyInUser", "hello"); err != nil {
		t.Fatalf("failed to set user config: %v", err)
	}

	// 1. Effective Get("logTheme") should return "workspace-theme" (precedence)
	val, found := store.Get("logTheme")
	if !found || val != "workspace-theme" {
		t.Fatalf("expected workspace-theme, got %v (found: %v)", val, found)
	}

	// 2. Querying with jj-view. prefix should also resolve
	valPrefixed, foundPrefixed := store.Get("jj-view.logTheme")
	if !foundPrefixed || valPrefixed != "workspace-theme" {
		t.Fatalf("expected workspace-theme with prefix, got %v", valPrefixed)
	}

	// 3. User scoped lookup should return user-theme
	userVal, userFound := store.GetScoped(string(ScopeUser), "logTheme")
	if !userFound || userVal != "user-theme" {
		t.Fatalf("expected user-theme, got %v", userVal)
	}

	// 4. Setting workspace value
	if err := store.SetScoped(string(ScopeWorkspace), "newSetting", true); err != nil {
		t.Fatalf("failed to set workspace setting: %v", err)
	}
	wsVal, wsFound := store.Get("newSetting")
	if !wsFound || wsVal != true {
		t.Fatalf("expected true, got %v", wsVal)
	}

	// 5. Verify .vscode/settings.json preserved "editor.tabSize": 2
	rawSettings, err := os.ReadFile(filepath.Join(vscodeDir, "settings.json"))
	if err != nil {
		t.Fatalf("failed to read settings.json: %v", err)
	}
	var parsedWS map[string]any
	if err := json.Unmarshal(rawSettings, &parsedWS); err != nil {
		t.Fatalf("failed to unmarshal settings.json: %v", err)
	}
	if parsedWS["editor.tabSize"] != float64(2) {
		t.Fatalf("expected editor.tabSize to be preserved, got %v", parsedWS["editor.tabSize"])
	}
	if parsedWS["jj-view.newSetting"] != true {
		t.Fatalf("expected jj-view.newSetting in file, got %v", parsedWS["jj-view.newSetting"])
	}

	// 6. Delete workspace setting
	if err := store.SetScoped(string(ScopeWorkspace), "logTheme", nil); err != nil {
		t.Fatalf("failed to delete workspace setting: %v", err)
	}
	// After deletion in workspace, effective value should fallback to user-theme!
	fallbackVal, fallbackFound := store.Get("logTheme")
	if !fallbackFound || fallbackVal != "user-theme" {
		t.Fatalf("expected fallback to user-theme, got %v", fallbackVal)
	}
}

func TestConfigStoreWatcher(t *testing.T) {
	tempRepo, err := os.MkdirTemp("", "jj-view-watcher-test")
	if err != nil {
		t.Fatalf("failed to create temp repo: %v", err)
	}
	defer os.RemoveAll(tempRepo)

	userDir, err := os.MkdirTemp("", "jj-view-user-test")
	if err != nil {
		t.Fatalf("failed to create user dir: %v", err)
	}
	defer os.RemoveAll(userDir)

	userConfigPath := filepath.Join(userDir, "config.json")
	vscodeDir := filepath.Join(tempRepo, ".vscode")
	_ = os.MkdirAll(vscodeDir, 0755)
	wsConfigPath := filepath.Join(vscodeDir, "settings.json")

	var changeMu sync.Mutex
	changedScopes := make([]string, 0)
	changeCh := make(chan string, 10)

	store, err := NewStore(Options{
		UserConfigPath: userConfigPath,
		RepoRoot:       tempRepo,
		OnChange: func(key string, scope string) {
			changeMu.Lock()
			changedScopes = append(changedScopes, scope)
			changeMu.Unlock()
			select {
			case changeCh <- scope:
			default:
			}
		},
	})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// External write to .vscode/settings.json
	externalJSON := `{"jj-view.externalKey": "externalVal"}`
	if err := os.WriteFile(wsConfigPath, []byte(externalJSON), 0644); err != nil {
		t.Fatalf("failed to write external settings: %v", err)
	}

	select {
	case scope := <-changeCh:
		if scope != string(ScopeWorkspace) {
			t.Fatalf("expected workspace scope, got %s", scope)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for workspace config change event")
	}

	// Check that value was loaded into store
	val, found := store.Get("externalKey")
	if !found || val != "externalVal" {
		t.Fatalf("expected externalVal from disk, got %v", val)
	}
}
