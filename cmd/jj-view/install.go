// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const scmIconSVG = `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path fill="#007acc" d="M21 8.25C21 6.1815 19.3185 4.5 17.25 4.5C15.1815 4.5 13.5 6.1815 13.5 8.25C13.5 10.023 14.739 11.5035 16.395 11.892C16.116 12.819 15.2655 13.5 14.25 13.5H9.75C8.9025 13.5 8.1285 13.7925 7.5 14.268V7.4235C9.21 7.0755 10.5 5.5605 10.5 3.75C10.5 1.6815 8.8185 0 6.75 0C4.6815 0 3 1.6815 3 3.75C3 5.562 4.29 7.0755 6 7.4235V16.575C4.29 16.923 3 18.438 3 20.2485C3 22.317 4.6815 23.9985 6.75 23.9985C8.8185 23.9985 10.5 22.317 10.5 20.2485C10.5 18.4755 9.261 16.995 7.605 16.6065C7.884 15.6795 8.7345 14.9985 9.75 14.9985H14.25C16.0845 14.9985 17.61 13.6725 17.931 11.9295C19.674 11.607 21 10.0845 21 8.25ZM4.5 3.75C4.5 2.5095 5.5095 1.5 6.75 1.5C7.9905 1.5 9 2.5095 9 3.75C9 4.9905 7.9905 6 6.75 6C5.5095 6 4.5 4.9905 4.5 3.75ZM9 20.25C9 21.4905 7.9905 22.5 6.75 22.5C5.5095 22.5 4.5 21.4905 4.5 20.25C4.5 19.0095 5.5095 18 6.75 18C7.9905 18 9 19.0095 9 20.25ZM17.25 10.5C16.0095 10.5 15 9.4905 15 8.25C15 7.0095 16.0095 6 17.25 6C18.4905 6 19.5 7.0095 19.5 8.25C19.5 9.4905 18.4905 10.5 17.25 10.5Z"/>
</svg>
`

type installOptions struct {
	configDir  string
	binaryPath string
	noRestart  bool
}

func parseInstallAntigravityPluginFlags(args []string) (*installOptions, error) {
	fs := flag.NewFlagSet(installAntigravityPluginCommand, flag.ContinueOnError)
	configDirFlag := fs.String("config-dir", "", "Path to global Antigravity config directory (defaults to ~/.gemini/config)")
	binaryPathFlag := fs.String("binary-path", "", "Path to jj-view executable (defaults to current binary)")
	noRestartFlag := fs.Bool("no-restart", false, "Do not restart daemons currently running from the installed binary")
	fs.Usage = func() {
		printUsage(fs, "jj-view "+installAntigravityPluginCommand+" [flags]",
			"Install JJ View as an Antigravity plugin and restart running daemons.", "")
	}

	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	opts := &installOptions{
		configDir:  *configDirFlag,
		binaryPath: *binaryPathFlag,
		noRestart:  *noRestartFlag,
	}

	if opts.binaryPath == "" {
		execPath, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("failed to determine executable path: %w", err)
		}
		absExec, err := filepath.Abs(execPath)
		if err != nil {
			return nil, fmt.Errorf("failed to resolve absolute executable path: %w", err)
		}
		opts.binaryPath = absExec
	} else {
		absPath, err := filepath.Abs(opts.binaryPath)
		if err != nil {
			return nil, fmt.Errorf("invalid binary path: %w", err)
		}
		opts.binaryPath = absPath
	}

	if opts.configDir == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("failed to determine user home directory: %w", err)
		}
		opts.configDir = filepath.Join(homeDir, ".gemini", "config")
	} else {
		absDir, err := filepath.Abs(opts.configDir)
		if err != nil {
			return nil, fmt.Errorf("invalid config directory: %w", err)
		}
		opts.configDir = absDir
	}

	return opts, nil
}

func runInstallAntigravityPlugin(args []string) error {
	opts, err := parseInstallAntigravityPluginFlags(args)
	if err != nil {
		return err
	}

	fmt.Printf("[Install] Configuring JJ View sidecar & plugin...\n")
	fmt.Printf("[Install] Binary: %s\n", opts.binaryPath)
	fmt.Printf("[Install] Config: %s\n", opts.configDir)

	// 1. Install Plugin Bundle at ~/.gemini/config/plugins/jj-view/
	pluginDir := filepath.Join(opts.configDir, "plugins", "jj-view")
	assetsDir := filepath.Join(pluginDir, "assets")
	pluginSidecarDir := filepath.Join(pluginDir, "sidecars", "jj-view")

	for _, d := range []string{pluginDir, assetsDir, pluginSidecarDir} {
		if err := os.MkdirAll(d, 0755); err != nil {
			return fmt.Errorf("failed to create plugin directory %s: %w", d, err)
		}
	}

	// 1a. Write assets/icon.svg
	iconPath := filepath.Join(assetsDir, "icon.svg")
	if err := os.WriteFile(iconPath, []byte(scmIconSVG), 0644); err != nil {
		return fmt.Errorf("failed to write icon asset: %w", err)
	}

	// 1b. Write plugin.json
	pluginManifest := map[string]any{
		"name":        "jj-view",
		"description": "jj view - Interactive Jujutsu (jj) visual interface and SCM provider.",
		"logo":        "assets/icon.svg",
	}
	pluginJSON, err := json.MarshalIndent(pluginManifest, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize plugin manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "plugin.json"), pluginJSON, 0644); err != nil {
		return fmt.Errorf("failed to write plugin.json: %w", err)
	}

	// 1c. Write sidecar.json inside plugin bundle
	sidecarCmd, sidecarArgs, sidecarEnv := buildSidecarCommand(opts.binaryPath, os.Getenv("SHELL"))
	sidecarManifest := map[string]any{
		"command":        sidecarCmd,
		"args":           sidecarArgs,
		"restart_policy": "always",
		"has_web_ui":     true,
		"description":    "jj view Jujutsu (jj) visual interface.",
		"display_name":   "jj view",
		"ui_config": map[string]any{
			"display_name": "jj view",
			"views": []map[string]any{
				{
					"entrypoint": "SIDECAR_UI_ENTRYPOINT_FULL_PANE",
					"path":       "/",
					"title":      "jj view",
				},
				{
					"entrypoint": "SIDECAR_UI_ENTRYPOINT_AUX_PANE",
					"path":       "/",
					"title":      "jj view",
				},
			},
		},
	}
	if len(sidecarEnv) > 0 {
		sidecarManifest["env"] = sidecarEnv
	}
	sidecarJSON, err := json.MarshalIndent(sidecarManifest, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize sidecar manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(pluginSidecarDir, "sidecar.json"), sidecarJSON, 0644); err != nil {
		return fmt.Errorf("failed to write plugin sidecar.json: %w", err)
	}

	// 2. Clean up legacy loose sidecar directory at ~/.gemini/config/sidecars/jj-view
	legacySidecarDir := filepath.Join(opts.configDir, "sidecars", "jj-view")
	if err := os.RemoveAll(legacySidecarDir); err != nil && !os.IsNotExist(err) {
		fmt.Printf("[Install] Warning: failed to clean legacy sidecar directory: %v\n", err)
	}

	// 3. Update ~/.gemini/config/config.json to enable plugin and remove legacy loose sidecar
	configPath := filepath.Join(opts.configDir, "config.json")
	var configData map[string]any
	if data, err := os.ReadFile(configPath); err == nil {
		if jErr := json.Unmarshal(data, &configData); jErr != nil {
			_ = os.WriteFile(configPath+".bak", data, 0644)
			configData = make(map[string]any)
		}
	} else {
		configData = make(map[string]any)
	}

	// Enable under plugins
	pluginsMap, ok := configData["plugins"].(map[string]any)
	if !ok {
		pluginsMap = make(map[string]any)
		configData["plugins"] = pluginsMap
	}
	pluginsMap["jj-view"] = map[string]any{
		"enabled": true,
	}

	// Remove legacy loose sidecar from sidecars in config.json
	if sidecarsMap, ok := configData["sidecars"].(map[string]any); ok {
		delete(sidecarsMap, "jj-view")
	}

	updatedConfig, err := json.MarshalIndent(configData, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize updated config.json: %w", err)
	}

	if err := os.WriteFile(configPath, updatedConfig, 0644); err != nil {
		return fmt.Errorf("failed to write updated config.json: %w", err)
	}

	fmt.Printf("[Install] Successfully installed plugin to: %s\n", pluginDir)
	fmt.Printf("[Install] Custom SCM icon registered at: %s\n", iconPath)
	fmt.Printf("[Install] Enabled 'jj-view' in: %s\n", configPath)

	if opts.noRestart {
		return nil
	}
	procs, err := listProcesses()
	if err != nil {
		fmt.Printf("[Install] Skipping daemon restart: %v\n", err)
		return nil
	}
	restarted := restartRunningDaemons(opts.binaryPath, procs, os.Getpid(), reloadProcess)
	if len(restarted) == 0 {
		fmt.Printf("[Install] No running daemons to restart.\n")
		return nil
	}
	fmt.Printf("[Install] Reloaded %d running daemon(s) in-place %v.\n", len(restarted), restarted)
	return nil
}

// buildSidecarCommand configures sidecar.json to launch jj-view through the
// user's interactive login shell (`<shell> -lc "exec '<binary>' --host 127.0.0.1 --no-open"`)
// when available on Unix, so the sidecar dynamically inherits the user's shell
// PATH (such as depot_tools or ~/.local/bin) even when the host daemon runs
// under a minimal systemd/launchd environment.
func buildSidecarCommand(binaryPath string, shell string) (command string, args []string, env map[string]string) {
	defaultArgs := []string{"--host", "127.0.0.1", "--no-open"}
	shell = strings.TrimSpace(shell)
	if runtime.GOOS != "windows" && shell != "" && filepath.IsAbs(shell) {
		if info, err := os.Stat(shell); err == nil && !info.IsDir() {
			execCmd := fmt.Sprintf("exec %s --host 127.0.0.1 --no-open", shellQuote(binaryPath))
			return shell, []string{"-lc", execCmd}, map[string]string{reloadShellEnvVar: shell}
		}
	}
	return binaryPath, defaultArgs, nil
}

