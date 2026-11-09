// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/brychanrobot/jj-view/internal/fs"
	"github.com/brychanrobot/jj-view/internal/process"
	"github.com/brychanrobot/jj-view/internal/protocol"
	"github.com/brychanrobot/jj-view/internal/update"
	"github.com/brychanrobot/jj-view/internal/watcher"
)

const (
	maxRPCReadLimit = 100 * 1024 * 1024 // 100 MB
)

func (s *Server) handleRPC(w http.ResponseWriter, r *http.Request) {
	handlerStart := time.Now()
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !s.authenticateRequest(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	origin := r.Header.Get("Origin")
	if origin != "" && !s.isOriginAllowed(origin, r.Host) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}

	if !s.verifyCSRF(r) {
		http.Error(w, "Forbidden: invalid CSRF token", http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRPCReadLimit))
	if err != nil {
		http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		return
	}

	var req protocol.Request
	if err := json.Unmarshal(body, &req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(protocol.NewErrorResponse(nil, protocol.CodeParseError, "parse error", nil))
		return
	}

	if req.JSONRPC != "2.0" {
		if !req.IsNotification() {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(protocol.NewErrorResponse(req.ID, protocol.CodeInvalidRequest, "invalid jsonrpc version", nil))
		} else {
			w.WriteHeader(http.StatusNoContent)
		}
		return
	}

	clientID := r.Header.Get("X-Client-ID")
	if clientID == "" {
		clientID = r.URL.Query().Get("clientId")
	}

	dispatchStart := time.Now()
	res, rpcErr := s.dispatch(r.Context(), clientID, &req)
	dispatchDur := time.Since(dispatchStart)

	// Server-Timing lets the browser (DevTools Timing tab and
	// PerformanceResourceTiming.serverTiming) separate daemon time from
	// proxy/network transit. "dispatch" is the RPC method body; "total" is the
	// whole handler including auth and body parsing. Must be set before the
	// first write.
	setServerTiming := func() {
		total := time.Since(handlerStart)
		w.Header().Set("Server-Timing", fmt.Sprintf(
			"dispatch;dur=%.3f, total;dur=%.3f",
			float64(dispatchDur.Microseconds())/1000.0,
			float64(total.Microseconds())/1000.0,
		))
	}

	if req.IsNotification() {
		setServerTiming()
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var resp protocol.Response
	if rpcErr != nil {
		resp = protocol.NewErrorResponse(req.ID, rpcErr.Code, rpcErr.Message, rpcErr.Data)
	} else {
		resp = protocol.NewSuccessResponse(req.ID, res)
	}
	w.Header().Set("Content-Type", "application/json")
	setServerTiming()
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) dispatch(ctx context.Context, clientID string, req *protocol.Request) (any, *protocol.RPCError) {
	switch {
	case strings.HasPrefix(req.Method, "system."):
		return s.dispatchSystem(ctx, clientID, req)
	case strings.HasPrefix(req.Method, "http."):
		return s.dispatchHttp(ctx, clientID, req)
	case strings.HasPrefix(req.Method, "process."):
		return s.dispatchProcess(ctx, clientID, req)
	case strings.HasPrefix(req.Method, "fs."):
		return s.dispatchFs(ctx, clientID, req)
	case strings.HasPrefix(req.Method, "watcher."):
		return s.dispatchWatcher(ctx, clientID, req)
	case strings.HasPrefix(req.Method, "config."):
		return s.dispatchConfig(ctx, clientID, req)
	case strings.HasPrefix(req.Method, "state."):
		return s.dispatchState(ctx, clientID, req)
	case strings.HasPrefix(req.Method, "secrets."):
		return s.dispatchSecrets(ctx, clientID, req)
	case strings.HasPrefix(req.Method, "workspace."):
		return s.dispatchWorkspace(ctx, clientID, req)
	default:
		return nil, &protocol.RPCError{
			Code:    protocol.CodeMethodNotFound,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		}
	}
}

func (s *Server) dispatchSystem(ctx context.Context, clientID string, req *protocol.Request) (any, *protocol.RPCError) {
	switch req.Method {
	case "system.info":
		var plat string
		switch runtime.GOOS {
		case "windows":
			plat = "win32"
		case "darwin":
			plat = "darwin"
		default:
			plat = "linux"
		}
		return map[string]any{
			"platform":      plat,
			"version":       s.cfg.Version,
			"build":         s.assetVersion,
			"repoRoot":      s.cfg.RepoRoot,
			"tempDir":       s.fsMgr.DaemonTempDir(),
			"canSelfUpdate": s.updater != nil && s.updater.CanSelfUpdate(),
			"releaseAsset":  s.cfg.ReleaseAsset,
		}, nil

	case "system.checkUpdate":
		var params update.CheckOptions
		if len(req.Params) > 0 && string(req.Params) != "null" {
			if err := json.Unmarshal(req.Params, &params); err != nil {
				return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
			}
		}
		info, err := s.updater.Check(ctx, params)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		if info != nil && info.UpdateAvailable {
			s.broadcastNotification("system/updateAvailable", info)
		}
		return info, nil

	case "system.applyUpdate":
		var params struct {
			Prerelease    bool  `json:"prerelease,omitempty"`
			TriggerReload *bool `json:"triggerReload,omitempty"`
		}
		if len(req.Params) > 0 && string(req.Params) != "null" {
			if err := json.Unmarshal(req.Params, &params); err != nil {
				return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
			}
		}
		triggerReload := true
		if params.TriggerReload != nil {
			triggerReload = *params.TriggerReload
		}
		res, err := s.updater.Apply(ctx, update.ApplyOptions{
			Prerelease:    params.Prerelease,
			TriggerReload: triggerReload,
		})
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return res, nil

	default:
		return nil, &protocol.RPCError{
			Code:    protocol.CodeMethodNotFound,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		}
	}
}

func (s *Server) dispatchHttp(ctx context.Context, clientID string, req *protocol.Request) (any, *protocol.RPCError) {
	switch req.Method {
	case "http.fetch":
		var params httpFetchParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		res, rpcErr := s.httpFetch(ctx, params)
		if rpcErr != nil {
			return nil, rpcErr
		}
		return res, nil

	case "http.hasGitCredentials":
		var params struct {
			URL    string `json:"url"`
			GitDir string `json:"gitDir"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		available, rpcErr := s.httpHasGitCredentials(ctx, params.URL, params.GitDir)
		if rpcErr != nil {
			return nil, rpcErr
		}
		return map[string]bool{"available": available}, nil

	default:
		return nil, &protocol.RPCError{
			Code:    protocol.CodeMethodNotFound,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		}
	}
}

func (s *Server) dispatchProcess(ctx context.Context, clientID string, req *protocol.Request) (any, *protocol.RPCError) {
	switch req.Method {
	case "process.execFile":
		var params process.ExecParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		if params.Cwd == "" {
			params.Cwd = s.cfg.RepoRoot
		} else {
			// Validate cwd inside sandbox
			validatedCwd, err := s.fsMgr.ValidatePath(params.Cwd)
			if err != nil {
				return nil, &protocol.RPCError{Code: protocol.CodeSecurityError, Message: err.Error()}
			}
			params.Cwd = validatedCwd
		}

		res, err := s.procMgr.ExecFile(ctx, params)
		if err != nil {
			if errors.Is(ctx.Err(), context.Canceled) {
				return nil, &protocol.RPCError{Code: protocol.CodeRequestCancelled, Message: "request cancelled"}
			}
			var exitErr *process.ProcessExitError
			if errors.As(err, &exitErr) {
				return nil, &protocol.RPCError{
					Code:    protocol.CodeProcessError,
					Message: exitErr.Message,
					Data: map[string]any{
						"exitCode": exitErr.ExitCode,
						"stdout":   exitErr.Stdout,
						"stderr":   exitErr.Stderr,
					},
				}
			}
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return res, nil

	case "process.getHelperScriptPath":
		var params struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		path, err := s.procMgr.GetHelperScriptPath(params.Name)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]string{"path": path}, nil

	case "process.execFileInScratchDir":
		var params scratchExecParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		res, rpcErr := s.execFileInScratchDir(ctx, params)
		if rpcErr != nil {
			return nil, rpcErr
		}
		return res, nil

	default:
		return nil, &protocol.RPCError{
			Code:    protocol.CodeMethodNotFound,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		}
	}
}

func (s *Server) dispatchFs(ctx context.Context, clientID string, req *protocol.Request) (any, *protocol.RPCError) {
	switch req.Method {
	case "fs.readFiles":
		var params struct {
			Paths []string `json:"paths"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		return s.readFiles(params.Paths), nil

	case "fs.readFile":
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		data, err := s.fsMgr.ReadFile(params.Path)
		if err != nil {
			if os.IsNotExist(err) {
				return nil, &protocol.RPCError{
					Code:    protocol.CodeInternalError,
					Message: fmt.Sprintf("ENOENT: no such file or directory: %s", params.Path),
					Data:    map[string]any{"code": "ENOENT"},
				}
			}
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]string{"content": base64.StdEncoding.EncodeToString(data)}, nil

	case "fs.writeFile":
		var params struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		data, err := base64.StdEncoding.DecodeString(params.Content)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: "content must be base64 encoded"}
		}
		if err := s.fsMgr.WriteFile(params.Path, data); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]bool{"success": true}, nil

	case "fs.mkdir":
		var params struct {
			Path      string `json:"path"`
			Recursive bool   `json:"recursive"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		if err := s.fsMgr.Mkdir(params.Path, params.Recursive); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]bool{"success": true}, nil

	case "fs.stat":
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		st, err := s.fsMgr.Stat(params.Path)
		if err != nil {
			if os.IsNotExist(err) {
				return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: "ENOENT: file not found"}
			}
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return st, nil

	case "fs.lstat":
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		st, err := s.fsMgr.Lstat(params.Path)
		if err != nil {
			if os.IsNotExist(err) {
				return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: "ENOENT: file not found"}
			}
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return st, nil

	case "fs.readdir":
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		files, err := s.fsMgr.Readdir(params.Path)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string][]string{"files": files}, nil

	case "fs.exists":
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		exists := s.fsMgr.Exists(params.Path)
		return map[string]bool{"exists": exists}, nil

	case "fs.realpath":
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		resolved, err := s.fsMgr.Realpath(params.Path)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]string{"resolvedPath": resolved}, nil

	case "fs.mkdtemp":
		var params struct {
			Prefix string `json:"prefix"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		dir, err := s.fsMgr.Mkdtemp(params.Prefix)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]string{"path": dir}, nil

	case "fs.rm":
		var params struct {
			Path      string `json:"path"`
			Recursive bool   `json:"recursive"`
			Force     bool   `json:"force"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		if err := s.fsMgr.Rm(params.Path, params.Recursive, params.Force); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]bool{"success": true}, nil

	case "fs.findFiles":
		var params struct {
			BaseDir    string   `json:"baseDir"`
			Pattern    string   `json:"pattern"`
			MaxResults int      `json:"maxResults,omitempty"`
			Excludes   []string `json:"excludes,omitempty"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		files, err := s.fsMgr.FindFiles(fs.FindFilesOptions{
			Context:    ctx,
			BaseDir:    params.BaseDir,
			Pattern:    params.Pattern,
			MaxResults: params.MaxResults,
			Excludes:   params.Excludes,
		})
		if err != nil {
			if errors.Is(ctx.Err(), context.Canceled) {
				return nil, &protocol.RPCError{Code: protocol.CodeRequestCancelled, Message: "request cancelled"}
			}
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string][]string{"files": files}, nil

	case "fs.fuzzyFindFiles":
		var params struct {
			BaseDir    string   `json:"baseDir"`
			Query      string   `json:"query"`
			MaxResults int      `json:"maxResults,omitempty"`
			Excludes   []string `json:"excludes,omitempty"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		matches, err := s.fsMgr.FuzzyFindFiles(fs.FuzzyFindOptions{
			Context:    ctx,
			BaseDir:    params.BaseDir,
			Query:      params.Query,
			MaxResults: params.MaxResults,
			Excludes:   params.Excludes,
		})
		if err != nil {
			if errors.Is(ctx.Err(), context.Canceled) {
				return nil, &protocol.RPCError{Code: protocol.CodeRequestCancelled, Message: "request cancelled"}
			}
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string][]fs.FuzzyFileMatch{"files": matches}, nil

	default:
		return nil, &protocol.RPCError{
			Code:    protocol.CodeMethodNotFound,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		}
	}
}

func (s *Server) dispatchWatcher(ctx context.Context, clientID string, req *protocol.Request) (any, *protocol.RPCError) {
	switch req.Method {
	case "watcher.watch":
		var params struct {
			DirPath string   `json:"dirPath"`
			Ignore  []string `json:"ignore"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		validatedDir, err := s.fsMgr.ValidatePath(params.DirPath)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeSecurityError, Message: err.Error()}
		}
		subID, err := s.watcherHub.Watch(validatedDir, watcher.WatchOptions{Context: ctx, Ignore: params.Ignore}, func(reportedSubID string, events []watcher.FileEvent) {
			s.notifyClient(clientID, "watcher.change", map[string]any{
				"subscriptionId": reportedSubID,
				"events":         events,
			})
		})
		if err != nil {
			if errors.Is(ctx.Err(), context.Canceled) {
				return nil, &protocol.RPCError{Code: protocol.CodeRequestCancelled, Message: "request cancelled"}
			}
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		s.trackClientSubscription(clientID, subID)
		return map[string]string{"subscriptionId": subID}, nil

	case "watcher.unwatch":
		var params struct {
			SubscriptionID string `json:"subscriptionId"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		s.untrackClientSubscription(clientID, params.SubscriptionID)
		s.watcherHub.Unwatch(params.SubscriptionID)
		return map[string]bool{"success": true}, nil

	default:
		return nil, &protocol.RPCError{
			Code:    protocol.CodeMethodNotFound,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		}
	}
}

func (s *Server) dispatchConfig(ctx context.Context, clientID string, req *protocol.Request) (any, *protocol.RPCError) {
	switch req.Method {
	case "config.get":
		var params struct {
			Key           string `json:"key"`
			Scope         string `json:"scope,omitempty"`
			WorkspaceRoot string `json:"workspaceRoot,omitempty"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		wsRoot := ""
		if params.WorkspaceRoot != "" {
			if validated, err := s.fsMgr.ValidatePath(params.WorkspaceRoot); err == nil {
				wsRoot = validated
			}
		}
		val, ok := s.configStore.GetScopedForWorkspace(params.Scope, params.Key, wsRoot)
		return map[string]any{"value": val, "found": ok}, nil

	case "config.set":
		var params struct {
			Key           string `json:"key"`
			Value         any    `json:"value"`
			Scope         string `json:"scope,omitempty"`
			WorkspaceRoot string `json:"workspaceRoot,omitempty"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		wsRoot := ""
		if params.WorkspaceRoot != "" {
			validated, err := s.fsMgr.ValidatePath(params.WorkspaceRoot)
			if err != nil {
				return nil, &protocol.RPCError{Code: protocol.CodeSecurityError, Message: err.Error()}
			}
			wsRoot = validated
		}
		if err := s.configStore.SetScopedForWorkspace(params.Scope, params.Key, params.Value, wsRoot); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]bool{"success": true}, nil

	case "config.getAll":
		var params struct {
			Scope         string `json:"scope,omitempty"`
			WorkspaceRoot string `json:"workspaceRoot,omitempty"`
		}
		if len(req.Params) > 0 {
			_ = json.Unmarshal(req.Params, &params)
		}
		wsRoot := ""
		if params.WorkspaceRoot != "" {
			if validated, err := s.fsMgr.ValidatePath(params.WorkspaceRoot); err == nil {
				wsRoot = validated
			}
		}
		return s.configStore.GetAllScopedForWorkspace(params.Scope, wsRoot), nil

	default:
		return nil, &protocol.RPCError{
			Code:    protocol.CodeMethodNotFound,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		}
	}
}

func (s *Server) dispatchState(ctx context.Context, clientID string, req *protocol.Request) (any, *protocol.RPCError) {
	switch req.Method {
	case "state.get":
		var params struct {
			Key string `json:"key"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		val, ok := s.stateStore.Get(params.Key)
		if !ok {
			return map[string]any{"found": false}, nil
		}
		return map[string]any{"value": val, "found": true}, nil

	case "state.set":
		var params struct {
			Key   string          `json:"key"`
			Value json.RawMessage `json:"value"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		if err := s.stateStore.Set(params.Key, params.Value); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]bool{"success": true}, nil

	case "state.delete":
		var params struct {
			Key string `json:"key"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		if err := s.stateStore.Delete(params.Key); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]bool{"success": true}, nil

	case "state.getAll":
		return s.stateStore.GetAll(), nil

	default:
		return nil, &protocol.RPCError{
			Code:    protocol.CodeMethodNotFound,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		}
	}
}

func (s *Server) dispatchSecrets(ctx context.Context, clientID string, req *protocol.Request) (any, *protocol.RPCError) {
	switch req.Method {
	case "secrets.get":
		var params struct {
			Key string `json:"key"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		val, ok := s.secretStore.Get(params.Key)
		if !ok {
			return map[string]any{"found": false}, nil
		}
		return map[string]any{"value": val, "found": true}, nil

	case "secrets.has":
		var params struct {
			Key string `json:"key"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		_, ok := s.secretStore.Get(params.Key)
		return map[string]any{"found": ok}, nil

	case "secrets.store":
		var params struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		if err := s.secretStore.Store(params.Key, params.Value); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]bool{"success": true}, nil

	case "secrets.delete":
		var params struct {
			Key string `json:"key"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		if err := s.secretStore.Delete(params.Key); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]bool{"success": true}, nil

	default:
		return nil, &protocol.RPCError{
			Code:    protocol.CodeMethodNotFound,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		}
	}
}

func (s *Server) dispatchWorkspace(ctx context.Context, clientID string, req *protocol.Request) (any, *protocol.RPCError) {
	switch req.Method {
	case "workspace.addAllowedRoot":
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		if params.Path == "" {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: "path is required"}
		}
		absPath, err := filepath.Abs(params.Path)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		fi, err := os.Stat(absPath)
		if err != nil || !fi.IsDir() {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: "path does not exist or is not a directory"}
		}
		resolvedPath, err := filepath.EvalSymlinks(absPath)
		if err != nil {
			resolvedPath = absPath
		}
		s.fsMgr.AddAllowedRoot(absPath)
		if resolvedPath != absPath {
			s.fsMgr.AddAllowedRoot(resolvedPath)
		}
		if s.configStore != nil {
			s.configStore.WatchWorkspaceRoot(resolvedPath)
		}
		s.maybeWarmRepoRoot(resolvedPath)
		return map[string]any{"success": true, "path": resolvedPath}, nil

	default:
		return nil, &protocol.RPCError{
			Code:    protocol.CodeMethodNotFound,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		}
	}
}
