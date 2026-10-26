// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigCLISubcommands(t *testing.T) {
	wsDir := t.TempDir()
	userDir := t.TempDir()
	userConfig := filepath.Join(userDir, "jj-view-user.json")
	vscodeUserConfig := filepath.Join(userDir, "vscode-user.json")

	// Seed VS Code user settings and VS Code workspace settings
	if err := os.WriteFile(vscodeUserConfig, []byte(`{
  "jj-view.uploadCommand": "upload --vscode-user",
  "jj-view.logBatchSize": 100
}`), 0644); err != nil {
		t.Fatalf("failed to write vscodeUserConfig: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(wsDir, ".vscode"), 0755); err != nil {
		t.Fatalf("failed to create .vscode: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wsDir, ".vscode", "settings.json"), []byte(`{
  "jj-view.uploadCommand": "upload --vscode-ws"
}`), 0644); err != nil {
		t.Fatalf("failed to write .vscode/settings.json: %v", err)
	}

	baseFlags := []string{
		"--workspace", wsDir,
		"--user-config", userConfig,
		"--vscode-user-config", vscodeUserConfig,
	}

	run := func(args ...string) (string, string, error) {
		var stdout, stderr bytes.Buffer
		fullArgs := append(args, baseFlags...)
		err := runConfigCommand(fullArgs, &stdout, &stderr)
		return stdout.String(), stderr.String(), err
	}

	// 1. `get` should return vscode-workspace value when standalone workspace config is not set
	out, _, err := run("get", "uploadCommand", "--show-origin")
	if err != nil {
		t.Fatalf("config get failed: %v", err)
	}
	if !strings.HasPrefix(out, "vscode-workspace\t") || !strings.HasSuffix(strings.TrimSpace(out), "upload --vscode-ws") {
		t.Fatalf("unexpected get --show-origin output: %q", out)
	}

	// 2. `set` in workspace scope writes to .jj-view/config.json and overrides .vscode/settings.json
	out, _, err = run("set", "uploadCommand", "upload -d --allow-warnings --parallel", "--scope", "workspace")
	if err != nil {
		t.Fatalf("config set workspace failed: %v", err)
	}
	wantWsConfig := filepath.Join(".jj-view", "config.json")
	if !strings.Contains(out, wantWsConfig) {
		t.Fatalf("expected %s in set output, got: %q", wantWsConfig, out)
	}

	// 3. `inspect` shows all 4 layers and marks workspace as [active]
	out, _, err = run("inspect", "uploadCommand")
	if err != nil {
		t.Fatalf("config inspect failed: %v", err)
	}
	for _, want := range []string{
		`Effective: "upload -d --allow-warnings --parallel" (from workspace:`,
		`1. workspace (jj-view):       "upload -d --allow-warnings --parallel"  [active]`,
		`2. vscode-workspace (VS Code): "upload --vscode-ws"  [overridden]`,
		`3. user (jj-view):            <not set>`,
		`4. vscode-user (VS Code):     "upload --vscode-user"  [overridden]`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("inspect output missing %q:\n%s", want, out)
		}
	}

	// 4. `list` shows each effective key and its origin layer
	out, _, err = run("list")
	if err != nil {
		t.Fatalf("config list failed: %v", err)
	}
	if !strings.Contains(out, `jj-view.uploadCommand = "upload -d --allow-warnings --parallel"  [workspace:`) {
		t.Fatalf("unexpected list output for uploadCommand:\n%s", out)
	}
	if !strings.Contains(out, `jj-view.logBatchSize = 100  [vscode-user:`) {
		t.Fatalf("unexpected list output for logBatchSize:\n%s", out)
	}

	// 5. `unset` in workspace scope removes from both .jj-view/config.json and .vscode/settings.json, falling back to vscode-user
	if _, _, err := run("unset", "uploadCommand", "--scope", "workspace"); err != nil {
		t.Fatalf("config unset failed: %v", err)
	}
	out, _, err = run("get", "uploadCommand", "--show-origin")
	if err != nil {
		t.Fatalf("config get after unset failed: %v", err)
	}
	if !strings.HasPrefix(out, "vscode-user\t") || !strings.HasSuffix(strings.TrimSpace(out), "upload --vscode-user") {
		t.Fatalf("expected fallback to vscode-user after workspace unset, got: %q", out)
	}

	// 6. `paths` lists all 4 layers in precedence order
	out, _, err = run("paths")
	if err != nil {
		t.Fatalf("config paths failed: %v", err)
	}
	for _, want := range []string{
		"1. workspace (jj-view):",
		"2. vscode-workspace (VS Code):",
		"3. user (jj-view):",
		"4. vscode-user (VS Code):",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("paths output missing %q:\n%s", want, out)
		}
	}
}
