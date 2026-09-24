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

// Scope represents a configuration scope ("user", "workspace", or "effective").
type Scope string

const (
	ScopeUser      Scope = "user"
	ScopeWorkspace Scope = "workspace"
	ScopeEffective Scope = "effective"
)

// Options configures the Store.
type Options struct {
	UserConfigPath string
	RepoRoot       string
	OnChange       func(key string, scope string)
}

// Store manages reading and writing user and workspace configuration.
type Store struct {
	mu            sync.RWMutex
	userPath      string
	repoRoot      string
	workspacePath string
	userData      map[string]any
	workspaceData map[string]any
	onChange      func(key string, scope string)

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
		userPath = DefaultConfigPath()
	}

	var wsPath string
	if opt.RepoRoot != "" {
		wsPath = filepath.Join(opt.RepoRoot, ".vscode", "settings.json")
	}

	s := &Store{
		userPath:      userPath,
		repoRoot:      opt.RepoRoot,
		workspacePath: wsPath,
		userData:      make(map[string]any),
		workspaceData: make(map[string]any),
		onChange:      opt.OnChange,
		done:          make(chan struct{}),
	}

	_ = s.loadUser()
	if s.workspacePath != "" {
		_ = s.loadWorkspace()
	}

	_ = s.initWatcher()

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

// stripJSONComments removes single-line // and multi-line /* */ comments from JSON data
// while safely preserving string literals.
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

	return buf.Bytes()
}

func (s *Store) loadUser() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	raw, err := os.ReadFile(s.userPath)
	if err != nil {
		if os.IsNotExist(err) {
			s.userData = make(map[string]any)
			return nil
		}
		return err
	}

	cleaned := stripJSONComments(raw)
	var parsed map[string]any
	if err := json.Unmarshal(cleaned, &parsed); err != nil {
		return err
	}
	if parsed == nil {
		parsed = make(map[string]any)
	}
	s.userData = parsed
	return nil
}

func (s *Store) loadWorkspace() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.workspacePath == "" {
		return nil
	}

	raw, err := os.ReadFile(s.workspacePath)
	if err != nil {
		if os.IsNotExist(err) {
			s.workspaceData = make(map[string]any)
			return nil
		}
		return err
	}

	cleaned := stripJSONComments(raw)
	var parsed map[string]any
	if err := json.Unmarshal(cleaned, &parsed); err != nil {
		return err
	}
	if parsed == nil {
		parsed = make(map[string]any)
	}
	s.workspaceData = parsed
	return nil
}

func normalizeKey(k string) string {
	return strings.TrimPrefix(k, "jj-view.")
}

func (s *Store) getWorkspace(key string) (any, bool) {
	norm := normalizeKey(key)
	if val, ok := s.workspaceData["jj-view."+norm]; ok {
		return val, true
	}
	if val, ok := s.workspaceData[key]; ok {
		return val, true
	}
	if val, ok := s.workspaceData[norm]; ok {
		return val, true
	}
	return nil, false
}

func (s *Store) getUser(key string) (any, bool) {
	norm := normalizeKey(key)
	if val, ok := s.userData[norm]; ok {
		return val, true
	}
	if val, ok := s.userData["jj-view."+norm]; ok {
		return val, true
	}
	if val, ok := s.userData[key]; ok {
		return val, true
	}
	return nil, false
}

// Get returns the effective configuration value for key.
func (s *Store) Get(key string) (any, bool) {
	return s.GetScoped(string(ScopeEffective), key)
}

// GetScoped returns the value for key within a specific scope.
func (s *Store) GetScoped(scope string, key string) (any, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	switch Scope(scope) {
	case ScopeWorkspace:
		return s.getWorkspace(key)
	case ScopeUser:
		return s.getUser(key)
	default: // ScopeEffective
		if val, ok := s.getWorkspace(key); ok {
			return val, true
		}
		return s.getUser(key)
	}
}

// GetAll returns a copy of all effective configuration keys and values.
func (s *Store) GetAll() map[string]any {
	return s.GetAllScoped(string(ScopeEffective))
}

// GetAllScoped returns configuration keys and values for a specific scope.
func (s *Store) GetAllScoped(scope string) map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()

	switch Scope(scope) {
	case ScopeUser:
		res := make(map[string]any, len(s.userData)*2)
		for k, v := range s.userData {
			res[k] = v
			norm := normalizeKey(k)
			res[norm] = v
			res["jj-view."+norm] = v
		}
		return res

	case ScopeWorkspace:
		res := make(map[string]any, len(s.workspaceData)*2)
		for k, v := range s.workspaceData {
			if strings.HasPrefix(k, "jj-view.") || s.isJjViewKeyLocked(k) {
				res[k] = v
				norm := normalizeKey(k)
				res[norm] = v
				res["jj-view."+norm] = v
			}
		}
		return res

	default: // ScopeEffective
		res := make(map[string]any)
		// 1. User config values first
		for k, v := range s.userData {
			res[k] = v
			norm := normalizeKey(k)
			res[norm] = v
			res["jj-view."+norm] = v
		}
		// 2. Workspace config values override user config
		for k, v := range s.workspaceData {
			if strings.HasPrefix(k, "jj-view.") || s.isJjViewKeyLocked(k) {
				res[k] = v
				norm := normalizeKey(k)
				res[norm] = v
				res["jj-view."+norm] = v
			}
		}
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
	s.mu.Lock()
	defer s.mu.Unlock()

	norm := normalizeKey(key)
	sc := Scope(scope)

	if sc == ScopeWorkspace {
		if s.workspacePath == "" {
			return fmt.Errorf("no workspace or repository root configured")
		}
		wsKey := key
		if !strings.Contains(key, ".") {
			wsKey = "jj-view." + norm
		}
		if val == nil {
			delete(s.workspaceData, wsKey)
			delete(s.workspaceData, key)
			delete(s.workspaceData, norm)
			delete(s.workspaceData, "jj-view."+norm)
		} else {
			s.workspaceData[wsKey] = val
			s.workspaceData[norm] = val
		}
		if err := s.saveWorkspaceLocked(); err != nil {
			return err
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
		if userKey != key {
			s.userData[userKey] = val
		}
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

	raw, err := json.MarshalIndent(s.userData, "", "  ")
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

func (s *Store) saveWorkspaceLocked() error {
	dir := filepath.Dir(s.workspacePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create .vscode directory: %w", err)
	}

	var fileData map[string]any
	raw, err := os.ReadFile(s.workspacePath)
	if err == nil {
		_ = json.Unmarshal(stripJSONComments(raw), &fileData)
	}
	if fileData == nil {
		fileData = make(map[string]any)
	}

	// Remove deleted managed keys
	for k := range fileData {
		if strings.HasPrefix(k, "jj-view.") || strings.HasPrefix(k, "appearance.") || strings.HasPrefix(k, "diff.") {
			if _, ok := s.workspaceData[k]; !ok {
				norm := normalizeKey(k)
				if _, ok2 := s.workspaceData[norm]; !ok2 {
					delete(fileData, k)
				}
			}
		}
	}
	// Copy active workspace keys
	for k, v := range s.workspaceData {
		fileData[k] = v
	}

	marshaled, err := json.MarshalIndent(fileData, "", "  ")
	if err != nil {
		return err
	}
	marshaled = append(marshaled, '\n')

	tmpFile := s.workspacePath + ".tmp"
	if err := os.WriteFile(tmpFile, marshaled, 0644); err != nil {
		return err
	}
	return os.Rename(tmpFile, s.workspacePath)
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

	if s.repoRoot != "" {
		vscodeDir := filepath.Join(s.repoRoot, ".vscode")
		if _, err := os.Stat(vscodeDir); err == nil {
			_ = s.watcher.Add(vscodeDir)
		} else {
			_ = s.watcher.Add(s.repoRoot)
		}
	}

	go s.watchLoop()
	return nil
}

func (s *Store) watchLoop() {
	userBase := filepath.Base(s.userPath)
	var wsBase string
	if s.workspacePath != "" {
		wsBase = filepath.Base(s.workspacePath)
	}

	for {
		select {
		case <-s.done:
			return
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}

			// If .vscode was created in repoRoot, add it to watcher
			if s.repoRoot != "" && filepath.Base(event.Name) == ".vscode" && (event.Has(fsnotify.Create) || event.Has(fsnotify.Write)) {
				vscodeDir := filepath.Join(s.repoRoot, ".vscode")
				_ = s.watcher.Add(vscodeDir)
			}

			if filepath.Base(event.Name) == userBase {
				s.handleUserFileEvent()
			}

			if wsBase != "" && filepath.Base(event.Name) == wsBase {
				s.handleWorkspaceFileEvent()
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

	raw, err := os.ReadFile(s.userPath)
	var newData map[string]any
	if err == nil {
		_ = json.Unmarshal(stripJSONComments(raw), &newData)
	}
	if newData == nil {
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

func (s *Store) handleWorkspaceFileEvent() {
	if s.workspacePath == "" {
		return
	}

	s.mu.RLock()
	oldData := s.workspaceData
	s.mu.RUnlock()

	raw, err := os.ReadFile(s.workspacePath)
	var newData map[string]any
	if err == nil {
		_ = json.Unmarshal(stripJSONComments(raw), &newData)
	}
	if newData == nil {
		newData = make(map[string]any)
	}

	s.mu.Lock()
	if reflect.DeepEqual(oldData, newData) {
		s.mu.Unlock()
		return
	}
	s.workspaceData = newData
	s.mu.Unlock()

	if s.onChange != nil {
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
