// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/brychanrobot/jj-view/internal/protocol"
)

func TestExecFileInScratchDirCreatesDirsAndSubstitutesTokens(t *testing.T) {
	srv, _ := setupTestServer(t)

	res := postRPC(t, srv, 1, "process.execFileInScratchDir", map[string]any{
		"file":             "git",
		"args":             []string{"init", "--quiet", "{{scratchDir}}/left/repo"},
		"scratchPrefix":    "scratch-test-",
		"subdirs":          []string{"left", "right"},
		"completionMarker": "left/repo/.git/HEAD",
	})
	if res.Error != nil {
		t.Fatalf("unexpected error: %+v", res.Error)
	}
	out := res.Result.(map[string]any)
	scratchDir := out["scratchDir"].(string)
	if !strings.HasPrefix(scratchDir, srv.fsMgr.DaemonTempDir()) {
		t.Fatalf("scratchDir %q not under daemon temp dir %q", scratchDir, srv.fsMgr.DaemonTempDir())
	}
	if out["exitCode"].(float64) != 0 {
		t.Fatalf("expected exitCode 0, got %v (stderr=%q)", out["exitCode"], out["stderr"])
	}
	if out["markerPresent"] != true {
		t.Fatalf("expected markerPresent=true, got %v", out["markerPresent"])
	}
	for _, sub := range []string{"left", "right"} {
		if st, err := os.Stat(filepath.Join(scratchDir, sub)); err != nil || !st.IsDir() {
			t.Fatalf("expected subdir %s to exist: %v", sub, err)
		}
	}
}

func TestExecFileInScratchDirSubstitutesHelperScript(t *testing.T) {
	srv, _ := setupTestServer(t)

	// `git var GIT_EDITOR` echoes core.editor, which lets us observe the substituted path.
	res := postRPC(t, srv, 1, "process.execFileInScratchDir", map[string]any{
		"file":          "git",
		"args":          []string{"-c", "core.editor={{helperScript}}", "var", "GIT_EDITOR"},
		"scratchPrefix": "scratch-test-",
		"subdirs":       []string{},
		"helperScript":  "batch-diff",
	})
	if res.Error != nil {
		t.Fatalf("unexpected error: %+v", res.Error)
	}
	out := res.Result.(map[string]any)
	stdout := out["stdout"].(string)
	if !strings.Contains(stdout, "batch-diff") || strings.Contains(stdout, "{{helperScript}}") {
		t.Fatalf("expected helper script path in stdout, got %q", stdout)
	}
}

func TestExecFileInScratchDirReportsNonZeroExitWithoutError(t *testing.T) {
	srv, _ := setupTestServer(t)

	res := postRPC(t, srv, 1, "process.execFileInScratchDir", map[string]any{
		"file":             "git",
		"args":             []string{"--definitely-not-a-flag"},
		"scratchPrefix":    "scratch-test-",
		"subdirs":          []string{"left"},
		"completionMarker": "left/.complete",
	})
	if res.Error != nil {
		t.Fatalf("non-zero exit must not be an RPC error, got %+v", res.Error)
	}
	out := res.Result.(map[string]any)
	if out["exitCode"].(float64) == 0 {
		t.Fatalf("expected non-zero exitCode")
	}
	if out["markerPresent"] != false {
		t.Fatalf("expected markerPresent=false, got %v", out["markerPresent"])
	}
	// The scratch dir is left for the client to decide (it may hold partial output).
	if _, err := os.Stat(out["scratchDir"].(string)); err != nil {
		t.Fatalf("expected scratch dir to still exist: %v", err)
	}
}

func TestExecFileInScratchDirRejectsEscapingPaths(t *testing.T) {
	srv, _ := setupTestServer(t)

	cases := []map[string]any{
		{"file": "git", "args": []string{"--version"}, "scratchPrefix": "p-", "subdirs": []string{"../escape"}},
		{"file": "git", "args": []string{"--version"}, "scratchPrefix": "p-", "subdirs": []string{"/abs"}},
		{"file": "git", "args": []string{"--version"}, "scratchPrefix": "p-", "subdirs": []string{}, "completionMarker": "../x"},
		{"file": "git", "args": []string{"--version"}, "scratchPrefix": "../p-", "subdirs": []string{}},
		{"file": "git", "args": []string{"--version"}, "scratchPrefix": "", "subdirs": []string{}},
	}
	for i, params := range cases {
		res := postRPC(t, srv, i, "process.execFileInScratchDir", params)
		if res.Error == nil || res.Error.Code != protocol.CodeInvalidParams {
			t.Fatalf("case %d: expected invalid params error, got %+v / %+v", i, res.Error, res.Result)
		}
	}
}

func TestReadFilesReturnsPerEntryResults(t *testing.T) {
	srv, tempRepo := setupTestServer(t)

	present := filepath.Join(tempRepo, "present.txt")
	if err := os.WriteFile(present, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(tempRepo, "missing.txt")
	outside := "/definitely/outside/sandbox.txt"

	res := postRPC(t, srv, 1, "fs.readFiles", map[string]any{
		"paths": []string{present, missing, outside},
	})
	if res.Error != nil {
		t.Fatalf("unexpected error: %+v", res.Error)
	}
	files := res.Result.(map[string]any)["files"].([]any)
	if len(files) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(files))
	}

	first := files[0].(map[string]any)
	decoded, _ := base64.StdEncoding.DecodeString(first["content"].(string))
	if string(decoded) != "hello" || first["error"] != nil {
		t.Fatalf("unexpected first entry: %+v", first)
	}

	second := files[1].(map[string]any)
	if second["content"] != nil {
		t.Fatalf("expected no content for missing file: %+v", second)
	}
	if code := second["error"].(map[string]any)["code"]; code != "ENOENT" {
		t.Fatalf("expected ENOENT for missing file, got %v", code)
	}

	third := files[2].(map[string]any)
	if third["content"] != nil || third["error"] == nil {
		t.Fatalf("expected error for path outside sandbox: %+v", third)
	}
	if code, ok := third["error"].(map[string]any)["code"]; ok && code == "ENOENT" {
		t.Fatalf("sandbox violation must not be reported as ENOENT: %+v", third)
	}
}
