// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/brychanrobot/jj-view/internal/state"
)

// InstanceInfo records connection metadata for a running standalone JJ View server.
type InstanceInfo struct {
	PID          int    `json:"pid"`
	Host         string `json:"host"`
	Port         int    `json:"port"`
	SessionToken string `json:"sessionToken"`
	RepoRoot     string `json:"repoRoot"`
	StartedAt    string `json:"startedAt"`
}

type instanceMatch struct {
	info InstanceInfo
	path string
}

// InstanceDir returns the directory used to store running server instance metadata files.
func InstanceDir(userDataDir string) (string, error) {
	if trimmed := strings.TrimSpace(userDataDir); trimmed != "" {
		absDir, err := filepath.Abs(trimmed)
		if err != nil {
			return "", fmt.Errorf("invalid user data dir: %w", err)
		}
		return filepath.Join(absDir, "servers"), nil
	}
	defaultStatePath, err := state.DefaultStatePath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(defaultStatePath), "servers"), nil
}

func sanitizeInstanceHost(host string) string {
	trimmed := strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if trimmed == "" {
		return "127.0.0.1"
	}
	var b strings.Builder
	b.Grow(len(trimmed))
	for i := 0; i < len(trimmed); i++ {
		c := trimmed[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' {
			b.WriteByte(c)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

// InstanceFilePath returns the metadata file path for a server listening on host:port.
func InstanceFilePath(dir, host string, port int) string {
	return filepath.Join(dir, fmt.Sprintf("%s-%d.json", sanitizeInstanceHost(host), port))
}

func candidateInstanceHosts(host string) []string {
	primary := strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if primary == "" {
		primary = "127.0.0.1"
	}
	candidates := []string{primary}
	switch primary {
	case "127.0.0.1":
		candidates = append(candidates, "localhost", "0.0.0.0")
	case "localhost":
		candidates = append(candidates, "127.0.0.1", "::1", "0.0.0.0")
	case "0.0.0.0":
		candidates = append(candidates, "127.0.0.1", "localhost")
	case "::1":
		candidates = append(candidates, "localhost", "::")
	case "::":
		candidates = append(candidates, "::1", "localhost")
	}
	seen := make(map[string]bool, len(candidates))
	out := make([]string, 0, len(candidates))
	for _, c := range candidates {
		if !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	return out
}

func findInstanceMatches(userDataDir, host string, port int) ([]instanceMatch, error) {
	dir, err := InstanceDir(userDataDir)
	if err != nil {
		return nil, err
	}
	seenPaths := make(map[string]bool)
	var matches []instanceMatch
	for _, candidateHost := range candidateInstanceHosts(host) {
		p := InstanceFilePath(dir, candidateHost, port)
		if seenPaths[p] {
			continue
		}
		seenPaths[p] = true
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var info InstanceInfo
		if err := json.Unmarshal(data, &info); err != nil {
			continue
		}
		if info.SessionToken == "" || info.Port != port {
			continue
		}
		matches = append(matches, instanceMatch{info: info, path: p})
	}
	if len(matches) == 0 {
		addr := net.JoinHostPort(strings.Trim(strings.TrimSpace(host), "[]"), strconv.Itoa(port))
		return nil, fmt.Errorf("no server instance metadata found for %s in %s: %w", addr, dir, os.ErrNotExist)
	}
	return matches, nil
}

// FindInstances locates all valid instance metadata records matching host:port candidates.
func FindInstances(userDataDir, host string, port int) ([]InstanceInfo, error) {
	matches, err := findInstanceMatches(userDataDir, host, port)
	if err != nil {
		return nil, err
	}
	out := make([]InstanceInfo, len(matches))
	for i, m := range matches {
		out[i] = m.info
	}
	return out, nil
}

// FindInstance locates the primary instance metadata file for a server on host:port.
func FindInstance(userDataDir, host string, port int) (*InstanceInfo, string, error) {
	matches, err := findInstanceMatches(userDataDir, host, port)
	if err != nil {
		return nil, "", err
	}
	info := matches[0].info
	return &info, matches[0].path, nil
}

func (s *Server) writeInstanceFile() {
	if s.cfg.SidecarToken != "" || s.stateStore == nil || s.cfg.Port <= 0 {
		return
	}
	dir := filepath.Join(filepath.Dir(s.stateStore.Path()), "servers")
	p := InstanceFilePath(dir, s.cfg.Host, s.cfg.Port)
	info := InstanceInfo{
		PID:          os.Getpid(),
		Host:         s.cfg.Host,
		Port:         s.cfg.Port,
		SessionToken: s.cfg.SessionToken,
		RepoRoot:     s.cfg.RepoRoot,
		StartedAt:    time.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		log.Printf("[WARN] Failed to marshal server instance file %s: %v", p, err)
		return
	}
	data = append(data, '\n')
	if err := state.AtomicWriteFile(p, data, 0700, 0600); err != nil {
		log.Printf("[WARN] Failed to write server instance file %s: %v", p, err)
		return
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(dir, 0700)
		_ = os.Chmod(p, 0600)
	}
	s.instancePath = p
}

func (s *Server) removeInstanceFile(p string) {
	if p == "" {
		return
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return
	}
	var info InstanceInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return
	}
	if info.PID == os.Getpid() && info.SessionToken == s.cfg.SessionToken {
		_ = os.Remove(p)
	}
}
