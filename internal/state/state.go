// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package state

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// Options configures a state Store.
type Options struct {
	Path     string
	OnChange func(key string, value json.RawMessage)
}

// Store provides thread-safe, atomically-persisted key-value storage using json.RawMessage.
type Store struct {
	mu       sync.RWMutex
	path     string
	data     map[string]json.RawMessage
	onChange func(key string, value json.RawMessage)
	closed   bool
}

// NewStore initializes a Store and loads any existing data from disk.
func NewStore(opts Options) (*Store, error) {
	path := opts.Path
	if path == "" {
		p, err := DefaultStatePath()
		if err != nil {
			return nil, err
		}
		path = p
	}

	s := &Store{
		path:     path,
		data:     make(map[string]json.RawMessage),
		onChange: opts.OnChange,
	}

	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// DefaultStatePath returns the platform-specific default state file path.
func DefaultStatePath() (string, error) {
	if stateHome := os.Getenv("XDG_STATE_HOME"); stateHome != "" && filepath.IsAbs(stateHome) {
		return filepath.Join(stateHome, "jj-view", "state.json"), nil
	}
	switch runtime.GOOS {
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData != "" {
			return filepath.Join(localAppData, "jj-view", "state.json"), nil
		}
		cfgDir, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(cfgDir, "jj-view", "state.json"), nil
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", "jj-view", "state.json"), nil
	default:
		stateHome := os.Getenv("XDG_STATE_HOME")
		if stateHome != "" && filepath.IsAbs(stateHome) {
			return filepath.Join(stateHome, "jj-view", "state.json"), nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".local", "state", "jj-view", "state.json"), nil
	}
}

func (s *Store) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}

	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &parsed); err != nil {
		backupPath := fmt.Sprintf("%s.corrupted.%s", s.path, time.Now().Format("20060102150405"))
		_ = os.Rename(s.path, backupPath)
		log.Printf("[WARN] State file %s corrupted; quarantined to %s: %v", s.path, backupPath, err)
		s.data = make(map[string]json.RawMessage)
		return nil
	}

	if parsed == nil {
		parsed = make(map[string]json.RawMessage)
	}
	s.data = parsed
	return nil
}

// Get returns the value for the given key and whether it was found.
func (s *Store) Get(key string) (json.RawMessage, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	val, ok := s.data[key]
	if !ok {
		return nil, false
	}
	out := make(json.RawMessage, len(val))
	copy(out, val)
	return out, true
}

// GetAll returns a copy of all key-value pairs in the store.
func (s *Store) GetAll() map[string]json.RawMessage {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]json.RawMessage, len(s.data))
	for k, v := range s.data {
		cp := make(json.RawMessage, len(v))
		copy(cp, v)
		out[k] = cp
	}
	return out
}

// Set sets the value for the given key and persists the change to disk.
// If val is nil, empty, or "null", the key is deleted.
func (s *Store) Set(key string, val json.RawMessage) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return fmt.Errorf("store is closed")
	}

	oldVal, hadOld := s.data[key]
	if len(val) == 0 || bytes.Equal(val, []byte("null")) {
		delete(s.data, key)
	} else {
		cp := make(json.RawMessage, len(val))
		copy(cp, val)
		s.data[key] = cp
	}

	payload, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		if hadOld {
			s.data[key] = oldVal
		} else {
			delete(s.data, key)
		}
		s.mu.Unlock()
		return err
	}
	payload = append(payload, '\n')

	if err := AtomicWriteFile(s.path, payload, 0755, 0644); err != nil {
		if hadOld {
			s.data[key] = oldVal
		} else {
			delete(s.data, key)
		}
		s.mu.Unlock()
		return err
	}
	s.mu.Unlock()

	if s.onChange != nil {
		go s.onChange(key, val)
	}
	return nil
}

// Delete deletes the key and persists the change to disk.
func (s *Store) Delete(key string) error {
	return s.Set(key, nil)
}

// Path returns the path to the backing state file.
func (s *Store) Path() string {
	return s.path
}

// Close closes the store and rejects further modifications.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return nil
}
