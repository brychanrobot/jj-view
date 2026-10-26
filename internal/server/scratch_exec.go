// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/brychanrobot/jj-view/internal/process"
	"github.com/brychanrobot/jj-view/internal/protocol"
)

// Placeholders substituted into process arguments by execFileInScratchDir.
// Must match SCRATCH_DIR_TOKEN / HELPER_SCRIPT_TOKEN in src/core/host/host-system.ts.
const (
	scratchDirToken   = "{{scratchDir}}"
	helperScriptToken = "{{helperScript}}"
)

// scratchExecParams is the request body for process.execFileInScratchDir.
type scratchExecParams struct {
	process.ExecParams
	ScratchPrefix    string   `json:"scratchPrefix"`
	Subdirs          []string `json:"subdirs"`
	HelperScript     string   `json:"helperScript,omitempty"`
	CompletionMarker string   `json:"completionMarker,omitempty"`
}

// scratchExecResult is the response body for process.execFileInScratchDir.
// A non-zero exit is reported via ExitCode rather than as an RPC error so the
// client can decide based on MarkerPresent (helper scripts intentionally exit 1
// to abort jj operations after capturing their output).
type scratchExecResult struct {
	ScratchDir    string `json:"scratchDir"`
	Stdout        string `json:"stdout"`
	Stderr        string `json:"stderr"`
	ExitCode      int    `json:"exitCode"`
	MarkerPresent bool   `json:"markerPresent"`
}

// relativeInside rejects relative paths that are absolute or escape their base.
func relativeInside(rel string) error {
	if rel == "" {
		return errors.New("path cannot be empty")
	}
	if filepath.IsAbs(rel) || filepath.VolumeName(rel) != "" || strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, `\`) {
		return fmt.Errorf("path must be relative: %s", rel)
	}
	clean := filepath.Clean(rel)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes scratch directory: %s", rel)
	}
	return nil
}

// execFileInScratchDir performs mkdtemp + mkdir(subdirs) + helper script resolution +
// exec + completion marker check in a single call. This collapses what used to be
// six round trips for a cold diff open into one.
func (s *Server) execFileInScratchDir(ctx context.Context, params scratchExecParams) (*scratchExecResult, *protocol.RPCError) {
	if params.ScratchPrefix == "" || strings.ContainsAny(params.ScratchPrefix, `/\`) {
		return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: "scratchPrefix must be a non-empty name without path separators"}
	}
	for _, sub := range params.Subdirs {
		if err := relativeInside(sub); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: "invalid subdir: " + err.Error()}
		}
	}
	if params.CompletionMarker != "" {
		if err := relativeInside(params.CompletionMarker); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: "invalid completionMarker: " + err.Error()}
		}
	}

	if params.Cwd == "" {
		params.Cwd = s.cfg.RepoRoot
	} else {
		validatedCwd, err := s.fsMgr.ValidatePath(params.Cwd)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeSecurityError, Message: err.Error()}
		}
		params.Cwd = validatedCwd
	}

	helperScriptPath := ""
	if params.HelperScript != "" {
		p, err := s.procMgr.GetHelperScriptPath(params.HelperScript)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		helperScriptPath = p
	}

	scratchDir, err := s.fsMgr.Mkdtemp(params.ScratchPrefix)
	if err != nil {
		return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
	}
	cleanup := func() {
		_ = s.fsMgr.Rm(scratchDir, true, true)
	}

	for _, sub := range params.Subdirs {
		if err := s.fsMgr.Mkdir(filepath.Join(scratchDir, sub), true); err != nil {
			cleanup()
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
	}

	// Forward slashes are valid on every platform jj runs on and avoid TOML escaping
	// issues when the path lands inside a --config string literal.
	scratchDirArg := filepath.ToSlash(scratchDir)
	helperScriptArg := filepath.ToSlash(helperScriptPath)
	args := make([]string, len(params.Args))
	for i, a := range params.Args {
		a = strings.ReplaceAll(a, scratchDirToken, scratchDirArg)
		a = strings.ReplaceAll(a, helperScriptToken, helperScriptArg)
		args[i] = a
	}
	execParams := params.ExecParams
	execParams.Args = args

	res, execErr := s.procMgr.ExecFile(ctx, execParams)
	if execErr != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			cleanup()
			return nil, &protocol.RPCError{Code: protocol.CodeRequestCancelled, Message: "request cancelled"}
		}
		var exitErr *process.ProcessExitError
		if !errors.As(execErr, &exitErr) {
			cleanup()
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: execErr.Error()}
		}
		// Non-zero exit: fall through with the populated result; the client decides
		// whether that is a failure using exitCode + markerPresent.
	}

	markerPresent := false
	if params.CompletionMarker != "" {
		markerPresent = s.fsMgr.Exists(filepath.Join(scratchDir, params.CompletionMarker))
	}

	return &scratchExecResult{
		ScratchDir:    scratchDir,
		Stdout:        res.Stdout,
		Stderr:        res.Stderr,
		ExitCode:      res.ExitCode,
		MarkerPresent: markerPresent,
	}, nil
}

// readFileEntry is one element of the fs.readFiles response. Exactly one of
// Content or Error is set.
type readFileEntry struct {
	Content *string        `json:"content,omitempty"`
	Error   *readFileError `json:"error,omitempty"`
}

type readFileError struct {
	Code    string `json:"code,omitempty"`
	Message string `json:"message"`
}

func classifyReadError(err error) *readFileError {
	switch {
	case os.IsNotExist(err):
		return &readFileError{Code: "ENOENT", Message: err.Error()}
	case os.IsPermission(err):
		return &readFileError{Code: "EACCES", Message: err.Error()}
	default:
		return &readFileError{Message: err.Error()}
	}
}

// readFiles reads several files in one call. Failures are reported per entry so
// callers whose reads were coalesced into one RPC fail independently.
func (s *Server) readFiles(paths []string) map[string]any {
	files := make([]readFileEntry, len(paths))
	for i, p := range paths {
		data, err := s.fsMgr.ReadFile(p)
		if err != nil {
			files[i].Error = classifyReadError(err)
			continue
		}
		encoded := base64.StdEncoding.EncodeToString(data)
		files[i].Content = &encoded
	}
	return map[string]any{"files": files}
}
