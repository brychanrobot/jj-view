// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package process

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/brychanrobot/jj-view/scripts"
)

const (
	defaultMaxBuffer = 10 * 1024 * 1024 // 10 MB
	ceilingMaxBuffer = 50 * 1024 * 1024 // 50 MB ceiling
)

// Allowed script names.
var allowedScripts = map[string]bool{
	"batch-diff":       true,
	"batch-edit":       true,
	"conflict-capture": true,
}

// Dangerous environment variable prefixes that could hijack process execution.
var blockedEnvPrefixes = []string{
	"LD_",
	"DYLD_",
	"GIT_EXTERNAL_DIFF",
	"GIT_SSH_COMMAND",
	"GIT_EXEC_PATH",
	"GIT_CONFIG_",
	"GIT_PAGER",
	"JJ_CONFIG",
	"JJ_PAGER",
	"BASH_ENV",
	"ENV",
	"PAGER",
	"SHELL",
	"IFS",
}

// ExecParams defines the parameters for process execution.
type ExecParams struct {
	File      string            `json:"file"`
	Args      []string          `json:"args"`
	Cwd       string            `json:"cwd,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Timeout   int               `json:"timeout,omitempty"`   // in milliseconds
	MaxBuffer int               `json:"maxBuffer,omitempty"` // in bytes
}

// ExecResult represents the result of executing a process.
type ExecResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
}

// ProcessExitError is returned when a process exits with a non-zero exit code.
type ProcessExitError struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	Message  string `json:"message"`
}

func (e *ProcessExitError) Error() string {
	return e.Message
}

// Manager handles process execution and helper script management.
type Manager struct {
	scriptsDir string
	initOnce   sync.Once
	initErr    error
}

// NewManager creates a new process manager with a private script cache.
func NewManager(customScriptsDir ...string) *Manager {
	var targetDir string
	if len(customScriptsDir) > 0 && customScriptsDir[0] != "" {
		targetDir = customScriptsDir[0]
	} else {
		uid := os.Getuid()
		if uid < 0 {
			uid = 0
		}
		targetDir = filepath.Join(os.TempDir(), fmt.Sprintf("jj-view-scripts-%d", uid))
	}

	return &Manager{
		scriptsDir: targetDir,
	}
}

// ScriptsDir returns the private directory where helper scripts are cached.
func (m *Manager) ScriptsDir() string {
	return m.scriptsDir
}

// EnsureScriptsExtracted extracts embedded scripts to a temporary directory.
func (m *Manager) EnsureScriptsExtracted() error {
	m.initOnce.Do(func() {
		m.initErr = m.extractScripts()
	})
	return m.initErr
}

func (m *Manager) extractScripts() error {
	if err := os.MkdirAll(m.scriptsDir, 0700); err != nil {
		return fmt.Errorf("failed to create scripts directory: %w", err)
	}

	entries, err := scripts.FS.ReadDir(".")
	if err != nil {
		return fmt.Errorf("failed to read embedded scripts: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		data, err := scripts.FS.ReadFile(entry.Name())
		if err != nil {
			return fmt.Errorf("failed to read embedded script %s: %w", entry.Name(), err)
		}

		targetPath := filepath.Join(m.scriptsDir, entry.Name())
		if err := os.WriteFile(targetPath, data, 0755); err != nil {
			return fmt.Errorf("failed to write script %s: %w", targetPath, err)
		}
	}
	return nil
}

// GetHelperScriptPath returns the path to the extracted helper script.
func (m *Manager) GetHelperScriptPath(name string) (string, error) {
	if !allowedScripts[name] {
		return "", fmt.Errorf("unknown helper script: %s", name)
	}

	if err := m.EnsureScriptsExtracted(); err != nil {
		return "", err
	}

	ext := ".sh"
	if runtime.GOOS == "windows" {
		ext = ".bat"
	}

	scriptPath := filepath.Join(m.scriptsDir, name+ext)
	if _, err := os.Stat(scriptPath); err != nil {
		return "", fmt.Errorf("helper script not found: %s", scriptPath)
	}

	return scriptPath, nil
}

// isAllowedExecutable checks if the executable is strictly whitelisted.
func (m *Manager) isAllowedExecutable(file string) (string, error) {
	cleanFile := filepath.Clean(file)

	// If the file path has no directory separators, it is a system binary command name
	if !strings.ContainsAny(file, `/\`) && filepath.Base(cleanFile) == cleanFile {
		if cleanFile == "jj" || cleanFile == "git" || cleanFile == "jj.exe" || cleanFile == "git.exe" {
			path, err := exec.LookPath(cleanFile)
			if err != nil {
				return "", fmt.Errorf("executable not found on PATH: %s", cleanFile)
			}
			return path, nil
		}
		return "", fmt.Errorf("execution forbidden: only jj, git, and jj-view helper scripts are permitted: %s", file)
	}

	// If it contains path separators, it MUST be inside the private scripts directory
	absClean, err := filepath.Abs(cleanFile)
	if err != nil {
		return "", fmt.Errorf("invalid executable path: %w", err)
	}

	absScripts, err := filepath.Abs(m.scriptsDir)
	if err != nil {
		return "", fmt.Errorf("invalid scripts directory: %w", err)
	}

	rel, err := filepath.Rel(absScripts, absClean)
	if err == nil && !strings.HasPrefix(rel, "..") && !strings.Contains(rel, "/") && !strings.Contains(rel, `\`) {
		scriptName := strings.TrimSuffix(rel, filepath.Ext(rel))
		if allowedScripts[scriptName] {
			return absClean, nil
		}
	}

	return "", fmt.Errorf("execution forbidden: path outside permitted script directory: %s", file)
}

func isSafeEnvVar(key string) bool {
	upperKey := strings.ToUpper(key)
	for _, prefix := range blockedEnvPrefixes {
		if strings.HasPrefix(upperKey, prefix) || upperKey == prefix {
			return false
		}
	}
	return true
}

// ExecFile executes a whitelisted process with the given parameters and context.
func (m *Manager) ExecFile(ctx context.Context, params ExecParams) (*ExecResult, error) {
	binPath, err := m.isAllowedExecutable(params.File)
	if err != nil {
		return nil, err
	}

	execCtx := ctx
	if params.Timeout > 0 {
		var cancel context.CancelFunc
		execCtx, cancel = context.WithTimeout(ctx, time.Duration(params.Timeout)*time.Millisecond)
		defer cancel()
	}

	cmd := exec.CommandContext(execCtx, binPath, params.Args...)
	if params.Cwd != "" {
		cmd.Dir = params.Cwd
	}

	// Setup environment, filtering out unsafe variables
	cmd.Env = os.Environ()
	for k, v := range params.Env {
		if isSafeEnvVar(k) {
			cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
		}
	}

	maxBuf := params.MaxBuffer
	if maxBuf <= 0 {
		maxBuf = defaultMaxBuffer
	} else if maxBuf > ceilingMaxBuffer {
		maxBuf = ceilingMaxBuffer
	}

	stdoutBuf := &limitedBuffer{limit: maxBuf}
	stderrBuf := &limitedBuffer{limit: maxBuf}
	cmd.Stdout = stdoutBuf
	cmd.Stderr = stderrBuf

	runErr := cmd.Run()

	stdoutStr := stdoutBuf.String()
	stderrStr := stderrBuf.String()

	exitCode := 0
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else if errors.Is(execCtx.Err(), context.Canceled) {
			exitCode = 130
			stderrStr = "Process cancelled\n" + stderrStr
		} else if errors.Is(execCtx.Err(), context.DeadlineExceeded) {
			exitCode = 124
			stderrStr = "Process timed out\n" + stderrStr
		} else {
			exitCode = 1
		}

		return &ExecResult{
			Stdout:   stdoutStr,
			Stderr:   stderrStr,
			ExitCode: exitCode,
		}, &ProcessExitError{
			ExitCode: exitCode,
			Stdout:   stdoutStr,
			Stderr:   stderrStr,
			Message:  fmt.Sprintf("Process %s failed with exit code %d: %s", params.File, exitCode, strings.TrimSpace(stderrStr)),
		}
	}

	return &ExecResult{
		Stdout:   stdoutStr,
		Stderr:   stderrStr,
		ExitCode: exitCode,
	}, nil
}

type limitedBuffer struct {
	buf   bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (n int, err error) {
	remaining := b.limit - b.buf.Len()
	if remaining <= 0 {
		return len(p), nil // discard overflow
	}
	if len(p) > remaining {
		_, _ = b.buf.Write(p[:remaining])
		return len(p), nil
	}
	return b.buf.Write(p)
}

func (b *limitedBuffer) String() string {
	return b.buf.String()
}

var _ io.Writer = (*limitedBuffer)(nil)
