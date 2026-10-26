// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/brychanrobot/jj-view/internal/config"
)

const configCommand = "config"

type configCommonFlags struct {
	scope            string
	userScope        bool
	workspaceDir     string
	repoDir          string
	userConfig       string
	vscodeUserConfig string
	showOrigin       bool
	asJSON           bool
	workspaceSet     bool
	scopeSet         bool
}

func registerConfigCommonFlags(fs *flag.FlagSet, cf *configCommonFlags, defaultScope string) {
	fs.StringVar(&cf.scope, "scope", defaultScope, "Configuration scope: effective, user, vscode-user, workspace, vscode-workspace")
	fs.BoolVar(&cf.userScope, "user", false, "Operate on standalone user configuration (~/.config/jj-view/config.json)")
	fs.StringVar(&cf.workspaceDir, "workspace", ".", "Path to workspace root directory")
	fs.StringVar(&cf.repoDir, "repo", "", "Alias for --workspace")
	fs.StringVar(&cf.userConfig, "user-config", "", "Path to custom standalone user config.json")
	fs.StringVar(&cf.vscodeUserConfig, "vscode-user-config", "", "Path to custom VS Code User settings.json")
	fs.BoolVar(&cf.showOrigin, "show-origin", false, "Show the origin scope (workspace, vscode-workspace, user, vscode-user) and file path")
	fs.BoolVar(&cf.asJSON, "json", false, "Format output as JSON")
}

// reorderFlagsFirst moves flag arguments before positional arguments so that
// commands like `jj-view config get uploadCommand --show-origin` or
// `jj-view config set uploadCommand "upload -d" --scope workspace` work
// regardless of flag ordering.
func reorderFlagsFirst(fs *flag.FlagSet, args []string) []string {
	var flags []string
	var pos []string

	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			pos = append(pos, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			pos = append(pos, arg)
			continue
		}

		trimmed := strings.TrimLeft(arg, "-")
		if strings.Contains(trimmed, "=") {
			flags = append(flags, arg)
			continue
		}

		f := fs.Lookup(trimmed)
		if f == nil {
			// Let fs.Parse report unknown flag or -h/--help
			flags = append(flags, arg)
			continue
		}

		if bf, ok := f.Value.(interface{ IsBoolFlag() bool }); ok && bf.IsBoolFlag() {
			flags = append(flags, arg)
			continue
		}

		flags = append(flags, arg)
		if i+1 < len(args) {
			i++
			flags = append(flags, args[i])
		}
	}

	return append(flags, pos...)
}

func (cf *configCommonFlags) resolve(fs *flag.FlagSet) (string, *config.Store, error) {
	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "workspace", "repo":
			cf.workspaceSet = true
		case "scope":
			cf.scopeSet = true
		}
	})

	wsDir := cf.workspaceDir
	if cf.repoDir != "" {
		wsDir = cf.repoDir
	}
	absWorkspace, err := filepath.Abs(wsDir)
	if err != nil {
		return "", nil, fmt.Errorf("failed to resolve workspace path: %w", err)
	}

	var absUserConfig string
	if cf.userConfig != "" {
		absUserConfig, err = filepath.Abs(cf.userConfig)
		if err != nil {
			return "", nil, fmt.Errorf("failed to resolve user config path: %w", err)
		}
	}

	var absVscodeUserConfig string
	if cf.vscodeUserConfig != "" {
		absVscodeUserConfig, err = filepath.Abs(cf.vscodeUserConfig)
		if err != nil {
			return "", nil, fmt.Errorf("failed to resolve vscode user config path: %w", err)
		}
	}

	store, err := config.NewStore(config.Options{
		UserConfigPath:       absUserConfig,
		VscodeUserConfigPath: absVscodeUserConfig,
		RepoRoot:             absWorkspace,
	})
	if err != nil {
		return "", nil, fmt.Errorf("failed to initialize config store: %w", err)
	}

	return absWorkspace, store, nil
}

func runConfigCommand(args []string, stdout, stderr io.Writer) error {
	sub := "list"
	var subArgs []string
	if len(args) > 0 {
		if args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
			printConfigGeneralUsage(stderr)
			return flag.ErrHelp
		}
		if !strings.HasPrefix(args[0], "-") {
			sub = args[0]
			subArgs = args[1:]
		} else {
			subArgs = args
		}
	}

	switch sub {
	case "list", "ls":
		return runConfigList(subArgs, stdout, stderr)
	case "get":
		return runConfigGet(subArgs, stdout, stderr)
	case "inspect":
		return runConfigInspect(subArgs, stdout, stderr)
	case "set":
		return runConfigSet(subArgs, stdout, stderr)
	case "unset", "delete", "rm":
		return runConfigUnset(subArgs, stdout, stderr)
	case "paths":
		return runConfigPaths(subArgs, stdout, stderr)
	default:
		fmt.Fprintf(stderr, "jj-view config: unknown subcommand %q\n\n", sub)
		printConfigGeneralUsage(stderr)
		return fmt.Errorf("unknown config subcommand %q", sub)
	}
}

func printConfigGeneralUsage(w io.Writer) {
	fmt.Fprintf(w, `Usage: jj-view config <subcommand> [flags]

Query and modify JJ View configuration across standalone (.jj-view/config.json,
~/.config/jj-view/config.json) and VS Code (.vscode/settings.json,
~/.config/Code/User/settings.json) configuration layers.

Configuration Precedence (highest to lowest):
  1. workspace         <workspace>/.jj-view/config.json     (standalone JJ View workspace config)
  2. vscode-workspace  <workspace>/.vscode/settings.json    (VS Code workspace fallback)
  3. user              ~/.config/jj-view/config.json        (standalone JJ View user config)
  4. vscode-user       ~/.config/Code/User/settings.json    (VS Code user fallback)

Subcommands:
  list                  List configured settings and their source layer/file (default)
  get <key>             Get the value of a configuration key
  inspect <key>         Show values for a key across all 4 configuration layers
  set <key> <value>     Set a configuration key in user or workspace scope
  unset <key>           Remove a configuration key from user or workspace scope
  paths                 Show resolved configuration file paths for all layers

Run "jj-view config <subcommand> --help" for subcommand-specific flags.
`)
}

func validateReadScope(scope string) error {
	switch config.Scope(scope) {
	case config.ScopeEffective, config.ScopeUser, config.ScopeVscodeUser, config.ScopeWorkspace, config.ScopeVscodeWorkspace:
		return nil
	default:
		return fmt.Errorf("invalid scope %q (valid: effective, user, vscode-user, workspace, vscode-workspace)", scope)
	}
}

func resolveWriteScope(cf *configCommonFlags) (string, error) {
	if cf.userScope {
		return string(config.ScopeUser), nil
	}
	if cf.scopeSet {
		switch config.Scope(cf.scope) {
		case config.ScopeUser, config.ScopeWorkspace:
			return cf.scope, nil
		case config.ScopeVscodeUser, config.ScopeVscodeWorkspace:
			return "", fmt.Errorf("cannot write directly to %q via jj-view CLI; use --scope user or --scope workspace to write to JJ View's own config files (which take precedence over VS Code settings)", cf.scope)
		default:
			return "", fmt.Errorf("invalid write scope %q (valid: user, workspace)", cf.scope)
		}
	}
	if cf.workspaceSet {
		return string(config.ScopeWorkspace), nil
	}
	return string(config.ScopeUser), nil
}

func scopePathForLayer(paths config.ConfigPaths, scope config.Scope) string {
	switch scope {
	case config.ScopeWorkspace:
		return paths.WorkspacePath
	case config.ScopeVscodeWorkspace:
		return paths.VscodeWorkspacePath
	case config.ScopeUser:
		return paths.UserPath
	case config.ScopeVscodeUser:
		return paths.VscodeUserPath
	default:
		return ""
	}
}

func formatValueJSON(val any) string {
	b, err := json.Marshal(val)
	if err != nil {
		return fmt.Sprintf("%v", val)
	}
	return string(b)
}

func formatValuePlain(val any) string {
	if s, ok := val.(string); ok {
		return s
	}
	return formatValueJSON(val)
}

func parseCLIValue(raw string) any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "true" {
		return true
	}
	if trimmed == "false" {
		return false
	}
	if len(trimmed) > 0 && (trimmed[0] == '"' || trimmed[0] == '[' || trimmed[0] == '{' || (trimmed[0] >= '0' && trimmed[0] <= '9') || trimmed[0] == '-') {
		var parsed any
		if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil {
			return parsed
		}
	}
	return raw
}

func uniqueSortedNormKeys(m map[string]any) []string {
	seen := make(map[string]struct{}, len(m))
	for k := range m {
		norm := strings.TrimPrefix(k, "jj-view.")
		seen[norm] = struct{}{}
	}
	keys := make([]string, 0, len(seen))
	for norm := range seen {
		keys = append(keys, norm)
	}
	sort.Strings(keys)
	return keys
}

func canonicalDisplayKey(norm string) string {
	if strings.HasPrefix(norm, "appearance.") || strings.HasPrefix(norm, "diff.") {
		return norm
	}
	return "jj-view." + norm
}

func runConfigList(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("config list", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var cf configCommonFlags
	registerConfigCommonFlags(fs, &cf, string(config.ScopeEffective))
	fs.Usage = func() {
		printUsage(fs, "jj-view config list [flags]",
			"List configured settings and their source layer (workspace, vscode-workspace, user, vscode-user).", "")
	}

	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}

	scope := cf.scope
	if cf.userScope {
		scope = string(config.ScopeUser)
	}
	if err := validateReadScope(scope); err != nil {
		return err
	}

	absWorkspace, store, err := cf.resolve(fs)
	if err != nil {
		return err
	}
	defer store.Close()

	rawMap := store.GetAllScopedForWorkspace(scope, absWorkspace)
	normKeys := uniqueSortedNormKeys(rawMap)
	paths := store.PathsForWorkspace(absWorkspace)

	if cf.asJSON {
		type listEntry struct {
			Key        string       `json:"key"`
			Value      any          `json:"value"`
			Source     config.Scope `json:"source"`
			SourcePath string       `json:"sourcePath"`
		}
		entries := make([]listEntry, 0, len(normKeys))
		for _, norm := range normKeys {
			if config.Scope(scope) == config.ScopeEffective {
				insp := store.InspectForWorkspace(norm, absWorkspace)
				if insp.Found {
					entries = append(entries, listEntry{
						Key:        canonicalDisplayKey(norm),
						Value:      insp.EffectiveValue,
						Source:     insp.EffectiveSource,
						SourcePath: insp.EffectiveSourcePath,
					})
				}
			} else {
				val, ok := store.GetScopedForWorkspace(scope, norm, absWorkspace)
				if ok {
					entries = append(entries, listEntry{
						Key:        canonicalDisplayKey(norm),
						Value:      val,
						Source:     config.Scope(scope),
						SourcePath: scopePathForLayer(paths, config.Scope(scope)),
					})
				}
			}
		}
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(entries)
	}

	if len(normKeys) == 0 {
		fmt.Fprintf(stdout, "(no settings configured in %s scope)\n", scope)
		return nil
	}

	for _, norm := range normKeys {
		displayKey := canonicalDisplayKey(norm)
		if config.Scope(scope) == config.ScopeEffective {
			insp := store.InspectForWorkspace(norm, absWorkspace)
			if !insp.Found {
				continue
			}
			fmt.Fprintf(stdout, "%s = %s  [%s: %s]\n",
				displayKey,
				formatValueJSON(insp.EffectiveValue),
				insp.EffectiveSource,
				insp.EffectiveSourcePath,
			)
		} else {
			val, ok := store.GetScopedForWorkspace(scope, norm, absWorkspace)
			if !ok {
				continue
			}
			fmt.Fprintf(stdout, "%s = %s  [%s: %s]\n",
				displayKey,
				formatValueJSON(val),
				scope,
				scopePathForLayer(paths, config.Scope(scope)),
			)
		}
	}
	return nil
}

func runConfigGet(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("config get", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var cf configCommonFlags
	registerConfigCommonFlags(fs, &cf, string(config.ScopeEffective))
	fs.Usage = func() {
		printUsage(fs, "jj-view config get <key> [flags]",
			"Get the value of a configuration key.", "")
	}

	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return fmt.Errorf("expected exactly 1 argument <key>, got %d", fs.NArg())
	}
	key := fs.Arg(0)

	scope := cf.scope
	if cf.userScope {
		scope = string(config.ScopeUser)
	}
	if err := validateReadScope(scope); err != nil {
		return err
	}

	absWorkspace, store, err := cf.resolve(fs)
	if err != nil {
		return err
	}
	defer store.Close()

	norm := strings.TrimPrefix(key, "jj-view.")
	displayKey := canonicalDisplayKey(norm)

	if config.Scope(scope) == config.ScopeEffective {
		insp := store.InspectForWorkspace(key, absWorkspace)
		if !insp.Found {
			return fmt.Errorf("key %q not found in effective configuration", displayKey)
		}
		if cf.asJSON {
			if cf.showOrigin {
				enc := json.NewEncoder(stdout)
				enc.SetIndent("", "  ")
				return enc.Encode(insp)
			}
			fmt.Fprintln(stdout, formatValueJSON(insp.EffectiveValue))
			return nil
		}
		if cf.showOrigin {
			fmt.Fprintf(stdout, "%s\t%s\t%s\n", insp.EffectiveSource, insp.EffectiveSourcePath, formatValuePlain(insp.EffectiveValue))
			return nil
		}
		fmt.Fprintln(stdout, formatValuePlain(insp.EffectiveValue))
		return nil
	}

	val, found := store.GetScopedForWorkspace(scope, key, absWorkspace)
	if !found {
		return fmt.Errorf("key %q not found in %s configuration", displayKey, scope)
	}
	paths := store.PathsForWorkspace(absWorkspace)
	sourcePath := scopePathForLayer(paths, config.Scope(scope))

	if cf.asJSON {
		if cf.showOrigin {
			out := map[string]any{
				"key":        displayKey,
				"value":      val,
				"source":     scope,
				"sourcePath": sourcePath,
			}
			enc := json.NewEncoder(stdout)
			enc.SetIndent("", "  ")
			return enc.Encode(out)
		}
		fmt.Fprintln(stdout, formatValueJSON(val))
		return nil
	}
	if cf.showOrigin {
		fmt.Fprintf(stdout, "%s\t%s\t%s\n", scope, sourcePath, formatValuePlain(val))
		return nil
	}
	fmt.Fprintln(stdout, formatValuePlain(val))
	return nil
}

func runConfigInspect(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("config inspect", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var cf configCommonFlags
	registerConfigCommonFlags(fs, &cf, string(config.ScopeEffective))
	fs.Usage = func() {
		printUsage(fs, "jj-view config inspect <key> [flags]",
			"Inspect a configuration key across all 4 configuration layers (workspace, vscode-workspace, user, vscode-user).", "")
	}

	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return fmt.Errorf("expected exactly 1 argument <key>, got %d", fs.NArg())
	}
	key := fs.Arg(0)

	absWorkspace, store, err := cf.resolve(fs)
	if err != nil {
		return err
	}
	defer store.Close()

	insp := store.InspectForWorkspace(key, absWorkspace)
	if cf.asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(insp)
	}

	norm := strings.TrimPrefix(key, "jj-view.")
	displayKey := canonicalDisplayKey(norm)
	fmt.Fprintf(stdout, "Key: %s\n", displayKey)
	if insp.Found {
		fmt.Fprintf(stdout, "Effective: %s (from %s: %s)\n\n", formatValueJSON(insp.EffectiveValue), insp.EffectiveSource, insp.EffectiveSourcePath)
	} else {
		fmt.Fprintf(stdout, "Effective: <not set (uses schema default)>\n\n")
	}

	type layerRow struct {
		rank   int
		scope  config.Scope
		label  string
		path   string
		hasVal bool
		val    any
	}
	rows := []layerRow{
		{1, config.ScopeWorkspace, "workspace (jj-view)", insp.WorkspacePath, insp.HasWorkspace, insp.WorkspaceValue},
		{2, config.ScopeVscodeWorkspace, "vscode-workspace (VS Code)", insp.VscodeWorkspacePath, insp.HasVscodeWorkspace, insp.VscodeWorkspaceValue},
		{3, config.ScopeUser, "user (jj-view)", insp.UserPath, insp.HasUser, insp.UserValue},
		{4, config.ScopeVscodeUser, "vscode-user (VS Code)", insp.VscodeUserPath, insp.HasVscodeUser, insp.VscodeUserValue},
	}

	fmt.Fprintln(stdout, "Layers (highest to lowest precedence):")
	for _, r := range rows {
		valStr := "<not set>"
		if r.hasVal {
			valStr = formatValueJSON(r.val)
			if insp.EffectiveSource == r.scope {
				valStr += "  [active]"
			} else {
				valStr += "  [overridden]"
			}
		}
		fmt.Fprintf(stdout, "  %d. %-26s %s\n     Path: %s\n", r.rank, r.label+":", valStr, r.path)
	}
	return nil
}

func runConfigSet(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("config set", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var cf configCommonFlags
	registerConfigCommonFlags(fs, &cf, string(config.ScopeUser))
	fs.Usage = func() {
		printUsage(fs, "jj-view config set <key> <value> [flags]",
			"Set a configuration key in standalone user (~/.config/jj-view/config.json) or workspace (<workspace>/.jj-view/config.json) scope.", "")
	}

	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		return err
	}
	if fs.NArg() != 2 {
		fs.Usage()
		return fmt.Errorf("expected 2 arguments <key> <value>, got %d", fs.NArg())
	}
	key := fs.Arg(0)
	rawVal := fs.Arg(1)

	absWorkspace, store, err := cf.resolve(fs)
	if err != nil {
		return err
	}
	defer store.Close()

	writeScope, err := resolveWriteScope(&cf)
	if err != nil {
		return err
	}

	parsedVal := parseCLIValue(rawVal)
	if err := store.SetScopedForWorkspace(writeScope, key, parsedVal, absWorkspace); err != nil {
		return err
	}

	paths := store.PathsForWorkspace(absWorkspace)
	targetPath := scopePathForLayer(paths, config.Scope(writeScope))
	norm := strings.TrimPrefix(key, "jj-view.")
	displayKey := canonicalDisplayKey(norm)
	fmt.Fprintf(stdout, "Set %s = %s in %s (%s)\n", displayKey, formatValueJSON(parsedVal), writeScope, targetPath)
	return nil
}

func runConfigUnset(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("config unset", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var cf configCommonFlags
	registerConfigCommonFlags(fs, &cf, string(config.ScopeUser))
	fs.Usage = func() {
		printUsage(fs, "jj-view config unset <key> [flags]",
			"Remove a configuration key from user or workspace scope.", "")
	}

	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return fmt.Errorf("expected 1 argument <key>, got %d", fs.NArg())
	}
	key := fs.Arg(0)

	absWorkspace, store, err := cf.resolve(fs)
	if err != nil {
		return err
	}
	defer store.Close()

	writeScope, err := resolveWriteScope(&cf)
	if err != nil {
		return err
	}

	if err := store.SetScopedForWorkspace(writeScope, key, nil, absWorkspace); err != nil {
		return err
	}

	paths := store.PathsForWorkspace(absWorkspace)
	targetPath := scopePathForLayer(paths, config.Scope(writeScope))
	norm := strings.TrimPrefix(key, "jj-view.")
	displayKey := canonicalDisplayKey(norm)
	fmt.Fprintf(stdout, "Unset %s in %s (%s)\n", displayKey, writeScope, targetPath)
	return nil
}

func runConfigPaths(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("config paths", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var cf configCommonFlags
	registerConfigCommonFlags(fs, &cf, string(config.ScopeEffective))
	fs.Usage = func() {
		printUsage(fs, "jj-view config paths [flags]",
			"Show resolved configuration file paths for all layers in precedence order.", "")
	}

	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}

	absWorkspace, store, err := cf.resolve(fs)
	if err != nil {
		return err
	}
	defer store.Close()

	paths := store.PathsForWorkspace(absWorkspace)
	if cf.asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(paths)
	}

	fileStatus := func(p string) string {
		if p == "" {
			return "unavailable"
		}
		if _, err := os.Stat(p); err == nil {
			return "exists"
		} else if errors.Is(err, os.ErrNotExist) {
			return "not created"
		}
		return "unreadable"
	}

	fmt.Fprintln(stdout, "Configuration file precedence (highest to lowest):")
	fmt.Fprintf(stdout, "  1. workspace (jj-view):         %s [%s]\n", paths.WorkspacePath, fileStatus(paths.WorkspacePath))
	fmt.Fprintf(stdout, "  2. vscode-workspace (VS Code):  %s [%s]\n", paths.VscodeWorkspacePath, fileStatus(paths.VscodeWorkspacePath))
	fmt.Fprintf(stdout, "  3. user (jj-view):              %s [%s]\n", paths.UserPath, fileStatus(paths.UserPath))
	fmt.Fprintf(stdout, "  4. vscode-user (VS Code):       %s [%s]\n", paths.VscodeUserPath, fileStatus(paths.VscodeUserPath))
	return nil
}
