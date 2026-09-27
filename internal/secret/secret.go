// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package secret

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Options configures a secret Store.
type Options struct {
	Path     string
	OnChange func(key string, action string)
}

// Store provides thread-safe, permission-restricted key-value storage for secrets.
type Store struct {
	mu       sync.RWMutex
	path     string
	data     map[string]string
	onChange func(key string, action string)
	closed   bool
}

// NewStore initializes a Store and loads any existing secrets from disk.
func NewStore(opts Options) (*Store, error) {
	path := opts.Path
	if path == "" {
		p, err := DefaultSecretPath()
		if err != nil {
			return nil, err
		}
		path = p
	}

	s := &Store{
		path:     path,
		data:     make(map[string]string),
		onChange: opts.OnChange,
	}

	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// DefaultSecretPath returns the platform-specific default credentials path.
func DefaultSecretPath() (string, error) {
	if configHome := os.Getenv("XDG_CONFIG_HOME"); configHome != "" {
		return filepath.Join(configHome, "jj-view", "credentials.json"), nil
	}
	cfgDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cfgDir, "jj-view", "credentials.json"), nil
}

func (s *Store) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	raw, err := readPayload(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		backupPath := fmt.Sprintf("%s.corrupted.%s", s.path, time.Now().Format("20060102150405"))
		_ = os.Rename(s.path, backupPath)
		log.Printf("[WARN] Credentials file %s corrupted; quarantined to %s: %v", s.path, backupPath, err)
		s.data = make(map[string]string)
		return nil
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}

	var parsed map[string]string
	if err := json.Unmarshal(trimmed, &parsed); err != nil {
		backupPath := fmt.Sprintf("%s.corrupted.%s", s.path, time.Now().Format("20060102150405"))
		_ = os.Rename(s.path, backupPath)
		log.Printf("[WARN] Credentials file %s corrupted; quarantined to %s: %v", s.path, backupPath, err)
		s.data = make(map[string]string)
		return nil
	}

	if parsed == nil {
		parsed = make(map[string]string)
	}
	s.data = parsed
	return nil
}

// Get returns the secret value for the given key and whether it was found.
func (s *Store) Get(key string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	val, ok := s.data[key]
	return val, ok
}

// GetAll returns a copy of all secrets (for debugging or migration).
func (s *Store) GetAll() map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]string, len(s.data))
	for k, v := range s.data {
		out[k] = v
	}
	return out
}

// Store sets the secret for the given key and persists the change to disk.
func (s *Store) Store(key string, val string) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return fmt.Errorf("store is closed")
	}

	oldVal, hadOld := s.data[key]
	s.data[key] = val
	if err := s.saveLocked(); err != nil {
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
		go s.onChange(key, "store")
	}
	return nil
}

// Delete removes the secret for the given key and persists the change to disk.
func (s *Store) Delete(key string) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return fmt.Errorf("store is closed")
	}

	oldVal, hadOld := s.data[key]
	if !hadOld {
		s.mu.Unlock()
		return nil
	}

	delete(s.data, key)
	if err := s.saveLocked(); err != nil {
		s.data[key] = oldVal
		s.mu.Unlock()
		return err
	}
	s.mu.Unlock()

	if s.onChange != nil {
		go s.onChange(key, "delete")
	}
	return nil
}

func (s *Store) saveLocked() error {
	payload, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')

	return writePayload(s.path, payload)
}

// Path returns the backing file path.
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
