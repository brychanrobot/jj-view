// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// Scope represents a configuration scope.
type Scope string

const (
	ScopeUser            Scope = "user"
	ScopeVscodeUser      Scope = "vscode-user"
	ScopeWorkspace       Scope = "workspace"
	ScopeVscodeWorkspace Scope = "vscode-workspace"
	ScopeEffective       Scope = "effective"
)

// Options configures the Store.
type Options struct {
	UserDataDir          string
	UserConfigPath       string
	VscodeUserConfigPath string
	RepoRoot             string
	OnChange             func(key string, scope string)
}

// ConfigPaths describes the resolved configuration file paths for each layer.
type ConfigPaths struct {
	UserPath            string `json:"userPath"`
	VscodeUserPath      string `json:"vscodeUserPath,omitempty"`
	WorkspacePath       string `json:"workspacePath,omitempty"`
	VscodeWorkspacePath string `json:"vscodeWorkspacePath,omitempty"`
}

// InspectResult describes the value of a key across all configuration layers.
type InspectResult struct {
	Key                  string `json:"key"`
	Found                bool   `json:"found"`
	EffectiveValue       any    `json:"effectiveValue,omitempty"`
	EffectiveSource      Scope  `json:"effectiveSource,omitempty"`
	EffectiveSourcePath  string `json:"effectiveSourcePath,omitempty"`
	WorkspaceValue       any    `json:"workspaceValue,omitempty"`
	HasWorkspace         bool   `json:"hasWorkspace"`
	WorkspacePath        string `json:"workspacePath,omitempty"`
	VscodeWorkspaceValue any    `json:"vscodeWorkspaceValue,omitempty"`
	HasVscodeWorkspace   bool   `json:"hasVscodeWorkspace"`
	VscodeWorkspacePath  string `json:"vscodeWorkspacePath,omitempty"`
	UserValue            any    `json:"userValue,omitempty"`
	HasUser              bool   `json:"hasUser"`
	UserPath             string `json:"userPath"`
	VscodeUserValue      any    `json:"vscodeUserValue,omitempty"`
	HasVscodeUser        bool   `json:"hasVscodeUser"`
	VscodeUserPath       string `json:"vscodeUserPath,omitempty"`
}

type workspaceEntry struct {
	root           string
	standalonePath string
	vscodePath     string
	standaloneData map[string]any
	vscodeData     map[string]any
}

// Store manages reading and writing user and workspace configuration.
type Store struct {
	mu             sync.RWMutex
	userPath       string
	vscodeUserPath string
	repoRoot       string
	userData       map[string]any
	vscodeUserData map[string]any
	workspaces     map[string]*workspaceEntry
	onChange       func(key string, scope string)

	watcher *fsnotify.Watcher
	done    chan struct{}
}

// NewStore initializes a configuration store.
func NewStore(opts ...Options) (*Store, error) {
	var opt Options
	if len(opts) > 0 {
		opt = opts[0]
	}

	userPath := opt.UserConfigPath
	if userPath == "" {
		if opt.UserDataDir != "" {
			userPath = filepath.Join(opt.UserDataDir, "config.json")
		} else {
			userPath = DefaultConfigPath()
		}
	}

	vscodeUserPath := opt.VscodeUserConfigPath
	if vscodeUserPath == "" && opt.UserConfigPath == "" && opt.UserDataDir == "" {
		vscodeUserPath = DefaultVscodeUserConfigPath()
	}

	s := &Store{
		userPath:       userPath,
		vscodeUserPath: vscodeUserPath,
		repoRoot:       opt.RepoRoot,
		userData:       make(map[string]any),
		vscodeUserData: make(map[string]any),
		workspaces:     make(map[string]*workspaceEntry),
		onChange:       opt.OnChange,
		done:           make(chan struct{}),
	}

	_ = s.initWatcher()
	_ = s.loadUser()
	if s.repoRoot != "" {
		s.mu.Lock()
		_ = s.ensureWorkspaceLoadedLocked(s.repoRoot)
		s.mu.Unlock()
	}

	return s, nil
}

// DefaultConfigPath returns the platform-specific default config path.
func DefaultConfigPath() string {
	if runtime.GOOS == "windows" {
		appData := os.Getenv("APPDATA")
		if appData == "" {
			appData = os.TempDir()
		}
		return filepath.Join(appData, "jj-view", "config.json")
	}

	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			configHome = os.TempDir()
		} else {
			configHome = filepath.Join(home, ".config")
		}
	}
	return filepath.Join(configHome, "jj-view", "config.json")
}

// DefaultVscodeUserConfigPath returns the platform-specific default VS Code User settings.json path.
func DefaultVscodeUserConfigPath() string {
	if runtime.GOOS == "windows" {
		appData := os.Getenv("APPDATA")
		if appData == "" {
			return ""
		}
		return filepath.Join(appData, "Code", "User", "settings.json")
	}
	if runtime.GOOS == "darwin" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		return filepath.Join(home, "Library", "Application Support", "Code", "User", "settings.json")
	}

	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		configHome = filepath.Join(home, ".config")
	}
	return filepath.Join(configHome, "Code", "User", "settings.json")
}

func standaloneWorkspaceConfigPath(workspaceRoot string) string {
	return filepath.Join(filepath.Clean(workspaceRoot), ".jj-view", "config.json")
}

func vscodeWorkspaceConfigPath(workspaceRoot string) string {
	return filepath.Join(filepath.Clean(workspaceRoot), ".vscode", "settings.json")
}

// stripJSONComments removes single-line // and multi-line /* */ comments as well
// as trailing commas before } or ] from JSONC data while preserving string literals.
func stripJSONComments(data []byte) []byte {
	var buf bytes.Buffer
	buf.Grow(len(data))

	inString := false
	escaped := false
	inLineComment := false
	inBlockComment := false

	n := len(data)
	for i := 0; i < n; i++ {
		c := data[i]

		if inLineComment {
			if c == '\n' {
				inLineComment = false
				buf.WriteByte(c)
			}
			continue
		}

		if inBlockComment {
			if c == '*' && i+1 < n && data[i+1] == '/' {
				inBlockComment = false
				i++
			}
			continue
		}

		if inString {
			buf.WriteByte(c)
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
			continue
		}

		if c == '"' {
			inString = true
			buf.WriteByte(c)
			continue
		}

		if c == '/' && i+1 < n {
			if data[i+1] == '/' {
				inLineComment = true
				i++
				continue
			}
			if data[i+1] == '*' {
				inBlockComment = true
				i++
				continue
			}
		}

		buf.WriteByte(c)
	}

	return stripTrailingCommas(buf.Bytes())
}

func stripTrailingCommas(data []byte) []byte {
	var out bytes.Buffer
	out.Grow(len(data))

	inString := false
	escaped := false
	n := len(data)

	for i := 0; i < n; i++ {
		c := data[i]
		if inString {
			out.WriteByte(c)
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
			continue
		}

		if c == '"' {
			inString = true
			out.WriteByte(c)
			continue
		}

		if c == ',' {
			j := i + 1
			for j < n && (data[j] == ' ' || data[j] == '\t' || data[j] == '\r' || data[j] == '\n') {
				j++
			}
			if j < n && (data[j] == '}' || data[j] == ']') {
				continue
			}
		}

		out.WriteByte(c)
	}

	return out.Bytes()
}

func parseJSONCFile(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return make(map[string]any), nil
		}
		return nil, err
	}

	cleaned := stripJSONComments(raw)
	var parsed map[string]any
	if err := json.Unmarshal(cleaned, &parsed); err != nil {
		return nil, err
	}
	if parsed == nil {
		parsed = make(map[string]any)
	}
	return parsed, nil
}

func (s *Store) loadUser() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	parsed, err := parseJSONCFile(s.userPath)
	if err != nil {
		return err
	}
	s.userData = parsed

	if s.vscodeUserPath != "" {
		vsParsed, vsErr := parseJSONCFile(s.vscodeUserPath)
		if vsErr != nil {
			vsParsed = make(map[string]any)
		}
		s.vscodeUserData = vsParsed
	}
	return nil
}

func (s *Store) effectiveWorkspaceRootLocked(workspaceRoot string) string {
	if workspaceRoot != "" {
		return filepath.Clean(workspaceRoot)
	}
	if s.repoRoot != "" {
		return filepath.Clean(s.repoRoot)
	}
	return ""
}

func (s *Store) watchWorkspaceDirLocked(root string) {
	if s.watcher == nil || root == "" {
		return
	}
	_ = s.watcher.Add(root)
	jjViewDir := filepath.Join(root, ".jj-view")
	if _, err := os.Stat(jjViewDir); err == nil {
		_ = s.watcher.Add(jjViewDir)
	}
	vscodeDir := filepath.Join(root, ".vscode")
	if _, err := os.Stat(vscodeDir); err == nil {
		_ = s.watcher.Add(vscodeDir)
	}
}

func (s *Store) ensureWorkspaceLoadedLocked(workspaceRoot string) *workspaceEntry {
	root := s.effectiveWorkspaceRootLocked(workspaceRoot)
	if root == "" {
		return nil
	}

	if existing, ok := s.workspaces[root]; ok {
		return existing
	}

	standalonePath := standaloneWorkspaceConfigPath(root)
	vscodePath := vscodeWorkspaceConfigPath(root)

	standaloneParsed, err := parseJSONCFile(standalonePath)
	if err != nil {
		standaloneParsed = make(map[string]any)
	}
	vscodeParsed, err := parseJSONCFile(vscodePath)
	if err != nil {
		vscodeParsed = make(map[string]any)
	}

	entry := &workspaceEntry{
		root:           root,
		standalonePath: standalonePath,
		vscodePath:     vscodePath,
		standaloneData: standaloneParsed,
		vscodeData:     vscodeParsed,
	}
	s.workspaces[root] = entry
	s.watchWorkspaceDirLocked(root)
	return entry
}

func hasWorkspaceConfigOnDisk(root string) bool {
	if root == "" {
		return false
	}
	if _, err := os.Stat(standaloneWorkspaceConfigPath(root)); err == nil {
		return true
	}
	if _, err := os.Stat(vscodeWorkspaceConfigPath(root)); err == nil {
		return true
	}
	return false
}

// WatchWorkspaceRoot registers a workspace root with the config store and sets
// it as the fallback workspace root if the store does not yet have a workspace
// with a workspace config file on disk.
func (s *Store) WatchWorkspaceRoot(workspaceRoot string) {
	if workspaceRoot == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	cleaned := filepath.Clean(workspaceRoot)
	if s.repoRoot == "" || !hasWorkspaceConfigOnDisk(s.repoRoot) {
		s.repoRoot = cleaned
	}
	_ = s.ensureWorkspaceLoadedLocked(cleaned)
}

func normalizeKey(k string) string {
	return strings.TrimPrefix(k, "jj-view.")
}

func getFromWorkspaceMap(wsData map[string]any, key string) (any, bool) {
	if len(wsData) == 0 {
		return nil, false
	}
	norm := normalizeKey(key)
	if val, ok := wsData["jj-view."+norm]; ok {
		return val, true
	}
	if val, ok := wsData[key]; ok {
		return val, true
	}
	if val, ok := wsData[norm]; ok {
		return val, true
	}
	return nil, false
}

func getFromWorkspaceEntry(entry *workspaceEntry, key string) (any, bool) {
	if entry == nil {
		return nil, false
	}
	// 1. Standalone .jj-view/config.json has highest precedence
	if val, ok := getFromWorkspaceMap(entry.standaloneData, key); ok {
		return val, true
	}
	// 2. Fallback to .vscode/settings.json
	return getFromWorkspaceMap(entry.vscodeData, key)
}

func (s *Store) getUser(key string) (any, bool) {
	return getFromWorkspaceMap(s.userData, key)
}

func (s *Store) getVscodeUser(key string) (any, bool) {
	return getFromWorkspaceMap(s.vscodeUserData, key)
}

// PathsForWorkspace returns the configuration file paths for each layer.
func (s *Store) PathsForWorkspace(workspaceRoot string) ConfigPaths {
	s.mu.Lock()
	defer s.mu.Unlock()

	paths := ConfigPaths{
		UserPath:       s.userPath,
		VscodeUserPath: s.vscodeUserPath,
	}
	if entry := s.ensureWorkspaceLoadedLocked(workspaceRoot); entry != nil {
		paths.WorkspacePath = entry.standalonePath
		paths.VscodeWorkspacePath = entry.vscodePath
	}
	return paths
}

// InspectForWorkspace returns the value and provenance of a configuration key across all layers.
func (s *Store) InspectForWorkspace(key string, workspaceRoot string) InspectResult {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry := s.ensureWorkspaceLoadedLocked(workspaceRoot)
	norm := normalizeKey(key)
	res := InspectResult{
		Key:            "jj-view." + norm,
		UserPath:       s.userPath,
		VscodeUserPath: s.vscodeUserPath,
	}
	if entry != nil {
		res.WorkspacePath = entry.standalonePath
		res.VscodeWorkspacePath = entry.vscodePath
		if val, ok := getFromWorkspaceMap(entry.standaloneData, key); ok {
			res.WorkspaceValue = val
			res.HasWorkspace = true
		}
		if val, ok := getFromWorkspaceMap(entry.vscodeData, key); ok {
			res.VscodeWorkspaceValue = val
			res.HasVscodeWorkspace = true
		}
	}
	if val, ok := s.getUser(key); ok {
		res.UserValue = val
		res.HasUser = true
	}
	if val, ok := s.getVscodeUser(key); ok {
		res.VscodeUserValue = val
		res.HasVscodeUser = true
	}

	switch {
	case res.HasWorkspace:
		res.Found = true
		res.EffectiveValue = res.WorkspaceValue
		res.EffectiveSource = ScopeWorkspace
		res.EffectiveSourcePath = res.WorkspacePath
	case res.HasVscodeWorkspace:
		res.Found = true
		res.EffectiveValue = res.VscodeWorkspaceValue
		res.EffectiveSource = ScopeVscodeWorkspace
		res.EffectiveSourcePath = res.VscodeWorkspacePath
	case res.HasUser:
		res.Found = true
		res.EffectiveValue = res.UserValue
		res.EffectiveSource = ScopeUser
		res.EffectiveSourcePath = res.UserPath
	case res.HasVscodeUser:
		res.Found = true
		res.EffectiveValue = res.VscodeUserValue
		res.EffectiveSource = ScopeVscodeUser
		res.EffectiveSourcePath = res.VscodeUserPath
	}
	return res
}

// Get returns the effective configuration value for key.
func (s *Store) Get(key string) (any, bool) {
	return s.GetScoped(string(ScopeEffective), key)
}

// GetScoped returns the value for key within a specific scope.
func (s *Store) GetScoped(scope string, key string) (any, bool) {
	return s.GetScopedForWorkspace(scope, key, "")
}

// GetScopedForWorkspace returns the value for key within a specific scope and workspace root.
func (s *Store) GetScopedForWorkspace(scope string, key string, workspaceRoot string) (any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	switch Scope(scope) {
	case ScopeWorkspace:
		entry := s.ensureWorkspaceLoadedLocked(workspaceRoot)
		if entry == nil {
			return nil, false
		}
		return getFromWorkspaceMap(entry.standaloneData, key)
	case ScopeVscodeWorkspace:
		entry := s.ensureWorkspaceLoadedLocked(workspaceRoot)
		if entry == nil {
			return nil, false
		}
		return getFromWorkspaceMap(entry.vscodeData, key)
	case ScopeUser:
		return s.getUser(key)
	case ScopeVscodeUser:
		return s.getVscodeUser(key)
	default: // ScopeEffective
		entry := s.ensureWorkspaceLoadedLocked(workspaceRoot)
		if val, ok := getFromWorkspaceEntry(entry, key); ok {
			return val, true
		}
		if val, ok := s.getUser(key); ok {
			return val, true
		}
		return s.getVscodeUser(key)
	}
}

// GetAll returns a copy of all effective configuration keys and values.
func (s *Store) GetAll() map[string]any {
	return s.GetAllScoped(string(ScopeEffective))
}

// GetAllScoped returns configuration keys and values for a specific scope.
func (s *Store) GetAllScoped(scope string) map[string]any {
	return s.GetAllScopedForWorkspace(scope, "")
}

func (s *Store) mergeVscodeMapIntoLocked(dst map[string]any, src map[string]any) {
	for k := range src {
		if strings.HasPrefix(k, "jj-view.") || s.isJjViewKeyLocked(k) {
			norm := normalizeKey(k)
			if val, ok := getFromWorkspaceMap(src, norm); ok {
				dst[k] = val
				dst[norm] = val
				dst["jj-view."+norm] = val
			}
		}
	}
}

func mergeStandaloneMapInto(dst map[string]any, src map[string]any) {
	for k := range src {
		norm := normalizeKey(k)
		if val, ok := getFromWorkspaceMap(src, norm); ok {
			dst[k] = val
			dst[norm] = val
			dst["jj-view."+norm] = val
		}
	}
}

func (s *Store) mergeWorkspaceEntryIntoLocked(dst map[string]any, entry *workspaceEntry) {
	if entry == nil {
		return
	}
	// 1. Lower priority within workspace: .vscode/settings.json (filtered to jj-view keys)
	s.mergeVscodeMapIntoLocked(dst, entry.vscodeData)
	// 2. Higher priority within workspace: .jj-view/config.json (all keys belong to jj-view)
	mergeStandaloneMapInto(dst, entry.standaloneData)
}

// GetAllScopedForWorkspace returns configuration keys and values for a specific scope and workspace root.
func (s *Store) GetAllScopedForWorkspace(scope string, workspaceRoot string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()

	switch Scope(scope) {
	case ScopeUser:
		res := make(map[string]any, len(s.userData)*2)
		mergeStandaloneMapInto(res, s.userData)
		return res

	case ScopeVscodeUser:
		res := make(map[string]any)
		s.mergeVscodeMapIntoLocked(res, s.vscodeUserData)
		return res

	case ScopeWorkspace:
		entry := s.ensureWorkspaceLoadedLocked(workspaceRoot)
		res := make(map[string]any)
		if entry != nil {
			mergeStandaloneMapInto(res, entry.standaloneData)
		}
		return res

	case ScopeVscodeWorkspace:
		entry := s.ensureWorkspaceLoadedLocked(workspaceRoot)
		res := make(map[string]any)
		if entry != nil {
			s.mergeVscodeMapIntoLocked(res, entry.vscodeData)
		}
		return res

	default: // ScopeEffective
		res := make(map[string]any)
		// 1. VS Code user config (lowest priority)
		s.mergeVscodeMapIntoLocked(res, s.vscodeUserData)
		// 2. Standalone jj-view user config
		mergeStandaloneMapInto(res, s.userData)
		// 3. Workspace config (.vscode/settings.json then .jj-view/config.json)
		entry := s.ensureWorkspaceLoadedLocked(workspaceRoot)
		s.mergeWorkspaceEntryIntoLocked(res, entry)
		return res
	}
}

func (s *Store) isJjViewKeyLocked(k string) bool {
	if strings.HasPrefix(k, "jj-view.") || strings.HasPrefix(k, "appearance.") || strings.HasPrefix(k, "diff.") {
		return true
	}
	norm := normalizeKey(k)
	_, inUser := s.userData[norm]
	return inUser
}

// Set sets the key-value pair in user scope and persists it.
func (s *Store) Set(key string, val any) error {
	return s.SetScoped(string(ScopeUser), key, val)
}

// SetScoped sets or deletes a key-value pair within a specific scope and persists it.
func (s *Store) SetScoped(scope string, key string, val any) error {
	return s.SetScopedForWorkspace(scope, key, val, "")
}

// SetScopedForWorkspace sets or deletes a key-value pair within a specific scope and workspace root.
func (s *Store) SetScopedForWorkspace(scope string, key string, val any, workspaceRoot string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	norm := normalizeKey(key)
	sc := Scope(scope)

	if sc == ScopeWorkspace {
		entry := s.ensureWorkspaceLoadedLocked(workspaceRoot)
		if entry == nil || entry.standalonePath == "" {
			return fmt.Errorf("no workspace or repository root configured")
		}
		wsKey := key
		if !strings.Contains(key, ".") {
			wsKey = "jj-view." + norm
		}
		if val == nil {
			delete(entry.standaloneData, wsKey)
			delete(entry.standaloneData, key)
			delete(entry.standaloneData, norm)
			delete(entry.standaloneData, "jj-view."+norm)
			if _, err := os.Stat(entry.standalonePath); err == nil {
				if err := s.saveStandaloneWorkspaceLocked(entry); err != nil {
					return err
				}
			}
			// If the key also existed in .vscode/settings.json, remove it there too so resetting works cleanly.
			_, hadWsKey := entry.vscodeData[wsKey]
			_, hadKey := entry.vscodeData[key]
			_, hadNorm := entry.vscodeData[norm]
			_, hadPref := entry.vscodeData["jj-view."+norm]
			if hadWsKey || hadKey || hadNorm || hadPref {
				delete(entry.vscodeData, wsKey)
				delete(entry.vscodeData, key)
				delete(entry.vscodeData, norm)
				delete(entry.vscodeData, "jj-view."+norm)
				if _, err := os.Stat(entry.vscodePath); err == nil {
					if err := s.saveVscodeWorkspaceLocked(entry); err != nil {
						return err
					}
				}
			}
		} else {
			entry.standaloneData[wsKey] = val
			entry.standaloneData[norm] = val
			entry.standaloneData["jj-view."+norm] = val
			if err := s.saveStandaloneWorkspaceLocked(entry); err != nil {
				return err
			}
		}
		if s.onChange != nil {
			go s.onChange(norm, string(ScopeWorkspace))
		}
		return nil
	}

	// User scope
	userKey := key
	if !strings.Contains(key, ".") {
		userKey = "jj-view." + norm
	}
	if val == nil {
		delete(s.userData, key)
		delete(s.userData, norm)
		delete(s.userData, userKey)
		delete(s.userData, "jj-view."+norm)
	} else {
		s.userData[key] = val
		s.userData[norm] = val
		s.userData[userKey] = val
		s.userData["jj-view."+norm] = val
	}
	if err := s.saveUserLocked(); err != nil {
		return err
	}
	if s.onChange != nil {
		go s.onChange(norm, string(ScopeUser))
	}
	return nil
}

func (s *Store) saveUserLocked() error {
	dir := filepath.Dir(s.userPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	fileData := make(map[string]any, len(s.userData))
	for k, v := range s.userData {
		if !strings.HasPrefix(k, "jj-view.") {
			if _, hasPrefixed := s.userData["jj-view."+k]; hasPrefixed {
				continue
			}
		}
		fileData[k] = v
	}

	raw, err := json.MarshalIndent(fileData, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')

	tmpFile := s.userPath + ".tmp"
	if err := os.WriteFile(tmpFile, raw, 0600); err != nil {
		return err
	}
	return os.Rename(tmpFile, s.userPath)
}

func (s *Store) saveStandaloneWorkspaceLocked(entry *workspaceEntry) error {
	dir := filepath.Dir(entry.standalonePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create .jj-view directory: %w", err)
	}
	if s.watcher != nil {
		_ = s.watcher.Add(dir)
	}

	fileData := make(map[string]any)
	for k, v := range entry.standaloneData {
		if !strings.Contains(k, ".") {
			if _, hasPrefixed := entry.standaloneData["jj-view."+k]; hasPrefixed {
				continue
			}
		}
		fileData[k] = v
	}

	marshaled, err := json.MarshalIndent(fileData, "", "  ")
	if err != nil {
		return err
	}
	marshaled = append(marshaled, '\n')

	tmpFile := entry.standalonePath + ".tmp"
	if err := os.WriteFile(tmpFile, marshaled, 0644); err != nil {
		return err
	}
	return os.Rename(tmpFile, entry.standalonePath)
}

func (s *Store) saveVscodeWorkspaceLocked(entry *workspaceEntry) error {
	dir := filepath.Dir(entry.vscodePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create .vscode directory: %w", err)
	}
	if s.watcher != nil {
		_ = s.watcher.Add(dir)
	}

	fileData, _ := parseJSONCFile(entry.vscodePath)
	if fileData == nil {
		fileData = make(map[string]any)
	}

	// Remove deleted managed keys
	for k := range fileData {
		if strings.HasPrefix(k, "jj-view.") || strings.HasPrefix(k, "appearance.") || strings.HasPrefix(k, "diff.") {
			if _, ok := entry.vscodeData[k]; !ok {
				norm := normalizeKey(k)
				if _, ok2 := entry.vscodeData[norm]; !ok2 {
					delete(fileData, k)
				}
			}
		}
	}
	// Copy active workspace keys (preferring jj-view. prefixed keys so .vscode/settings.json stays clean)
	for k, v := range entry.vscodeData {
		if !strings.Contains(k, ".") {
			if _, hasPrefixed := entry.vscodeData["jj-view."+k]; hasPrefixed {
				continue
			}
		}
		fileData[k] = v
	}

	marshaled, err := json.MarshalIndent(fileData, "", "  ")
	if err != nil {
		return err
	}
	marshaled = append(marshaled, '\n')

	tmpFile := entry.vscodePath + ".tmp"
	if err := os.WriteFile(tmpFile, marshaled, 0644); err != nil {
		return err
	}
	return os.Rename(tmpFile, entry.vscodePath)
}

func (s *Store) initWatcher() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	s.watcher = watcher

	userDir := filepath.Dir(s.userPath)
	_ = os.MkdirAll(userDir, 0700)
	_ = s.watcher.Add(userDir)

	if s.vscodeUserPath != "" {
		vsUserDir := filepath.Dir(s.vscodeUserPath)
		if _, err := os.Stat(vsUserDir); err == nil {
			_ = s.watcher.Add(vsUserDir)
		}
	}

	go s.watchLoop()
	return nil
}

func (s *Store) watchLoop() {
	userBase := filepath.Base(s.userPath)
	vsUserBase := ""
	if s.vscodeUserPath != "" {
		vsUserBase = filepath.Base(s.vscodeUserPath)
	}

	for {
		select {
		case <-s.done:
			return
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}

			base := filepath.Base(event.Name)
			cleanedEvent := filepath.Clean(event.Name)
			// If .jj-view or .vscode was created in any watched workspace root, watch it too
			if (base == ".jj-view" || base == ".vscode") && (event.Has(fsnotify.Create) || event.Has(fsnotify.Write)) {
				_ = s.watcher.Add(event.Name)
			}

			if base == userBase && cleanedEvent == filepath.Clean(s.userPath) {
				s.handleUserFileEvent()
				continue
			}

			if vsUserBase != "" && base == vsUserBase && cleanedEvent == filepath.Clean(s.vscodeUserPath) {
				s.handleVscodeUserFileEvent()
				continue
			}

			if base == "config.json" || base == "settings.json" {
				s.handleWorkspaceFileEvent(cleanedEvent)
			}

		case _, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
		}
	}
}

func (s *Store) handleUserFileEvent() {
	s.mu.RLock()
	oldData := s.userData
	s.mu.RUnlock()

	newData, err := parseJSONCFile(s.userPath)
	if err != nil {
		newData = make(map[string]any)
	}

	s.mu.Lock()
	if reflect.DeepEqual(oldData, newData) {
		s.mu.Unlock()
		return
	}
	s.userData = newData
	s.mu.Unlock()

	if s.onChange != nil {
		s.onChange("", string(ScopeUser))
	}
}

func (s *Store) handleVscodeUserFileEvent() {
	s.mu.RLock()
	oldData := s.vscodeUserData
	s.mu.RUnlock()

	newData, err := parseJSONCFile(s.vscodeUserPath)
	if err != nil {
		newData = make(map[string]any)
	}

	s.mu.Lock()
	if reflect.DeepEqual(oldData, newData) {
		s.mu.Unlock()
		return
	}
	s.vscodeUserData = newData
	s.mu.Unlock()

	if s.onChange != nil {
		s.onChange("", string(ScopeVscodeUser))
	}
}

func (s *Store) handleWorkspaceFileEvent(changedPath string) {
	newData, err := parseJSONCFile(changedPath)
	if err != nil {
		newData = make(map[string]any)
	}

	changed := false
	s.mu.Lock()
	for _, entry := range s.workspaces {
		if filepath.Clean(entry.standalonePath) == changedPath {
			if !reflect.DeepEqual(entry.standaloneData, newData) {
				entry.standaloneData = newData
				changed = true
			}
		} else if filepath.Clean(entry.vscodePath) == changedPath {
			if !reflect.DeepEqual(entry.vscodeData, newData) {
				entry.vscodeData = newData
				changed = true
			}
		}
	}
	s.mu.Unlock()

	if changed && s.onChange != nil {
		s.onChange("", string(ScopeWorkspace))
	}
}

// Close gracefully closes the configuration store and file watcher.
func (s *Store) Close() error {
	select {
	case <-s.done:
		return nil
	default:
		close(s.done)
	}
	if s.watcher != nil {
		return s.watcher.Close()
	}
	return nil
}
