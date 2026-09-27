// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/brychanrobot/jj-view/internal/protocol"
)

func setupTestServer(t *testing.T) (*Server, string) {
	tempRepo, err := os.MkdirTemp("", "jj-view-server-test")
	if err != nil {
		t.Fatalf("failed to create temp repo: %v", err)
	}

	_ = os.MkdirAll(filepath.Join(tempRepo, ".vscode"), 0755)
	tempDataDir := filepath.Join(tempRepo, "user-data")
	_ = os.MkdirAll(tempDataDir, 0700)

	cfg := Config{
		Host:           "127.0.0.1",
		Port:           0, // random port
		RepoRoot:       tempRepo,
		Version:        "test-version",
		UserDataDir:    tempDataDir,
		UserConfigPath: filepath.Join(tempDataDir, "user-config.json"),
		UserStatePath:  filepath.Join(tempDataDir, "state.json"),
		UserSecretPath: filepath.Join(tempDataDir, "credentials.json"),
	}

	srv, err := NewServer(cfg)
	if err != nil {
		os.RemoveAll(tempRepo)
		t.Fatalf("failed to create server: %v", err)
	}

	if err := srv.Listen(); err != nil {
		os.RemoveAll(tempRepo)
		t.Fatalf("failed to listen: %v", err)
	}

	go func() {
		_ = srv.Start()
	}()

	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Close(ctx)
		os.RemoveAll(tempRepo)
	})

	return srv, tempRepo
}

func TestServerHealthAndIndex(t *testing.T) {
	srv, _ := setupTestServer(t)
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", srv.Port())

	// 1. Health endpoint
	resp, err := http.Get(baseURL + "/api/health")
	if err != nil {
		t.Fatalf("health check failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health check expected 200, got %d", resp.StatusCode)
	}

	var health map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		t.Fatalf("failed to decode health JSON: %v", err)
	}
	if health["status"] != "ok" {
		t.Fatalf("unexpected health status: %v", health["status"])
	}

	// 2. Unauthenticated GET / must be rejected with 401
	unauthResp, err := http.Get(baseURL + "/")
	if err != nil {
		t.Fatalf("unauth fetch failed: %v", err)
	}
	defer unauthResp.Body.Close()
	if unauthResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected status 401 for unauth GET /, got %d", unauthResp.StatusCode)
	}

	// 3. Authenticated GET / with token serves index.html with injected config
	authURL := fmt.Sprintf("%s/?token=%s", baseURL, srv.SessionToken())
	respIndex, err := http.Get(authURL)
	if err != nil {
		t.Fatalf("index fetch failed: %v", err)
	}
	defer respIndex.Body.Close()
	if respIndex.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200 for auth GET /, got %d", respIndex.StatusCode)
	}
	body, _ := io.ReadAll(respIndex.Body)
	bodyStr := string(body)

	if !strings.Contains(bodyStr, "window.__JJ_VIEW_CONFIG__") {
		t.Fatalf("index.html missing injected config: %s", bodyStr)
	}
	if !strings.Contains(bodyStr, srv.SessionToken()) {
		t.Fatalf("index.html missing session token")
	}
}

func TestWebSocketAuthAndOrigin(t *testing.T) {
	srv, _ := setupTestServer(t)
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/ws/system", srv.Port())

	// 1. Missing token -> 401
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		t.Fatal("expected failure without token, got connected")
	}
	if resp != nil && resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected status 401, got %d", resp.StatusCode)
	}

	// 2. Invalid origin -> 403
	authURL := fmt.Sprintf("%s?token=%s", wsURL, srv.SessionToken())
	badOriginHeader := http.Header{"Origin": []string{"https://malicious-website.com"}}
	_, resp, err = websocket.DefaultDialer.Dial(authURL, badOriginHeader)
	if err == nil {
		t.Fatal("expected failure with bad origin, got connected")
	}
	if resp != nil && resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected status 403, got %d", resp.StatusCode)
	}

	// 3. Valid token + allowed origin -> Success
	goodOriginHeader := http.Header{"Origin": []string{fmt.Sprintf("http://127.0.0.1:%d", srv.Port())}}
	conn, _, err := websocket.DefaultDialer.Dial(authURL, goodOriginHeader)
	if err != nil {
		t.Fatalf("failed to connect with valid token: %v", err)
	}
	_ = conn.Close()
}

func TestWebSocketJSONRPCMethods(t *testing.T) {
	srv, tempRepo := setupTestServer(t)
	authURL := fmt.Sprintf("ws://127.0.0.1:%d/ws/system?token=%s", srv.Port(), srv.SessionToken())
	conn, _, err := websocket.DefaultDialer.Dial(authURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()

	callRPC := func(id any, method string, params any) protocol.Response {
		paramsRaw, _ := json.Marshal(params)
		idBytes, _ := json.Marshal(id)
		idRaw := json.RawMessage(idBytes)
		req := protocol.Request{
			JSONRPC: "2.0",
			ID:      &idRaw,
			Method:  method,
			Params:  paramsRaw,
		}
		if err := conn.WriteJSON(req); err != nil {
			t.Fatalf("failed to write request: %v", err)
		}
		for {
			var raw map[string]any
			if err := conn.ReadJSON(&raw); err != nil {
				t.Fatalf("failed to read response: %v", err)
			}
			// Skip notifications that don't have an ID
			if _, hasMethod := raw["method"]; hasMethod && raw["id"] == nil {
				continue
			}
			var res protocol.Response
			resBytes, _ := json.Marshal(raw)
			_ = json.Unmarshal(resBytes, &res)
			return res
		}
	}

	// 1. system.info
	res := callRPC(1, "system.info", nil)
	if res.Error != nil {
		t.Fatalf("system.info error: %+v", res.Error)
	}
	info, ok := res.Result.(map[string]any)
	if !ok || info["platform"] == "" || info["version"] != "test-version" {
		t.Fatalf("unexpected system.info: %+v", res.Result)
	}

	// 2. fs.writeFile & fs.readFile
	filePath := filepath.Join(tempRepo, "rpc-file.txt")
	testMsg := "Hello from JSON-RPC"
	writeRes := callRPC("req-2", "fs.writeFile", map[string]string{
		"path":    filePath,
		"content": base64.StdEncoding.EncodeToString([]byte(testMsg)),
	})
	if writeRes.Error != nil {
		t.Fatalf("fs.writeFile error: %+v", writeRes.Error)
	}

	readRes := callRPC(3, "fs.readFile", map[string]string{"path": filePath})
	if readRes.Error != nil {
		t.Fatalf("fs.readFile error: %+v", readRes.Error)
	}
	readMap := readRes.Result.(map[string]any)
	decoded, _ := base64.StdEncoding.DecodeString(readMap["content"].(string))
	if string(decoded) != testMsg {
		t.Fatalf("expected content %q, got %q", testMsg, string(decoded))
	}

	// 3. process.execFile
	execRes := callRPC(4, "process.execFile", map[string]any{
		"file": "git",
		"args": []string{"--version"},
	})
	if execRes.Error != nil {
		t.Fatalf("process.execFile error: %+v", execRes.Error)
	}
	execMap := execRes.Result.(map[string]any)
	if execMap["exitCode"].(float64) != 0 {
		t.Fatalf("expected exitCode 0, got %v", execMap["exitCode"])
	}

	// 4. process.getHelperScriptPath
	scriptRes := callRPC(5, "process.getHelperScriptPath", map[string]string{
		"name": "batch-diff",
	})
	if scriptRes.Error != nil {
		t.Fatalf("process.getHelperScriptPath error: %+v", scriptRes.Error)
	}
	scriptMap := scriptRes.Result.(map[string]any)
	if !strings.Contains(scriptMap["path"].(string), "batch-diff") {
		t.Fatalf("unexpected script path: %v", scriptMap["path"])
	}

	// 5. config.set & config.get
	setRes := callRPC(6, "config.set", map[string]any{
		"key":   "theme",
		"value": "dark",
	})
	if setRes.Error != nil {
		t.Fatalf("config.set error: %+v", setRes.Error)
	}

	getRes := callRPC(7, "config.get", map[string]string{"key": "theme"})
	if getRes.Error != nil {
		t.Fatalf("config.get error: %+v", getRes.Error)
	}
	getMap := getRes.Result.(map[string]any)
	if getMap["value"] != "dark" {
		t.Fatalf("expected theme dark, got %v", getMap["value"])
	}

	// 6. watcher.watch & watcher.unwatch
	watchRes := callRPC(8, "watcher.watch", map[string]any{
		"dirPath": tempRepo,
		"ignore":  []string{"*.tmp"},
	})
	if watchRes.Error != nil {
		t.Fatalf("watcher.watch error: %+v", watchRes.Error)
	}
	watchMap := watchRes.Result.(map[string]any)
	subID := watchMap["subscriptionId"].(string)

	unwatchRes := callRPC(9, "watcher.unwatch", map[string]string{
		"subscriptionId": subID,
	})
	if unwatchRes.Error != nil {
		t.Fatalf("watcher.unwatch error: %+v", unwatchRes.Error)
	}
}

func TestCancelRequestWithStringID(t *testing.T) {
	srv, _ := setupTestServer(t)
	authURL := fmt.Sprintf("ws://127.0.0.1:%d/ws/system?token=%s", srv.Port(), srv.SessionToken())
	conn, _, err := websocket.DefaultDialer.Dial(authURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()

	// Send a command with a string ID
	reqID := "cancel-test-id-123"
	idBytes, _ := json.Marshal(reqID)
	idRaw := json.RawMessage(idBytes)

	paramsRaw, _ := json.Marshal(map[string]any{
		"file": "git",
		"args": []string{"--version"},
	})

	req := protocol.Request{
		JSONRPC: "2.0",
		ID:      &idRaw,
		Method:  "process.execFile",
		Params:  paramsRaw,
	}

	if err := conn.WriteJSON(req); err != nil {
		t.Fatalf("failed to write request: %v", err)
	}

	// Immediately send cancellation
	cancelParamsRaw, _ := json.Marshal(map[string]any{
		"id": reqID,
	})
	cancelReq := protocol.Request{
		JSONRPC: "2.0",
		Method:  "$/cancelRequest",
		Params:  cancelParamsRaw,
	}
	if err := conn.WriteJSON(cancelReq); err != nil {
		t.Fatalf("failed to write cancel notification: %v", err)
	}

	var res protocol.Response
	if err := conn.ReadJSON(&res); err != nil {
		t.Fatalf("failed to read response: %v", err)
	}

	// Either it completed before cancel was processed, or was cancelled with CodeRequestCancelled
	if res.Error != nil && res.Error.Code != protocol.CodeRequestCancelled {
		t.Fatalf("unexpected error code: %+v", res.Error)
	}
}

func TestForgeProxySecurity(t *testing.T) {
	srv, _ := setupTestServer(t)
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", srv.Port())

	// 1. Unauthenticated request should be rejected with 401
	unauthURL := fmt.Sprintf("%s/api/forge-proxy?url=https://api.github.com/user", baseURL)
	respUnauth, err := http.Get(unauthURL)
	if err != nil {
		t.Fatalf("proxy request failed: %v", err)
	}
	defer respUnauth.Body.Close()
	if respUnauth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected status 401 for unauth proxy request, got %d", respUnauth.StatusCode)
	}

	// 2. Untrusted domain should be rejected with 403
	untrustedURL := fmt.Sprintf("%s/api/forge-proxy?token=%s&url=https://attacker-domain.evil/api", baseURL, srv.SessionToken())
	resp, err := http.Get(untrustedURL)
	if err != nil {
		t.Fatalf("proxy request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected status 403 for untrusted domain, got %d", resp.StatusCode)
	}

	// 3. Insecure HTTP scheme should be rejected with 400
	insecureURL := fmt.Sprintf("%s/api/forge-proxy?token=%s&url=http://api.github.com/user", baseURL, srv.SessionToken())
	respInsecure, err := http.Get(insecureURL)
	if err != nil {
		t.Fatalf("proxy request failed: %v", err)
	}
	defer respInsecure.Body.Close()
	if respInsecure.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected status 400 for insecure scheme, got %d", respInsecure.StatusCode)
	}
}

func TestConfigDidChangeNotification(t *testing.T) {
	srv, tempRepo := setupTestServer(t)
	authURL := fmt.Sprintf("ws://127.0.0.1:%d/ws/system?token=%s", srv.Port(), srv.SessionToken())
	conn, _, err := websocket.DefaultDialer.Dial(authURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()

	vscodeDir := filepath.Join(tempRepo, ".vscode")

	// External modification of workspace settings
	wsSettings := `{"jj-view.logTheme": "forest"}`
	if err := os.WriteFile(filepath.Join(vscodeDir, "settings.json"), []byte(wsSettings), 0644); err != nil {
		t.Fatalf("failed to write settings.json: %v", err)
	}

	// Read messages until we get a notification for config/didChange
	received := make(chan bool, 1)
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var notif protocol.Notification
			if err := json.Unmarshal(msg, &notif); err == nil && notif.Method == "config/didChange" {
				received <- true
				return
			}
		}
	}()

	select {
	case <-received:
		// Succeeded
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for config/didChange notification")
	}
}

func TestIndexAndSPARouting(t *testing.T) {
	srv, _ := setupTestServer(t)
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", srv.Port())

	// 1. GET / without token -> 401
	resp, err := http.Get(baseURL + "/")
	if err != nil {
		t.Fatalf("GET / failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthenticated /, got %d", resp.StatusCode)
	}

	// 2. GET /index.html without token -> 401
	respIndex, err := http.Get(baseURL + "/index.html")
	if err != nil {
		t.Fatalf("GET /index.html failed: %v", err)
	}
	respIndex.Body.Close()
	if respIndex.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthenticated /index.html, got %d", respIndex.StatusCode)
	}

	// 3. GET / with token -> 200, injected config, Cache-Control
	authedURL := fmt.Sprintf("%s/?token=%s", baseURL, srv.SessionToken())
	respAuth, err := http.Get(authedURL)
	if err != nil {
		t.Fatalf("GET / with token failed: %v", err)
	}
	defer respAuth.Body.Close()
	if respAuth.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for authenticated /, got %d", respAuth.StatusCode)
	}
	if cacheCtrl := respAuth.Header.Get("Cache-Control"); !strings.Contains(cacheCtrl, "no-cache") {
		t.Fatalf("expected Cache-Control to contain no-cache, got %s", cacheCtrl)
	}
	body, _ := io.ReadAll(respAuth.Body)
	if !strings.Contains(string(body), "window.__JJ_VIEW_CONFIG__") {
		t.Fatalf("expected body to contain injected config, got: %s", string(body))
	}

	// 4. SPA route: GET /diff with token -> 200, serves index.html with injected config
	spaURL := fmt.Sprintf("%s/diff?token=%s", baseURL, srv.SessionToken())
	respSPA, err := http.Get(spaURL)
	if err != nil {
		t.Fatalf("GET /diff with token failed: %v", err)
	}
	defer respSPA.Body.Close()
	if respSPA.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for SPA route /diff, got %d", respSPA.StatusCode)
	}
	spaBody, _ := io.ReadAll(respSPA.Body)
	if !strings.Contains(string(spaBody), "window.__JJ_VIEW_CONFIG__") {
		t.Fatalf("expected SPA route to serve index.html with injected config, got: %s", string(spaBody))
	}
}

func TestServer_UserDataDir(t *testing.T) {
	tempRepo, err := os.MkdirTemp("", "jj-view-repo-test")
	if err != nil {
		t.Fatalf("failed to create temp repo: %v", err)
	}
	defer os.RemoveAll(tempRepo)

	tempUserData, err := os.MkdirTemp("", "jj-view-userdata-test")
	if err != nil {
		t.Fatalf("failed to create temp user data dir: %v", err)
	}
	defer os.RemoveAll(tempUserData)

	cfg := Config{
		Host:        "127.0.0.1",
		Port:        0,
		RepoRoot:    tempRepo,
		Version:     "test",
		UserDataDir: tempUserData,
	}

	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatalf("failed to create server with UserDataDir: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Close(ctx)
	}()

	expectedConfigPath := filepath.Join(tempUserData, "config.json")
	if srv.cfg.UserConfigPath != expectedConfigPath {
		t.Fatalf("expected UserConfigPath %q, got %q", expectedConfigPath, srv.cfg.UserConfigPath)
	}
	expectedStatePath := filepath.Join(tempUserData, "state.json")
	if srv.cfg.UserStatePath != expectedStatePath {
		t.Fatalf("expected UserStatePath %q, got %q", expectedStatePath, srv.cfg.UserStatePath)
	}
	expectedSecretPath := filepath.Join(tempUserData, "credentials.json")
	if srv.cfg.UserSecretPath != expectedSecretPath {
		t.Fatalf("expected UserSecretPath %q, got %q", expectedSecretPath, srv.cfg.UserSecretPath)
	}
}

func TestServerStateAndSecretsRPC(t *testing.T) {
	srv, _ := setupTestServer(t)

	authURL := fmt.Sprintf("ws://127.0.0.1:%d/ws/system?token=%s", srv.Port(), srv.SessionToken())
	conn, _, err := websocket.DefaultDialer.Dial(authURL, nil)
	if err != nil {
		t.Fatalf("failed to dial websocket: %v", err)
	}
	defer conn.Close()

	callRPC := func(id int, method string, params any) protocol.Response {
		rawParams, _ := json.Marshal(params)
		rawID := json.RawMessage(fmt.Sprintf("%d", id))
		req := protocol.Request{
			JSONRPC: "2.0",
			ID:      &rawID,
			Method:  method,
			Params:  rawParams,
		}
		if err := conn.WriteJSON(req); err != nil {
			t.Fatalf("failed to send RPC: %v", err)
		}
		for {
			var raw map[string]json.RawMessage
			if err := conn.ReadJSON(&raw); err != nil {
				t.Fatalf("failed to read RPC: %v", err)
			}
			// Notifications do not have an ID
			idRaw, hasID := raw["id"]
			if !hasID || len(idRaw) == 0 || string(idRaw) == "null" {
				continue
			}
			var res protocol.Response
			data, _ := json.Marshal(raw)
			_ = json.Unmarshal(data, &res)
			return res
		}
	}

	// 1. state.set
	setRes := callRPC(1, "state.set", map[string]any{
		"key":   "lastFocusedRepo",
		"value": "/path/to/my/repo",
	})
	if setRes.Error != nil {
		t.Fatalf("state.set error: %+v", setRes.Error)
	}

	// 2. state.get
	getRes := callRPC(2, "state.get", map[string]string{"key": "lastFocusedRepo"})
	if getRes.Error != nil {
		t.Fatalf("state.get error: %+v", getRes.Error)
	}
	getMap := getRes.Result.(map[string]any)
	if getMap["value"] != "/path/to/my/repo" || getMap["found"] != true {
		t.Fatalf("unexpected state.get: %+v", getMap)
	}

	// 3. state.getAll
	getAllRes := callRPC(3, "state.getAll", map[string]any{})
	if getAllRes.Error != nil {
		t.Fatalf("state.getAll error: %+v", getAllRes.Error)
	}
	allMap := getAllRes.Result.(map[string]any)
	if allMap["lastFocusedRepo"] != "/path/to/my/repo" {
		t.Fatalf("expected lastFocusedRepo in getAll: %+v", allMap)
	}

	// 4. state.delete
	delRes := callRPC(4, "state.delete", map[string]string{"key": "lastFocusedRepo"})
	if delRes.Error != nil {
		t.Fatalf("state.delete error: %+v", delRes.Error)
	}
	getAfterDel := callRPC(5, "state.get", map[string]string{"key": "lastFocusedRepo"})
	afterDelMap := getAfterDel.Result.(map[string]any)
	if afterDelMap["found"] == true {
		t.Fatalf("expected found=false after delete")
	}

	// 5. secrets.store
	storeRes := callRPC(6, "secrets.store", map[string]string{
		"key":   "github_token",
		"value": "ghp_super_secret_pat",
	})
	if storeRes.Error != nil {
		t.Fatalf("secrets.store error: %+v", storeRes.Error)
	}

	// 6. secrets.get
	getSecRes := callRPC(7, "secrets.get", map[string]string{"key": "github_token"})
	if getSecRes.Error != nil {
		t.Fatalf("secrets.get error: %+v", getSecRes.Error)
	}
	secMap := getSecRes.Result.(map[string]any)
	if secMap["value"] != "ghp_super_secret_pat" || secMap["found"] != true {
		t.Fatalf("unexpected secrets.get: %+v", secMap)
	}

	// 7. secrets.delete
	delSecRes := callRPC(8, "secrets.delete", map[string]string{"key": "github_token"})
	if delSecRes.Error != nil {
		t.Fatalf("secrets.delete error: %+v", delSecRes.Error)
	}
	getSecAfterDel := callRPC(9, "secrets.get", map[string]string{"key": "github_token"})
	secAfterDelMap := getSecAfterDel.Result.(map[string]any)
	if secAfterDelMap["found"] == true {
		t.Fatalf("expected found=false after delete")
	}
}

func TestServerFindFilesRPC(t *testing.T) {
	srv, tempRepo := setupTestServer(t)

	// Create test files inside repo root
	subRepo := filepath.Join(tempRepo, "subproject1", ".jj", "working_copy")
	if err := os.MkdirAll(subRepo, 0755); err != nil {
		t.Fatalf("failed to create subRepo dir: %v", err)
	}
	typeFile := filepath.Join(subRepo, "type")
	if err := os.WriteFile(typeFile, []byte("type content"), 0644); err != nil {
		t.Fatalf("failed to write type file: %v", err)
	}

	authURL := fmt.Sprintf("ws://127.0.0.1:%d/ws/system?token=%s", srv.Port(), srv.SessionToken())
	conn, _, err := websocket.DefaultDialer.Dial(authURL, nil)
	if err != nil {
		t.Fatalf("failed to dial websocket: %v", err)
	}
	defer conn.Close()

	rawParams, _ := json.Marshal(map[string]any{
		"baseDir": tempRepo,
		"pattern": "**/.jj/working_copy/type",
	})
	rawID := json.RawMessage("1")
	req := protocol.Request{
		JSONRPC: "2.0",
		ID:      &rawID,
		Method:  "fs.findFiles",
		Params:  rawParams,
	}
	if err := conn.WriteJSON(req); err != nil {
		t.Fatalf("failed to send RPC: %v", err)
	}

	var res protocol.Response
	if err := conn.ReadJSON(&res); err != nil {
		t.Fatalf("failed to read response: %v", err)
	}
	if res.Error != nil {
		t.Fatalf("fs.findFiles RPC error: %+v", res.Error)
	}

	resMap := res.Result.(map[string]any)
	filesRaw, ok := resMap["files"].([]any)
	if !ok || len(filesRaw) == 0 {
		t.Fatalf("expected non-empty files array, got %+v", resMap)
	}

	found := false
	for _, f := range filesRaw {
		if f == typeFile {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected to find %s, but results were: %+v", typeFile, filesRaw)
	}
}
