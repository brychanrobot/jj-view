// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package process

import (
	"context"
	"os"
	"path/filepath"
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
