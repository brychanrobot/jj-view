// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunInstallAntigravityPlugin(t *testing.T) {
	tempDir := t.TempDir()
	configDir := filepath.Join(tempDir, "config")
	fakeBinary := filepath.Join(tempDir, "fake-jj-view")
	if err := os.WriteFile(fakeBinary, []byte("#!/bin/sh\nexit 0"), 0755); err != nil {
		t.Fatalf("failed to create fake binary: %v", err)
	}

	args := []string{
		"--config-dir", configDir,
		"--binary-path", fakeBinary,
		"--no-restart",
	}

	if err := runInstallAntigravityPlugin(args); err != nil {
		t.Fatalf("runInstallAntigravityPlugin failed: %v", err)
	}

	// 1. Verify plugin manifest
	pluginManifestPath := filepath.Join(configDir, "plugins", "jj-view", "plugin.json")
	pData, err := os.ReadFile(pluginManifestPath)
	if err != nil {
		t.Fatalf("missing plugin.json: %v", err)
	}
	var pManifest map[string]any
	if err := json.Unmarshal(pData, &pManifest); err != nil {
		t.Fatalf("invalid plugin.json: %v", err)
	}
	if pManifest["logo"] != "assets/icon.svg" {
		t.Errorf("expected logo 'assets/icon.svg', got %v", pManifest["logo"])
	}

	// 2. Verify icon asset exists
	iconPath := filepath.Join(configDir, "plugins", "jj-view", "assets", "icon.svg")
	iconData, err := os.ReadFile(iconPath)
	if err != nil {
		t.Fatalf("missing icon.svg: %v", err)
	}
	if !strings.Contains(string(iconData), "<svg") || !strings.Contains(string(iconData), "#007acc") {
		t.Errorf("unexpected icon content: %s", string(iconData))
	}

	// 3. Verify sidecar.json
	sidecarPath := filepath.Join(configDir, "plugins", "jj-view", "sidecars", "jj-view", "sidecar.json")
	sData, err := os.ReadFile(sidecarPath)
	if err != nil {
		t.Fatalf("missing sidecar.json: %v", err)
	}
	var sManifest map[string]any
	if err := json.Unmarshal(sData, &sManifest); err != nil {
		t.Fatalf("invalid sidecar.json: %v", err)
	}
	if sManifest["command"] != fakeBinary {
		t.Errorf("expected command %s, got %v", fakeBinary, sManifest["command"])
	}
	if sManifest["display_name"] != "jj view" {
		t.Errorf("expected display_name 'jj view', got %v", sManifest["display_name"])
	}
	if got := fmt.Sprint(sManifest["args"]); got != "[--host 127.0.0.1 --no-open]" {
		t.Errorf("unexpected sidecar args: %s", got)
	}

	// Verify legacy loose sidecar was cleaned up
	legacySidecarDir := filepath.Join(configDir, "sidecars", "jj-view")
	if _, err := os.Stat(legacySidecarDir); !os.IsNotExist(err) {
		t.Errorf("expected legacy sidecar directory %s to be deleted", legacySidecarDir)
	}

	// 4. Verify config.json
	configJsonPath := filepath.Join(configDir, "config.json")
	cData, err := os.ReadFile(configJsonPath)
	if err != nil {
		t.Fatalf("missing config.json: %v", err)
	}
	var cManifest map[string]any
	if err := json.Unmarshal(cData, &cManifest); err != nil {
		t.Fatalf("invalid config.json: %v", err)
	}

	plugins, ok := cManifest["plugins"].(map[string]any)
	if !ok || plugins["jj-view"] == nil {
		t.Errorf("expected jj-view under plugins in config.json")
	}

	sidecars, ok := cManifest["sidecars"].(map[string]any)
	if ok && sidecars["jj-view"] != nil {
		t.Errorf("expected legacy jj-view to be removed from sidecars in config.json")
	}
}
