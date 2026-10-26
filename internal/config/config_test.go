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

	// 5. Verify .vscode/settings.json preserved "editor.tabSize": 2 and standalone .jj-view/config.json received the new setting
	rawSettings, err := os.ReadFile(filepath.Join(vscodeDir, "settings.json"))
	if err != nil {
		t.Fatalf("failed to read settings.json: %v", err)
	}
	var parsedWS map[string]any
	if err := json.Unmarshal(stripJSONComments(rawSettings), &parsedWS); err != nil {
		t.Fatalf("failed to unmarshal settings.json: %v", err)
	}
	if parsedWS["editor.tabSize"] != float64(2) {
		t.Fatalf("expected editor.tabSize to be preserved, got %v", parsedWS["editor.tabSize"])
	}

	rawStandalone, err := os.ReadFile(filepath.Join(tempRepo, ".jj-view", "config.json"))
	if err != nil {
		t.Fatalf("failed to read .jj-view/config.json: %v", err)
	}
	var parsedStandalone map[string]any
	if err := json.Unmarshal(rawStandalone, &parsedStandalone); err != nil {
		t.Fatalf("failed to unmarshal .jj-view/config.json: %v", err)
	}
	if parsedStandalone["jj-view.newSetting"] != true {
		t.Fatalf("expected jj-view.newSetting in .jj-view/config.json, got %v", parsedStandalone["jj-view.newSetting"])
	}

	// 6. Delete workspace setting (removes from both .jj-view/config.json and .vscode/settings.json)
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

func TestConfigStoreMultiWorkspaceAndStandalonePrecedence(t *testing.T) {
	daemonCwd, err := os.MkdirTemp("", "jj-view-daemon-cwd")
	if err != nil {
		t.Fatalf("failed to create daemon cwd: %v", err)
	}
	defer os.RemoveAll(daemonCwd)

	userDir, err := os.MkdirTemp("", "jj-view-user-test")
	if err != nil {
		t.Fatalf("failed to create user dir: %v", err)
	}
	defer os.RemoveAll(userDir)

	// Workspace 1: has both .vscode/settings.json and .jj-view/config.json; .jj-view/config.json wins
	ws1Root, err := os.MkdirTemp("", "jj-view-ws1")
	if err != nil {
		t.Fatalf("failed to create ws1: %v", err)
	}
	defer os.RemoveAll(ws1Root)
	if err := os.MkdirAll(filepath.Join(ws1Root, ".vscode"), 0755); err != nil {
		t.Fatalf("failed to create ws1 .vscode: %v", err)
	}
	ws1Vscode := `{
  // Trailing comma test
  "jj-view.uploadCommand": "upload --from-vscode",
  "jj-view.onlyInVscode": "vscode-val",
}`
	if err := os.WriteFile(filepath.Join(ws1Root, ".vscode", "settings.json"), []byte(ws1Vscode), 0644); err != nil {
		t.Fatalf("failed to write ws1 settings.json: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(ws1Root, ".jj-view"), 0755); err != nil {
		t.Fatalf("failed to create ws1 .jj-view: %v", err)
	}
	ws1Standalone := `{
  "jj-view.uploadCommand": "upload -d --allow-warnings --parallel"
}`
	if err := os.WriteFile(filepath.Join(ws1Root, ".jj-view", "config.json"), []byte(ws1Standalone), 0644); err != nil {
		t.Fatalf("failed to write ws1 .jj-view/config.json: %v", err)
	}

	// Workspace 2: only has .jj-view/config.json (e.g. chromium_base/.jj-view/config.json)
	ws2Root, err := os.MkdirTemp("", "jj-view-chromium-base")
	if err != nil {
		t.Fatalf("failed to create ws2Root: %v", err)
	}
	defer os.RemoveAll(ws2Root)
	if err := os.MkdirAll(filepath.Join(ws2Root, ".jj-view"), 0755); err != nil {
		t.Fatalf("failed to create ws2Root .jj-view: %v", err)
	}
	ws2Standalone := `{"uploadCommand": "upload --standalone-only"}`
	if err := os.WriteFile(filepath.Join(ws2Root, ".jj-view", "config.json"), []byte(ws2Standalone), 0644); err != nil {
		t.Fatalf("failed to write ws2Root config.json: %v", err)
	}

	userConfigPath := filepath.Join(userDir, "config.json")
	store, err := NewStore(Options{
		UserConfigPath: userConfigPath,
		RepoRoot:       daemonCwd,
	})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Set user default uploadCommand = "upload"
	if err := store.SetScoped(string(ScopeUser), "uploadCommand", "upload"); err != nil {
		t.Fatalf("failed to set user uploadCommand: %v", err)
	}

	// Default daemonCwd has no workspace override -> returns user setting "upload"
	if val, ok := store.GetScopedForWorkspace(string(ScopeEffective), "uploadCommand", ""); !ok || val != "upload" {
		t.Fatalf("expected user 'upload' for daemonCwd, got %v (ok=%v)", val, ok)
	}

	// Workspace 1: .jj-view/config.json overrides .vscode/settings.json, while .vscode/settings.json still supplies onlyInVscode
	if val, ok := store.GetScopedForWorkspace(string(ScopeEffective), "uploadCommand", ws1Root); !ok || val != "upload -d --allow-warnings --parallel" {
		t.Fatalf("expected ws1 standalone override, got %v (ok=%v)", val, ok)
	}
	if val, ok := store.GetScopedForWorkspace(string(ScopeEffective), "onlyInVscode", ws1Root); !ok || val != "vscode-val" {
		t.Fatalf("expected ws1 vscode fallback key, got %v (ok=%v)", val, ok)
	}
	allWs1 := store.GetAllScopedForWorkspace(string(ScopeEffective), ws1Root)
	if allWs1["uploadCommand"] != "upload -d --allow-warnings --parallel" {
		t.Fatalf("expected ws1 GetAllScopedForWorkspace standalone override, got %v", allWs1["uploadCommand"])
	}
	if allWs1["onlyInVscode"] != "vscode-val" {
		t.Fatalf("expected ws1 GetAllScopedForWorkspace vscode fallback, got %v", allWs1["onlyInVscode"])
	}

	// Workspace 2 (standalone .jj-view/config.json only)
	if val, ok := store.GetScopedForWorkspace(string(ScopeEffective), "uploadCommand", ws2Root); !ok || val != "upload --standalone-only" {
		t.Fatalf("expected ws2 standalone override, got %v (ok=%v)", val, ok)
	}

	// Writing a workspace setting to ws2 updates ws2/.jj-view/config.json and not user config
	if err := store.SetScopedForWorkspace(string(ScopeWorkspace), "gitColocate", true, ws2Root); err != nil {
		t.Fatalf("SetScopedForWorkspace failed: %v", err)
	}
	if _, ok := store.GetScoped(string(ScopeUser), "gitColocate"); ok {
		t.Fatal("expected user config not to be modified by workspace write")
	}
	if val, ok := store.GetScopedForWorkspace(string(ScopeWorkspace), "gitColocate", ws2Root); !ok || val != true {
		t.Fatalf("expected ws2 gitColocate=true, got %v (ok=%v)", val, ok)
	}
}

func TestConfigStoreFourLayerPrecedenceAndInspect(t *testing.T) {
	wsRoot := t.TempDir()
	userDir := t.TempDir()

	userConfigPath := filepath.Join(userDir, "jj-view-config.json")
	vscodeUserPath := filepath.Join(userDir, "vscode-user-settings.json")

	// Layer 4: VS Code User settings.json
	vscodeUserJSON := `{
  // VS Code User settings
  "editor.fontSize": 14,
  "jj-view.uploadCommand": "upload --from-vscode-user",
  "jj-view.onlyInVscodeUser": "vscode-user-val"
}`
	if err := os.WriteFile(vscodeUserPath, []byte(vscodeUserJSON), 0644); err != nil {
		t.Fatalf("failed to write vscodeUserPath: %v", err)
	}

	// Layer 3: Standalone jj-view user config.json
	userJSON := `{
  "jj-view.uploadCommand": "upload --from-jj-user",
  "jj-view.onlyInJjUser": "jj-user-val"
}`
	if err := os.WriteFile(userConfigPath, []byte(userJSON), 0644); err != nil {
		t.Fatalf("failed to write userConfigPath: %v", err)
	}

	// Layer 2: VS Code Workspace .vscode/settings.json
	if err := os.MkdirAll(filepath.Join(wsRoot, ".vscode"), 0755); err != nil {
		t.Fatalf("failed to create .vscode: %v", err)
	}
	vscodeWsJSON := `{
  "jj-view.uploadCommand": "upload --from-vscode-ws",
  "jj-view.onlyInVscodeWs": "vscode-ws-val"
}`
	if err := os.WriteFile(filepath.Join(wsRoot, ".vscode", "settings.json"), []byte(vscodeWsJSON), 0644); err != nil {
		t.Fatalf("failed to write .vscode/settings.json: %v", err)
	}

	// Layer 1: Standalone jj-view Workspace .jj-view/config.json
	if err := os.MkdirAll(filepath.Join(wsRoot, ".jj-view"), 0755); err != nil {
		t.Fatalf("failed to create .jj-view: %v", err)
	}
	jjWsJSON := `{
  "jj-view.uploadCommand": "upload --from-jj-ws"
}`
	if err := os.WriteFile(filepath.Join(wsRoot, ".jj-view", "config.json"), []byte(jjWsJSON), 0644); err != nil {
		t.Fatalf("failed to write .jj-view/config.json: %v", err)
	}

	store, err := NewStore(Options{
		UserConfigPath:       userConfigPath,
		VscodeUserConfigPath: vscodeUserPath,
		RepoRoot:             wsRoot,
	})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Inspect uploadCommand across all 4 layers
	insp := store.InspectForWorkspace("uploadCommand", wsRoot)
	if !insp.Found || insp.EffectiveSource != ScopeWorkspace || insp.EffectiveValue != "upload --from-jj-ws" {
		t.Fatalf("expected effective from workspace, got %+v", insp)
	}
	if !insp.HasWorkspace || insp.WorkspaceValue != "upload --from-jj-ws" {
		t.Fatalf("expected workspace value, got %+v", insp)
	}
	if !insp.HasVscodeWorkspace || insp.VscodeWorkspaceValue != "upload --from-vscode-ws" {
		t.Fatalf("expected vscode-workspace value, got %+v", insp)
	}
	if !insp.HasUser || insp.UserValue != "upload --from-jj-user" {
		t.Fatalf("expected user value, got %+v", insp)
	}
	if !insp.HasVscodeUser || insp.VscodeUserValue != "upload --from-vscode-user" {
		t.Fatalf("expected vscode-user value, got %+v", insp)
	}

	// Verify fallback through each layer
	if inspWs := store.InspectForWorkspace("onlyInVscodeWs", wsRoot); inspWs.EffectiveSource != ScopeVscodeWorkspace || inspWs.EffectiveValue != "vscode-ws-val" {
		t.Fatalf("expected vscode-workspace fallback, got %+v", inspWs)
	}
	if inspUser := store.InspectForWorkspace("onlyInJjUser", wsRoot); inspUser.EffectiveSource != ScopeUser || inspUser.EffectiveValue != "jj-user-val" {
		t.Fatalf("expected user fallback, got %+v", inspUser)
	}
	if inspVsUser := store.InspectForWorkspace("onlyInVscodeUser", wsRoot); inspVsUser.EffectiveSource != ScopeVscodeUser || inspVsUser.EffectiveValue != "vscode-user-val" {
		t.Fatalf("expected vscode-user fallback, got %+v", inspVsUser)
	}
}

