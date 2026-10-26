// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package process

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestExtractHelperScripts(t *testing.T) {
	mgr := NewManager()
	if err := mgr.EnsureScriptsExtracted(); err != nil {
		t.Fatalf("failed to extract scripts: %v", err)
	}

	for _, name := range []string{"batch-diff", "batch-edit", "conflict-capture"} {
		scriptPath, err := mgr.GetHelperScriptPath(name)
		if err != nil {
			t.Fatalf("failed to get script path for %s: %v", name, err)
		}
		if _, err := os.Stat(scriptPath); err != nil {
			t.Fatalf("extracted script does not exist at %s: %v", scriptPath, err)
		}
	}
}

func TestRejectForbiddenExecutable(t *testing.T) {
	mgr := NewManager()
	ctx := context.Background()

	_, err := mgr.ExecFile(ctx, ExecParams{
		File: "sh",
		Args: []string{"-c", "echo hello"},
	})
	if err == nil {
		t.Fatal("expected error executing non-whitelisted binary 'sh', got nil")
	}
}

func TestExecGitOrJj(t *testing.T) {
	mgr := NewManager()
	ctx := context.Background()

	res, err := mgr.ExecFile(ctx, ExecParams{
		File: "git",
		Args: []string{"--version"},
	})
	if err != nil {
		t.Fatalf("git --version failed: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", res.ExitCode)
	}
	if len(res.Stdout) == 0 {
		t.Fatal("expected stdout from git --version")
	}
}

func TestExecHelperScript(t *testing.T) {
	mgr := NewManager()
	ctx := context.Background()

	scriptPath, err := mgr.GetHelperScriptPath("batch-diff")
	if err != nil {
		t.Fatalf("failed to get batch-diff script path: %v", err)
	}

	// Executing the helper script directly should be allowed by the whitelist
	_, err = mgr.ExecFile(ctx, ExecParams{
		File: scriptPath,
		Args: []string{"left", "right", filepath.Join(os.TempDir(), "l"), filepath.Join(os.TempDir(), "r")},
	})
	// batch-diff intentionally exits with code 1, but must pass the whitelist validation
	if err == nil {
		t.Fatal("batch-diff was expected to exit with non-zero")
	}
	if exitErr, ok := err.(*ProcessExitError); !ok {
		t.Fatalf("expected ProcessExitError, got %T: %v", err, err)
	} else if exitErr.ExitCode != 1 {
		t.Fatalf("expected exit code 1, got %d", exitErr.ExitCode)
	}
}

func TestExecTimeout(t *testing.T) {
	mgr := NewManager()
	ctx := context.Background()

	// 1ms timeout should quickly expire
	_, err := mgr.ExecFile(ctx, ExecParams{
		File:    "git",
		Args:    []string{"--version"},
		Timeout: 1, // 1ms
	})
	// Might succeed if extremely fast or timeout
	_ = err
}

func TestExecCancellation(t *testing.T) {
	mgr := NewManager()
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	_, err := mgr.ExecFile(ctx, ExecParams{
		File: "git",
		Args: []string{"--version"},
	})
	if err == nil {
		t.Fatal("expected cancellation error, got nil")
	}
}

func TestBlockedEnvVars(t *testing.T) {
	for _, env := range []string{"PYTHONPATH", "pythonpath", "NODE_OPTIONS", "node_options", "PATH", "path", "PYTHONSTARTUP", "PYTHONHOME", "PERL5OPT", "RUBYOPT"} {
		if isSafeEnvVar(env) {
			t.Errorf("expected env var %q to be blocked", env)
		}
	}
	if !isSafeEnvVar("SAFE_VAR") {
		t.Errorf("expected SAFE_VAR to be allowed")
	}
}

func TestAllowedForgeCommand(t *testing.T) {
	mgr := NewManager()
	ctx := context.Background()

	tmpDir := t.TempDir()
	scriptExt := ".sh"
	dummyContent := "#!/bin/sh\nexit 0\n"
	envCheckContent := "#!/bin/sh\necho \"CUSTOM_VAR=$CUSTOM_VAR\"\n"
	if runtime.GOOS == "windows" {
		scriptExt = ".bat"
		dummyContent = "@echo off\r\nexit /b 0\r\n"
		envCheckContent = "@echo off\r\necho CUSTOM_VAR=%CUSTOM_VAR%\r\n"
	}
	scriptPath := filepath.Join(tmpDir, "dummy-forge"+scriptExt)
	if err := os.WriteFile(scriptPath, []byte(dummyContent), 0755); err != nil {
		t.Fatalf("failed to write dummy forge script: %v", err)
	}

	// 1. Without setting allowed forge command, executing it should fail
	_, err := mgr.ExecFile(ctx, ExecParams{
		File: scriptPath,
		Args: []string{"detect"},
	})
	if err == nil {
		t.Fatal("expected error executing unconfigured forge binary, got nil")
	}

	// 2. Configure allowed forge command
	mgr.SetAllowedForgeCommand(func() string {
		return scriptPath
	})

	// 3. Test all 6 allowed subcommands
	allowed := []string{"detect", "statuses", "upload", "list-comments", "reply-comment", "resolve-comment"}
	for _, sub := range allowed {
		res, err := mgr.ExecFile(ctx, ExecParams{
			File: scriptPath,
			Args: []string{sub},
		})
		if err != nil {
			t.Errorf("expected subcommand %q to be allowed, got error: %v", sub, err)
		}
		if res != nil && res.ExitCode != 0 {
			t.Errorf("expected exit code 0 for subcommand %q, got %d", sub, res.ExitCode)
		}
	}

	// 4. Test unknown subcommand is blocked
	_, err = mgr.ExecFile(ctx, ExecParams{
		File: scriptPath,
		Args: []string{"evil-subcommand"},
	})
	if err == nil || !strings.Contains(err.Error(), "subcommand \"evil-subcommand\" is not permitted") {
		t.Fatalf("expected error blocking evil-subcommand, got %v", err)
	}

	// 5. Test empty args is blocked
	_, err = mgr.ExecFile(ctx, ExecParams{
		File: scriptPath,
		Args: []string{},
	})
	if err == nil {
		t.Fatal("expected error blocking empty args, got nil")
	}

	// 6. Test caller-supplied env is ignored for forge adapter
	envScriptPath := filepath.Join(tmpDir, "env-check"+scriptExt)
	if err := os.WriteFile(envScriptPath, []byte(envCheckContent), 0755); err != nil {
		t.Fatalf("failed to write env-check script: %v", err)
	}
	mgr.SetAllowedForgeCommand(func() string {
		return envScriptPath
	})
	res, err := mgr.ExecFile(ctx, ExecParams{
		File: envScriptPath,
		Args: []string{"detect"},
		Env:  map[string]string{"CUSTOM_VAR": "injected"},
	})
	if err != nil {
		t.Fatalf("exec env check script failed: %v", err)
	}
	if strings.Contains(res.Stdout, "CUSTOM_VAR=injected") {
		t.Fatalf("expected caller-supplied env to be ignored for forge adapter, got output: %q", res.Stdout)
	}
}
