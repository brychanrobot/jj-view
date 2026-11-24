// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/brychanrobot/jj-view/internal/protocol"
)

func init() {
	// If tests run in an Antigravity subagent session where ANTIGRAVITY_CSRF_TOKEN
	// or ANTIGRAVITY_SIDECAR_UI_TOKEN is exported in the ambient process environment,
	// clear them so unit test servers default to isolated non-sidecar test mode.
	os.Unsetenv("ANTIGRAVITY_CSRF_TOKEN")
	os.Unsetenv("ANTIGRAVITY_SIDECAR_UI_TOKEN")
}

func rawRPCID(val string) *json.RawMessage {
	raw := json.RawMessage(val)
	return &raw
}

func test_dispatch_domain_routing(t *testing.T) {
	tempDir := t.TempDir()
	cfg := Config{
		RepoRoot:    tempDir,
		UserDataDir: filepath.Join(tempDir, "user_data"),
		Version:     "test-ver",
	}
	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Close(closeCtx)
	}()

	ctx := context.Background()

	// 1. system domain dispatch
	reqSystem := &protocol.Request{
		JSONRPC: "2.0",
		ID:      rawRPCID("1"),
		Method:  "system.info",
	}
	resSystem, rpcErr := srv.dispatch(ctx, "test-client", reqSystem)
	if rpcErr != nil {
		t.Fatalf("expected nil rpcErr for system.info, got: %v", rpcErr)
	}
	mSystem, ok := resSystem.(map[string]any)
	if !ok || mSystem["version"] != "test-ver" {
		t.Fatalf("expected system.info version=test-ver, got: %v", resSystem)
	}

	// 2. config domain dispatch
	reqConfig := &protocol.Request{
		JSONRPC: "2.0",
		ID:      rawRPCID("2"),
		Method:  "config.getAll",
	}
	resConfig, rpcErr := srv.dispatch(ctx, "test-client", reqConfig)
	if rpcErr != nil {
		t.Fatalf("expected nil rpcErr for config.getAll, got: %v", rpcErr)
	}
	if _, ok := resConfig.(map[string]any); !ok {
		t.Fatalf("expected map[string]any for config.getAll, got: %T", resConfig)
	}

	// 3. state domain dispatch
	reqState := &protocol.Request{
		JSONRPC: "2.0",
		ID:      rawRPCID("3"),
		Method:  "state.getAll",
	}
	resState, rpcErr := srv.dispatch(ctx, "test-client", reqState)
	if rpcErr != nil {
		t.Fatalf("expected nil rpcErr for state.getAll, got: %v", rpcErr)
	}
	if _, ok := resState.(map[string]json.RawMessage); !ok {
		t.Fatalf("expected map[string]json.RawMessage for state.getAll, got: %T", resState)
	}

	// 4. unknown method dispatch
	unknownReq := &protocol.Request{
		JSONRPC: "2.0",
		ID:      rawRPCID("4"),
		Method:  "unknown.method",
	}
	_, rpcErr = srv.dispatch(ctx, "test-client", unknownReq)
	if rpcErr == nil || rpcErr.Code != protocol.CodeMethodNotFound {
		t.Fatalf("expected CodeMethodNotFound for unknown.method, got: %v", rpcErr)
	}
}

func TestDispatchDomainRouting(t *testing.T) {
	test_dispatch_domain_routing(t)
}

func TestRPCDispatch_HTTPHandler(t *testing.T) {
	tempDir := t.TempDir()
	srv, err := NewServer(Config{
		RepoRoot:     tempDir,
		UserDataDir:  filepath.Join(tempDir, "user_data"),
		SessionToken: "test-rpc-token",
		CSRFToken:    "test-csrf-token",
	})
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Close(closeCtx)
	}()

	// 1. OPTIONS returns 204
	reqOpt := httptest.NewRequest(http.MethodOptions, "/api/rpc", nil)
	recOpt := httptest.NewRecorder()
	srv.handleRPC(recOpt, reqOpt)
	if recOpt.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS expected 204, got %d", recOpt.Code)
	}

	// 2. GET returns 405 Method Not Allowed
	reqGet := httptest.NewRequest(http.MethodGet, "/api/rpc", nil)
	recGet := httptest.NewRecorder()
	srv.handleRPC(recGet, reqGet)
	if recGet.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET expected 405, got %d", recGet.Code)
	}

	// 3. Unauthenticated POST returns 401
	reqUnauth := httptest.NewRequest(http.MethodPost, "/api/rpc", bytes.NewBufferString("{}"))
	recUnauth := httptest.NewRecorder()
	srv.handleRPC(recUnauth, reqUnauth)
	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("Unauthenticated POST expected 401, got %d", recUnauth.Code)
	}

	// 4. Missing CSRF token returns 403
	reqNoCSRF := httptest.NewRequest(http.MethodPost, "/api/rpc", bytes.NewBufferString("{}"))
	reqNoCSRF.Header.Set("Authorization", "Bearer test-rpc-token")
	recNoCSRF := httptest.NewRecorder()
	srv.handleRPC(recNoCSRF, reqNoCSRF)
	if recNoCSRF.Code != http.StatusForbidden {
		t.Fatalf("Missing CSRF expected 403, got %d", recNoCSRF.Code)
	}

	// 5. Parse error returns jsonrpc parse error response
	reqParseErr := httptest.NewRequest(http.MethodPost, "/api/rpc", bytes.NewBufferString("not-json"))
	reqParseErr.Header.Set("Authorization", "Bearer test-rpc-token")
	reqParseErr.Header.Set("X-CSRF-Token", "test-csrf-token")
	recParseErr := httptest.NewRecorder()
	srv.handleRPC(recParseErr, reqParseErr)
	var respParse protocol.Response
	_ = json.Unmarshal(recParseErr.Body.Bytes(), &respParse)
	if respParse.Error == nil || respParse.Error.Code != protocol.CodeParseError {
		t.Fatalf("expected CodeParseError, got %v", respParse.Error)
	}

	// 6. Invalid JSONRPC version returns CodeInvalidRequest
	badVersionReq := map[string]any{
		"jsonrpc": "1.0",
		"id":      "1",
		"method":  "system.info",
	}
	bodyBadVer, _ := json.Marshal(badVersionReq)
	reqBadVer := httptest.NewRequest(http.MethodPost, "/api/rpc", bytes.NewReader(bodyBadVer))
	reqBadVer.Header.Set("Authorization", "Bearer test-rpc-token")
	reqBadVer.Header.Set("X-CSRF-Token", "test-csrf-token")
	recBadVer := httptest.NewRecorder()
	srv.handleRPC(recBadVer, reqBadVer)
	var respBadVer protocol.Response
	_ = json.Unmarshal(recBadVer.Body.Bytes(), &respBadVer)
	if respBadVer.Error == nil || respBadVer.Error.Code != protocol.CodeInvalidRequest {
		t.Fatalf("expected CodeInvalidRequest, got %v", respBadVer.Error)
	}

	// 7. Notification returns 204 No Content
	notifPayload := map[string]any{
		"jsonrpc": "2.0",
		"method":  "system.unknownNotification",
	}
	bodyNotif, _ := json.Marshal(notifPayload)
	reqNotif := httptest.NewRequest(http.MethodPost, "/api/rpc", bytes.NewReader(bodyNotif))
	reqNotif.Header.Set("Authorization", "Bearer test-rpc-token")
	reqNotif.Header.Set("X-CSRF-Token", "test-csrf-token")
	recNotif := httptest.NewRecorder()
	srv.handleRPC(recNotif, reqNotif)
	if recNotif.Code != http.StatusNoContent {
		t.Fatalf("notification expected 204 No Content, got %d", recNotif.Code)
	}

	// 8. Server-Timing header is set on successful RPC response
	validRPC := map[string]any{
		"jsonrpc": "2.0",
		"id":      "10",
		"method":  "system.info",
	}
	bodyValid, _ := json.Marshal(validRPC)
	reqValid := httptest.NewRequest(http.MethodPost, "/api/rpc", bytes.NewReader(bodyValid))
	reqValid.Header.Set("Authorization", "Bearer test-rpc-token")
	reqValid.Header.Set("X-CSRF-Token", "test-csrf-token")
	recValid := httptest.NewRecorder()
	srv.handleRPC(recValid, reqValid)
	if recValid.Code != http.StatusOK {
		t.Fatalf("valid RPC expected 200 OK, got %d", recValid.Code)
	}
	serverTiming := recValid.Header().Get("Server-Timing")
	if !strings.Contains(serverTiming, "dispatch;dur=") || !strings.Contains(serverTiming, "total;dur=") {
		t.Errorf("Server-Timing header missing or invalid: %q", serverTiming)
	}
}

func TestRPCDispatch_FsAndSecretsDomain(t *testing.T) {
	tempDir := t.TempDir()
	srv, err := NewServer(Config{
		RepoRoot:    tempDir,
		UserDataDir: filepath.Join(tempDir, "user_data"),
	})
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Close(closeCtx)
	}()

	ctx := context.Background()

	// 1. fs.writeFile
	targetFile := filepath.Join(tempDir, "sample.txt")
	writeContent := base64.StdEncoding.EncodeToString([]byte("hello jj-view"))
	paramsWrite, _ := json.Marshal(map[string]string{
		"path":    targetFile,
		"content": writeContent,
	})
	reqWrite := &protocol.Request{
		JSONRPC: "2.0",
		ID:      rawRPCID("101"),
		Method:  "fs.writeFile",
		Params:  paramsWrite,
	}
	resWrite, rpcErr := srv.dispatch(ctx, "c1", reqWrite)
	if rpcErr != nil {
		t.Fatalf("fs.writeFile failed: %v", rpcErr)
	}
	if m, ok := resWrite.(map[string]bool); !ok || !m["success"] {
		t.Fatalf("fs.writeFile returned unexpected result: %v", resWrite)
	}

	// 2. fs.exists
	paramsExists, _ := json.Marshal(map[string]string{"path": targetFile})
	reqExists := &protocol.Request{
		JSONRPC: "2.0",
		ID:      rawRPCID("102"),
		Method:  "fs.exists",
		Params:  paramsExists,
	}
	resExists, rpcErr := srv.dispatch(ctx, "c1", reqExists)
	if rpcErr != nil {
		t.Fatalf("fs.exists failed: %v", rpcErr)
	}
	if m, ok := resExists.(map[string]bool); !ok || !m["exists"] {
		t.Fatalf("fs.exists returned %v, want exists=true", resExists)
	}

	// 3. fs.readFile
	paramsRead, _ := json.Marshal(map[string]string{"path": targetFile})
	reqRead := &protocol.Request{
		JSONRPC: "2.0",
		ID:      rawRPCID("103"),
		Method:  "fs.readFile",
		Params:  paramsRead,
	}
	resRead, rpcErr := srv.dispatch(ctx, "c1", reqRead)
	if rpcErr != nil {
		t.Fatalf("fs.readFile failed: %v", rpcErr)
	}
	mRead, ok := resRead.(map[string]string)
	if !ok || mRead["content"] != writeContent {
		t.Fatalf("fs.readFile returned unexpected content: %v", resRead)
	}

	// 4. secrets.store
	paramsSecretStore, _ := json.Marshal(map[string]string{
		"key":   "api_key",
		"value": "secret_value_123",
	})
	reqSecretStore := &protocol.Request{
		JSONRPC: "2.0",
		ID:      rawRPCID("104"),
		Method:  "secrets.store",
		Params:  paramsSecretStore,
	}
	resSecretStore, rpcErr := srv.dispatch(ctx, "c1", reqSecretStore)
	if rpcErr != nil {
		t.Fatalf("secrets.store failed: %v", rpcErr)
	}
	if m, ok := resSecretStore.(map[string]bool); !ok || !m["success"] {
		t.Fatalf("secrets.store returned %v", resSecretStore)
	}

	// 5. secrets.has
	paramsSecretHas, _ := json.Marshal(map[string]string{"key": "api_key"})
	reqSecretHas := &protocol.Request{
		JSONRPC: "2.0",
		ID:      rawRPCID("105"),
		Method:  "secrets.has",
		Params:  paramsSecretHas,
	}
	resSecretHas, rpcErr := srv.dispatch(ctx, "c1", reqSecretHas)
	if rpcErr != nil {
		t.Fatalf("secrets.has failed: %v", rpcErr)
	}
	if m, ok := resSecretHas.(map[string]any); !ok || m["found"] != true {
		t.Fatalf("secrets.has returned %v, want found=true", resSecretHas)
	}
}

func TestRPCDispatch_WorkspaceDomain(t *testing.T) {
	tempDir := t.TempDir()
	srv, err := NewServer(Config{
		RepoRoot:    tempDir,
		UserDataDir: filepath.Join(tempDir, "user_data"),
	})
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Close(closeCtx)
	}()

	ctx := context.Background()

	// 1. Missing path returns CodeInvalidParams
	paramsEmpty, _ := json.Marshal(map[string]string{"path": ""})
	reqEmpty := &protocol.Request{
		JSONRPC: "2.0",
		ID:      rawRPCID("201"),
		Method:  "workspace.addAllowedRoot",
		Params:  paramsEmpty,
	}
	_, rpcErr := srv.dispatch(ctx, "c1", reqEmpty)
	if rpcErr == nil || rpcErr.Code != protocol.CodeInvalidParams {
		t.Fatalf("expected CodeInvalidParams for empty path, got %v", rpcErr)
	}

	// 2. Non-existent path returns CodeInvalidParams
	paramsNonExist, _ := json.Marshal(map[string]string{"path": filepath.Join(tempDir, "does-not-exist")})
	reqNonExist := &protocol.Request{
		JSONRPC: "2.0",
		ID:      rawRPCID("202"),
		Method:  "workspace.addAllowedRoot",
		Params:  paramsNonExist,
	}
	_, rpcErr = srv.dispatch(ctx, "c1", reqNonExist)
	if rpcErr == nil || rpcErr.Code != protocol.CodeInvalidParams {
		t.Fatalf("expected CodeInvalidParams for non-existent path, got %v", rpcErr)
	}

	// 3. Valid directory succeeds
	validSubDir := filepath.Join(tempDir, "extra-root")
	_ = os.MkdirAll(validSubDir, 0755)
	paramsValid, _ := json.Marshal(map[string]string{"path": validSubDir})
	reqValid := &protocol.Request{
		JSONRPC: "2.0",
		ID:      rawRPCID("203"),
		Method:  "workspace.addAllowedRoot",
		Params:  paramsValid,
	}
	resValid, rpcErr := srv.dispatch(ctx, "c1", reqValid)
	if rpcErr != nil {
		t.Fatalf("workspace.addAllowedRoot failed: %v", rpcErr)
	}
	mValid, ok := resValid.(map[string]any)
	if !ok || mValid["success"] != true {
		t.Fatalf("expected success=true, got %v", resValid)
	}
}

func TestWorkspaceDeleteRPC(t *testing.T) {
	if _, err := exec.LookPath("jj"); err != nil {
		t.Skip("jj executable not found on PATH")
	}

	parentDir := t.TempDir()
	mainRepoDir := filepath.Join(parentDir, "main-repo")
	if err := os.MkdirAll(mainRepoDir, 0755); err != nil {
		t.Fatalf("mkdir mainRepoDir: %v", err)
	}

	runJJ := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("jj", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"JJ_USER=Test User",
			"JJ_EMAIL=test@example.com",
		)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("jj %v in %s failed: %v\n%s", args, dir, err, string(out))
		}
		return string(out)
	}

	runJJ(mainRepoDir, "git", "init")
	if err := os.MkdirAll(filepath.Join(mainRepoDir, ".workspaces"), 0755); err != nil {
		t.Fatalf("mkdir .workspaces: %v", err)
	}
	nestedWsDir := filepath.Join(mainRepoDir, ".workspaces", "nested-ws")
	siblingWsDir := filepath.Join(parentDir, "sibling-ws")
	allowedSiblingWsDir := filepath.Join(parentDir, "allowed-sibling-ws")
	activeSecondaryWsDir := filepath.Join(parentDir, "active-secondary-ws")

	runJJ(mainRepoDir, "workspace", "add", nestedWsDir, "--name", "nested-ws")
	runJJ(mainRepoDir, "workspace", "add", siblingWsDir, "--name", "sibling-ws")
	runJJ(mainRepoDir, "workspace", "add", allowedSiblingWsDir, "--name", "allowed-sibling-ws")
	runJJ(mainRepoDir, "workspace", "add", activeSecondaryWsDir, "--name", "active-secondary-ws")

	callDelete := func(srv *Server, id string, repoRoot string, workspaceName string) (any, *protocol.RPCError) {
		t.Helper()
		params, _ := json.Marshal(map[string]string{
			"repoRoot":      repoRoot,
			"workspaceName": workspaceName,
		})
		return srv.dispatch(context.Background(), "c1", &protocol.Request{
			JSONRPC: "2.0",
			ID:      rawRPCID(id),
			Method:  "workspace.delete",
			Params:  params,
		})
	}

	hasWorkspace := func(wsList string, name string) bool {
		for _, line := range strings.Split(wsList, "\n") {
			if strings.HasPrefix(line, name+":") || strings.HasPrefix(line, name+" (") {
				return true
			}
		}
		return false
	}

	t.Run("from main repo: nested, sibling, allowed sibling, active, and invalid cases", func(t *testing.T) {
		srv, err := NewServer(Config{
			RepoRoot:    mainRepoDir,
			UserDataDir: filepath.Join(parentDir, "user-data-main"),
		})
		if err != nil {
			t.Fatalf("NewServer: %v", err)
		}
		defer func() {
			closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = srv.Close(closeCtx)
		}()

		// 1. Delete nested workspace
		res, rpcErr := callDelete(srv, "1", mainRepoDir, "nested-ws")
		if rpcErr != nil {
			t.Fatalf("delete nested-ws failed: %+v", rpcErr)
		}
		if m, ok := res.(map[string]any); !ok || m["success"] != true {
			t.Fatalf("expected success=true, got %v", res)
		} else if paths, ok := m["deletedPaths"].([]string); !ok || len(paths) == 0 {
			t.Fatalf("expected non-empty deletedPaths, got %v", m["deletedPaths"])
		}
		if _, err := os.Stat(nestedWsDir); !os.IsNotExist(err) {
			t.Fatalf("expected nestedWsDir to be deleted, stat err=%v", err)
		}
		wsList := runJJ(mainRepoDir, "workspace", "list")
		if hasWorkspace(wsList, "nested-ws") {
			t.Fatalf("expected nested-ws to be forgotten, got:\n%s", wsList)
		}

		// 1b. Missing workspace directory on disk: matches installed jj's `workspace root` behavior
		staleWsDir := filepath.Join(mainRepoDir, ".workspaces", "stale-ws")
		runJJ(mainRepoDir, "workspace", "add", staleWsDir, "--name", "stale-ws")
		if err := os.RemoveAll(staleWsDir); err != nil {
			t.Fatalf("remove staleWsDir: %v", err)
		}
		probeCmd := exec.Command("jj", "workspace", "root", "--ignore-working-copy", "--name=stale-ws")
		probeCmd.Dir = mainRepoDir
		_, probeErr := probeCmd.CombinedOutput()
		_, rpcErr = callDelete(srv, "1b", mainRepoDir, "stale-ws")
		wsList = runJJ(mainRepoDir, "workspace", "list")
		if probeErr == nil {
			if rpcErr != nil {
				t.Fatalf("expected stale-ws delete to succeed when jj resolves root, got %+v", rpcErr)
			}
			if hasWorkspace(wsList, "stale-ws") {
				t.Fatalf("expected stale-ws to be forgotten, got:\n%s", wsList)
			}
		} else {
			if rpcErr == nil || !strings.Contains(rpcErr.Message, "Could not find workspace directory") {
				t.Fatalf("expected 'Could not find workspace directory' error for stale-ws, got %+v", rpcErr)
			}
			if !hasWorkspace(wsList, "stale-ws") {
				t.Fatalf("expected stale-ws to remain tracked when directory is missing, got:\n%s", wsList)
			}
			runJJ(mainRepoDir, "workspace", "forget", "stale-ws")
		}

		// 2. Delete sibling workspace outside mainRepoDir
		if _, rpcErr := callDelete(srv, "2", mainRepoDir, "sibling-ws"); rpcErr != nil {
			t.Fatalf("delete sibling-ws failed: %+v", rpcErr)
		}
		if _, err := os.Stat(siblingWsDir); !os.IsNotExist(err) {
			t.Fatalf("expected siblingWsDir to be deleted, stat err=%v", err)
		}
		wsList = runJJ(mainRepoDir, "workspace", "list")
		if hasWorkspace(wsList, "sibling-ws") {
			t.Fatalf("expected sibling-ws to be forgotten, got:\n%s", wsList)
		}

		// 3. Delete workspace previously registered via workspace.addAllowedRoot
		addParams, _ := json.Marshal(map[string]string{"path": allowedSiblingWsDir})
		if _, rpcErr := srv.dispatch(context.Background(), "c1", &protocol.Request{
			JSONRPC: "2.0",
			ID:      rawRPCID("3a"),
			Method:  "workspace.addAllowedRoot",
			Params:  addParams,
		}); rpcErr != nil {
			t.Fatalf("addAllowedRoot failed: %+v", rpcErr)
		}
		if _, rpcErr := callDelete(srv, "3b", mainRepoDir, "allowed-sibling-ws"); rpcErr != nil {
			t.Fatalf("delete allowed-sibling-ws failed: %+v", rpcErr)
		}
		if _, err := os.Stat(allowedSiblingWsDir); !os.IsNotExist(err) {
			t.Fatalf("expected allowedSiblingWsDir to be deleted, stat err=%v", err)
		}
		canonicalAllowed, _ := filepath.EvalSymlinks(allowedSiblingWsDir)
		for _, root := range srv.fsMgr.AllowedRoots() {
			if root == allowedSiblingWsDir || (canonicalAllowed != "" && root == canonicalAllowed) {
				t.Fatalf("expected allowedSiblingWsDir to be removed from AllowedRoots, got %v", srv.fsMgr.AllowedRoots())
			}
		}

		// 4. Reject invalid params, outside repoRoot, unknown workspace, and active workspace
		if _, rpcErr := callDelete(srv, "4a", "", "default"); rpcErr == nil || rpcErr.Code != protocol.CodeInvalidParams {
			t.Fatalf("expected CodeInvalidParams for empty repoRoot, got %+v", rpcErr)
		}
		if _, rpcErr := callDelete(srv, "4b", mainRepoDir, ""); rpcErr == nil || rpcErr.Code != protocol.CodeInvalidParams {
			t.Fatalf("expected CodeInvalidParams for empty workspaceName, got %+v", rpcErr)
		}
		outsideDir := t.TempDir()
		if _, rpcErr := callDelete(srv, "4c", outsideDir, "default"); rpcErr == nil || rpcErr.Code != protocol.CodeSecurityError {
			t.Fatalf("expected CodeSecurityError for unallowed repoRoot, got %+v", rpcErr)
		}
		if _, rpcErr := callDelete(srv, "4d", mainRepoDir, "does-not-exist"); rpcErr == nil {
			t.Fatalf("expected error for unknown workspace")
		}
		if _, rpcErr := callDelete(srv, "4e", mainRepoDir, "default"); rpcErr == nil || rpcErr.Code != protocol.CodeSecurityError {
			t.Fatalf("expected CodeSecurityError when deleting active default workspace, got %+v", rpcErr)
		}
		if _, err := os.Stat(mainRepoDir); err != nil {
			t.Fatalf("expected mainRepoDir to still exist: %v", err)
		}
		wsList = runJJ(mainRepoDir, "workspace", "list")
		if !hasWorkspace(wsList, "default") {
			t.Fatalf("expected default workspace to remain tracked, got:\n%s", wsList)
		}
	})

	t.Run("from secondary workspace: deletes sibling and refuses deleting main repo owning .jj/repo", func(t *testing.T) {
		anotherSiblingDir := filepath.Join(parentDir, "another-sibling-ws")
		runJJ(mainRepoDir, "workspace", "add", anotherSiblingDir, "--name", "another-sibling-ws")

		srv, err := NewServer(Config{
			RepoRoot:    activeSecondaryWsDir,
			UserDataDir: filepath.Join(parentDir, "user-data-secondary"),
		})
		if err != nil {
			t.Fatalf("NewServer: %v", err)
		}
		defer func() {
			closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = srv.Close(closeCtx)
		}()

		// Can delete another sibling workspace
		if _, rpcErr := callDelete(srv, "5a", activeSecondaryWsDir, "another-sibling-ws"); rpcErr != nil {
			t.Fatalf("delete another-sibling-ws from secondary workspace failed: %+v", rpcErr)
		}
		if _, err := os.Stat(anotherSiblingDir); !os.IsNotExist(err) {
			t.Fatalf("expected anotherSiblingDir to be deleted, stat err=%v", err)
		}

		// Refuses deleting active secondary workspace
		if _, rpcErr := callDelete(srv, "5b", activeSecondaryWsDir, "active-secondary-ws"); rpcErr == nil || rpcErr.Code != protocol.CodeSecurityError {
			t.Fatalf("expected CodeSecurityError for active secondary workspace, got %+v", rpcErr)
		}

		// Refuses deleting main workspace containing .jj/repo directory
		if _, rpcErr := callDelete(srv, "5c", activeSecondaryWsDir, "default"); rpcErr == nil || rpcErr.Code != protocol.CodeSecurityError {
			t.Fatalf("expected CodeSecurityError when deleting main workspace from secondary, got %+v", rpcErr)
		}
		if _, err := os.Stat(filepath.Join(mainRepoDir, ".jj", "repo")); err != nil {
			t.Fatalf("expected main repo .jj/repo to remain intact: %v", err)
		}
		wsList := runJJ(activeSecondaryWsDir, "workspace", "list")
		if !hasWorkspace(wsList, "default") {
			t.Fatalf("expected default workspace to remain tracked, got:\n%s", wsList)
		}
	})
}
