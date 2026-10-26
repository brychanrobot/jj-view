// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

	// 4. Asset URLs must be tagged with the content-derived build id, not the
	// bare semver (which stays constant across dev builds and would let the
	// browser keep an "immutable" cached copy of stale JS).
	build := srv.AssetVersion()
	if !strings.HasPrefix(build, "test-version-") || len(build) != len("test-version-")+12 {
		t.Fatalf("unexpected asset version format: %q", build)
	}
	if !strings.Contains(bodyStr, "/dist/app.js?v="+url.QueryEscape(build)) {
		t.Fatalf("index.html app.js not tagged with build %q: %s", build, bodyStr)
	}
	if strings.Contains(bodyStr, "/dist/app.js?v=test-version\"") {
		t.Fatalf("index.html app.js tagged with bare semver")
	}
	if health["build"] != build {
		t.Fatalf("health build = %v, want %q", health["build"], build)
	}
}

func TestComputeAssetVersionIsStableAndVersionPrefixed(t *testing.T) {
	a := computeAssetVersion("1.2.3")
	b := computeAssetVersion("1.2.3")
	if a != b {
		t.Fatalf("asset version not deterministic: %q vs %q", a, b)
	}
	if !strings.HasPrefix(a, "1.2.3-") {
		t.Fatalf("asset version missing semver prefix: %q", a)
	}
	if !strings.HasPrefix(computeAssetVersion(""), "dev-") {
		t.Fatalf("empty version should fall back to dev prefix")
	}
	// Different semver strings yield different tags but share the content hash.
	c := computeAssetVersion("9.9.9")
	if strings.TrimPrefix(c, "9.9.9-") != strings.TrimPrefix(a, "1.2.3-") {
		t.Fatalf("content hash should not depend on version string: %q vs %q", a, c)
	}
}

func TestHTTPRPCAndSSEAuthAndOrigin(t *testing.T) {
	srv, _ := setupTestServer(t)
	rpcURL := fmt.Sprintf("http://127.0.0.1:%d/api/rpc", srv.Port())
	eventsURL := fmt.Sprintf("http://127.0.0.1:%d/api/events", srv.Port())

	// 1. Missing token -> 401
	resp, err := http.Post(rpcURL, "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"system.info"}`))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected status 401 for unauth RPC, got %d", resp.StatusCode)
	}

	respSSE, err := http.Get(eventsURL)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer respSSE.Body.Close()
	if respSSE.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected status 401 for unauth events, got %d", respSSE.StatusCode)
	}

	// 2. Invalid origin -> 403
	authRPCURL := fmt.Sprintf("%s?token=%s", rpcURL, srv.SessionToken())
	req, _ := http.NewRequest(http.MethodPost, authRPCURL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"system.info"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://malicious-website.com")
	client := &http.Client{}
	respBadOrigin, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer respBadOrigin.Body.Close()
	if respBadOrigin.StatusCode != http.StatusForbidden {
		t.Fatalf("expected status 403 for bad origin RPC, got %d", respBadOrigin.StatusCode)
	}

	// 3. Valid token + allowed origin -> Success
	reqGood, _ := http.NewRequest(http.MethodPost, authRPCURL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"system.info"}`))
	reqGood.Header.Set("Content-Type", "application/json")
	reqGood.Header.Set("Origin", fmt.Sprintf("http://127.0.0.1:%d", srv.Port()))
	respGood, err := client.Do(reqGood)
	if err != nil {
		t.Fatalf("failed to connect with valid token: %v", err)
	}
	defer respGood.Body.Close()
	if respGood.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200 for good origin RPC, got %d", respGood.StatusCode)
	}
}

func postRPC(t *testing.T, srv *Server, id any, method string, params any) protocol.Response {
	t.Helper()
	paramsRaw, _ := json.Marshal(params)
	var idRaw *json.RawMessage
	if id != nil {
		idBytes, _ := json.Marshal(id)
		raw := json.RawMessage(idBytes)
		idRaw = &raw
	}
	req := protocol.Request{
		JSONRPC: "2.0",
		ID:      idRaw,
		Method:  method,
		Params:  paramsRaw,
	}
	bodyBytes, _ := json.Marshal(req)
	rpcURL := fmt.Sprintf("http://127.0.0.1:%d/api/rpc?token=%s", srv.Port(), srv.SessionToken())
	httpReq, err := http.NewRequest(http.MethodPost, rpcURL, bytes.NewReader(bodyBytes))
	if err != nil {
		t.Fatalf("failed to create http request: %v", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Client-ID", "test-client-1")
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		t.Fatalf("failed to post rpc request: %v", err)
	}
	defer resp.Body.Close()
	var res protocol.Response
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatalf("failed to decode rpc response: %v", err)
	}
	return res
}

func TestHTTPJSONRPCMethods(t *testing.T) {
	srv, tempRepo := setupTestServer(t)

	callRPC := func(id any, method string, params any) protocol.Response {
		return postRPC(t, srv, id, method, params)
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
		"key":   "jj-view.defaultUiMode",
		"value": "full",
		"scope": "user",
	})
	if setRes.Error != nil {
		t.Fatalf("config.set error: %+v", setRes.Error)
	}
	getRes := callRPC(7, "config.get", map[string]string{
		"key":   "jj-view.defaultUiMode",
		"scope": "user",
	})
	if getRes.Error != nil {
		t.Fatalf("config.get error: %+v", getRes.Error)
	}
	getMap := getRes.Result.(map[string]any)
	if getMap["value"] != "full" || getMap["found"] != true {
		t.Fatalf("unexpected config.get result: %+v", getMap)
	}

	// 6. fs.stat
	statRes := callRPC(8, "fs.stat", map[string]string{"path": filePath})
	if statRes.Error != nil {
		t.Fatalf("fs.stat error: %+v", statRes.Error)
	}
	statMap := statRes.Result.(map[string]any)
	if statMap["isFile"] != true {
		t.Fatalf("expected isFile=true, got %+v", statMap)
	}

	// 7. fs.mkdir & fs.readdir
	dirPath := filepath.Join(tempRepo, "sub-dir")
	mkdirRes := callRPC(9, "fs.mkdir", map[string]any{"path": dirPath, "recursive": true})
	if mkdirRes.Error != nil {
		t.Fatalf("fs.mkdir error: %+v", mkdirRes.Error)
	}
	readdirRes := callRPC(10, "fs.readdir", map[string]string{"path": tempRepo})
	if readdirRes.Error != nil {
		t.Fatalf("fs.readdir error: %+v", readdirRes.Error)
	}
	readdirMap := readdirRes.Result.(map[string]any)
	files := readdirMap["files"].([]any)
	foundSubDir := false
	for _, f := range files {
		if f.(string) == "sub-dir" {
			foundSubDir = true
			break
		}
	}
	if !foundSubDir {
		t.Fatalf("sub-dir not found in readdir output")
	}

	// 8. fs.exists
	existsRes := callRPC(11, "fs.exists", map[string]string{"path": filePath})
	if existsRes.Error != nil {
		t.Fatalf("fs.exists error: %+v", existsRes.Error)
	}
	existsMap := existsRes.Result.(map[string]any)
	if existsMap["exists"] != true {
		t.Fatalf("expected exists=true, got %+v", existsMap)
	}

	// 9. fs.rm
	rmRes := callRPC(12, "fs.rm", map[string]any{"path": filePath})
	if rmRes.Error != nil {
		t.Fatalf("fs.rm error: %+v", rmRes.Error)
	}
	existsAfterRm := callRPC(13, "fs.exists", map[string]string{"path": filePath})
	existsAfterMap := existsAfterRm.Result.(map[string]any)
	if existsAfterMap["exists"] != false {
		t.Fatalf("expected exists=false after rm, got %+v", existsAfterMap)
	}

	// 10. watcher.watch & watcher.unwatch
	watchRes := callRPC(14, "watcher.watch", map[string]any{
		"dirPath": tempRepo,
		"ignore":  []string{".git"},
	})
	if watchRes.Error != nil {
		t.Fatalf("watcher.watch error: %+v", watchRes.Error)
	}
	watchMap := watchRes.Result.(map[string]any)
	subID := watchMap["subscriptionId"].(string)
	if subID == "" {
		t.Fatalf("expected non-empty subscriptionId")
	}

	unwatchRes := callRPC(15, "watcher.unwatch", map[string]string{
		"subscriptionId": subID,
	})
	if unwatchRes.Error != nil {
		t.Fatalf("watcher.unwatch error: %+v", unwatchRes.Error)
	}
}

func TestCancelRequestViaContext(t *testing.T) {
	srv, _ := setupTestServer(t)

	// Send an execFile request with a context that cancels immediately
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	rawParams, _ := json.Marshal(map[string]any{
		"file": "git",
		"args": []string{"--version"},
	})
	rawID := json.RawMessage("1")
	req := protocol.Request{
		JSONRPC: "2.0",
		ID:      &rawID,
		Method:  "process.execFile",
		Params:  rawParams,
	}
	bodyBytes, _ := json.Marshal(req)
	rpcURL := fmt.Sprintf("http://127.0.0.1:%d/api/rpc?token=%s", srv.Port(), srv.SessionToken())
	httpReq, _ := http.NewRequestWithContext(ctx, http.MethodPost, rpcURL, bytes.NewReader(bodyBytes))
	httpReq.Header.Set("Content-Type", "application/json")

	_, err := http.DefaultClient.Do(httpReq)
	if err == nil {
		t.Fatal("expected error due to context cancellation, got nil")
	}
}

func TestConfigDidChangeNotification(t *testing.T) {
	srv, tempRepo := setupTestServer(t)
	eventsURL := fmt.Sprintf("http://127.0.0.1:%d/api/events?token=%s&clientId=test-client-notif", srv.Port(), srv.SessionToken())
	resp, err := http.Get(eventsURL)
	if err != nil {
		t.Fatalf("failed to connect to SSE: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for SSE, got %d", resp.StatusCode)
	}

	vscodeDir := filepath.Join(tempRepo, ".vscode")

	// Read SSE stream lines
	received := make(chan bool, 1)
	go func() {
		reader := bufio.NewReader(resp.Body)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "data:") {
				dataStr := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
				var notif protocol.Notification
				if err := json.Unmarshal([]byte(dataStr), &notif); err == nil && notif.Method == "config/didChange" {
					received <- true
					return
				}
			}
		}
	}()

	// External modification of workspace settings
	wsSettings := `{"jj-view.logTheme": "forest"}`
	if err := os.WriteFile(filepath.Join(vscodeDir, "settings.json"), []byte(wsSettings), 0644); err != nil {
		t.Fatalf("failed to write settings.json: %v", err)
	}

	select {
	case <-received:
		// Succeeded
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for config/didChange notification over SSE")
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
	if !strings.Contains(string(body), srv.SessionToken()) {
		t.Fatalf("expected body to contain session token, got: %s", string(body))
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

	callRPC := func(id int, method string, params any) protocol.Response {
		return postRPC(t, srv, id, method, params)
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

	res := postRPC(t, srv, 1, "fs.findFiles", map[string]any{
		"baseDir": tempRepo,
		"pattern": "**/.jj/working_copy/type",
	})
	if res.Error != nil {
		t.Fatalf("fs.findFiles error: %+v", res.Error)
	}

	resMap := res.Result.(map[string]any)
	files := resMap["files"].([]any)
	if len(files) != 1 {
		t.Fatalf("expected 1 file match, got %v", len(files))
	}
	matched := files[0].(string)
	if filepath.Clean(matched) != filepath.Clean(typeFile) {
		t.Fatalf("expected match %q, got %q", typeFile, matched)
	}
}

func TestSidecarTokenAndOriginValidation(t *testing.T) {
	srv, _ := setupTestServer(t)
	srv.cfg.SidecarToken = "test-sidecar-token-xyz"

	// 1. Authenticated request using X-Sidecar-Token header
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", srv.Port()), nil)
	req.Header.Set("X-Sidecar-Token", "test-sidecar-token-xyz")
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK with X-Sidecar-Token, got %d", resp.StatusCode)
	}

	// 2. Authenticated request using ?sidecar_token= query parameter
	respQuery, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/?sidecar_token=test-sidecar-token-xyz", srv.Port()))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer respQuery.Body.Close()
	if respQuery.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK with ?sidecar_token=, got %d", respQuery.StatusCode)
	}

	// 2b. Root UI load without token in sidecar mode (e.g. host iframe navigation)
	respNoToken, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", srv.Port()))
	if err != nil {
		t.Fatalf("request without token failed: %v", err)
	}
	defer respNoToken.Body.Close()
	if respNoToken.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK without token in sidecar mode, got %d", respNoToken.StatusCode)
	}
	hasCookie := false
	for _, c := range respNoToken.Cookies() {
		if c.Name == "jj_view_token" && c.Value == srv.cfg.SidecarToken {
			hasCookie = true
			break
		}
	}
	if !hasCookie {
		t.Fatalf("expected jj_view_token cookie set on root load in sidecar mode")
	}

	// 3. Reject invalid sidecar token
	badReq, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", srv.Port()), nil)
	badReq.Header.Set("X-Sidecar-Token", "invalid-token")
	badResp, err := client.Do(badReq)
	if err != nil {
		t.Fatalf("bad req failed: %v", err)
	}
	if badResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 Unauthorized for bad token, got %d", badResp.StatusCode)
	}
	badResp.Body.Close()

	// 4. Endpoint /api/rpc with ?sidecar_token=... and Origin: null
	rpcURL := fmt.Sprintf("http://127.0.0.1:%d/api/rpc?sidecar_token=test-sidecar-token-xyz", srv.Port())
	nullOriginReq, _ := http.NewRequest(http.MethodPost, rpcURL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"system.info"}`))
	nullOriginReq.Header.Set("Content-Type", "application/json")
	nullOriginReq.Header.Set("Origin", "null")
	resNull, err := client.Do(nullOriginReq)
	if err != nil {
		t.Fatalf("failed to call /api/rpc with sidecar token: %v", err)
	}
	defer resNull.Body.Close()
	if resNull.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK for /api/rpc with Origin null, got %d", resNull.StatusCode)
	}
}

func TestWorkspaceAddAllowedRootRPC(t *testing.T) {
	srv, _ := setupTestServer(t)

	// External directory outside repository
	outsideDir := t.TempDir()
	testFile := filepath.Join(outsideDir, "hello.txt")
	if err := os.WriteFile(testFile, []byte("outside content"), 0644); err != nil {
		t.Fatalf("failed to write test file: %v", err)
	}

	callRPC := func(id int, method string, params any) protocol.Response {
		return postRPC(t, srv, id, method, params)
	}

	// 1. Initial stat should fail because outsideDir is not allowed
	res1 := callRPC(1, "fs.stat", map[string]string{"path": testFile})
	if res1.Error == nil {
		t.Fatalf("expected fs.stat to fail on outside file before addAllowedRoot")
	}

	// 2. Call workspace.addAllowedRoot
	addRes := callRPC(2, "workspace.addAllowedRoot", map[string]string{"path": outsideDir})
	if addRes.Error != nil {
		t.Fatalf("workspace.addAllowedRoot failed: %+v", addRes.Error)
	}

	// 3. Now stat should succeed
	res2 := callRPC(3, "fs.stat", map[string]string{"path": testFile})
	if res2.Error != nil {
		t.Fatalf("expected fs.stat to succeed after addAllowedRoot, got: %+v", res2.Error)
	}
	statMap := res2.Result.(map[string]any)
	if statMap["isFile"] != true {
		t.Fatalf("expected isFile=true, got %+v", statMap)
	}
}

func TestServerPreloadAndSidecarEndpoints(t *testing.T) {
	srv, _ := setupTestServer(t)
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", srv.Port())

	// 1. Unauthenticated GET /preload.js must succeed with 200 and javascript content-type
	resp, err := http.Get(baseURL + "/preload.js")
	if err != nil {
		t.Fatalf("failed to fetch /preload.js: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for /preload.js, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "window.sidecar") {
		t.Fatalf("expected preload.js to define window.sidecar, got:\n%s", string(body))
	}

	// 2. Unauthenticated POST to /_sidecar/send-message should return 401
	unauthPost, err := http.Post(baseURL+"/_sidecar/send-message", "application/json", strings.NewReader(`{"message":"test"}`))
	if err != nil {
		t.Fatalf("failed to post unauth /_sidecar/send-message: %v", err)
	}
	defer unauthPost.Body.Close()
	if unauthPost.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauth /_sidecar/send-message, got %d", unauthPost.StatusCode)
	}

	// 3. Authenticated POST to /_sidecar/send-message with session token
	client := &http.Client{}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/_sidecar/send-message?token="+srv.SessionToken(), strings.NewReader(`{"message":"test"}`))
	if err != nil {
		t.Fatalf("failed to create req: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	authResp, err := client.Do(req)
	if err != nil {
		t.Fatalf("failed to send authenticated /_sidecar request: %v", err)
	}
	defer authResp.Body.Close()
	if authResp.StatusCode == http.StatusUnauthorized || authResp.StatusCode == http.StatusNotFound {
		t.Fatalf("expected authorized /_sidecar endpoint (not 401 or 404), got %d", authResp.StatusCode)
	}
}

func TestOriginValidationAndPNAHeaders(t *testing.T) {
	srv := startServerWithConfig(t, Config{
		Host:           "127.0.0.1",
		Port:           0,
		RepoRoot:       t.TempDir(),
		AllowedOrigins: []string{"*.proxy.example.com"},
	})

	// 1. OPTIONS preflight to /health with an allow-listed proxy origin
	proxyOrigin := "https://0123456789abcdef.proxy.example.com"
	req, _ := http.NewRequest(http.MethodOptions, fmt.Sprintf("http://127.0.0.1:%d/health", srv.Port()), nil)
	req.Header.Set("Origin", proxyOrigin)
	req.Header.Set("Access-Control-Request-Private-Network", "true")
	req.Header.Set("Access-Control-Request-Method", "GET")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("options request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 No Content, got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != proxyOrigin {
		t.Errorf("expected Access-Control-Allow-Origin %q, got %q", proxyOrigin, got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Private-Network"); got != "true" {
		t.Errorf("expected Access-Control-Allow-Private-Network 'true', got %q", got)
	}

	// 2. RPC post with an allow-listed origin should succeed
	rpcURL := fmt.Sprintf("http://127.0.0.1:%d/api/rpc?token=%s", srv.Port(), srv.SessionToken())
	rpcReq, _ := http.NewRequest(http.MethodPost, rpcURL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"system.info"}`))
	rpcReq.Header.Set("Content-Type", "application/json")
	rpcReq.Header.Set("Origin", proxyOrigin)
	rpcResp, err := client.Do(rpcReq)
	if err != nil {
		t.Fatalf("failed to post rpc with allow-listed origin: %v", err)
	}
	defer rpcResp.Body.Close()
	if rpcResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK for allow-listed origin RPC, got %d", rpcResp.StatusCode)
	}

	// 3. Sidecar mode allows any origin
	sidecarSrv, err := NewServer(Config{
		Host:         "127.0.0.1",
		Port:         0,
		RepoRoot:     t.TempDir(),
		SidecarToken: "sidecar-ui-token-xyz",
	})
	if err != nil {
		t.Fatalf("failed to create sidecar server: %v", err)
	}
	if err := sidecarSrv.Listen(); err != nil {
		t.Fatalf("failed to listen: %v", err)
	}
	go func() {
		_ = sidecarSrv.Start()
	}()
	defer func() { _ = sidecarSrv.Close(context.Background()) }()

	sidecarRPCURL := fmt.Sprintf("http://127.0.0.1:%d/api/rpc?token=sidecar-ui-token-xyz", sidecarSrv.Port())
	anyOriginReq, _ := http.NewRequest(http.MethodPost, sidecarRPCURL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"system.info"}`))
	anyOriginReq.Header.Set("Content-Type", "application/json")
	anyOriginReq.Header.Set("Origin", "https://arbitrary-custom-subdomain.example.net")
	sResp, err := client.Do(anyOriginReq)
	if err != nil {
		t.Fatalf("failed to call sidecar rpc with arbitrary origin: %v", err)
	}
	defer sResp.Body.Close()
	if sResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK for sidecar rpc with arbitrary origin, got %d", sResp.StatusCode)
	}
}

func TestOriginRejectedWhenNotAllowListed(t *testing.T) {
	srv, _ := setupTestServer(t)
	foreignOrigin := "https://0123456789abcdef.proxy.example.com"
	client := &http.Client{}

	// Preflight from an unknown origin gets no CORS grant.
	req, _ := http.NewRequest(http.MethodOptions, fmt.Sprintf("http://127.0.0.1:%d/health", srv.Port()), nil)
	req.Header.Set("Origin", foreignOrigin)
	req.Header.Set("Access-Control-Request-Method", "GET")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("options request failed: %v", err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("expected no Access-Control-Allow-Origin for unknown origin, got %q", got)
	}

	// RPC post from an unknown origin is refused even with a valid token.
	rpcURL := fmt.Sprintf("http://127.0.0.1:%d/api/rpc?token=%s", srv.Port(), srv.SessionToken())
	postRPC := func(origin string) int {
		t.Helper()
		rpcReq, _ := http.NewRequest(http.MethodPost, rpcURL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"system.info"}`))
		rpcReq.Header.Set("Content-Type", "application/json")
		rpcReq.Header.Set("Origin", origin)
		rpcResp, err := client.Do(rpcReq)
		if err != nil {
			t.Fatalf("rpc post with origin %q failed: %v", origin, err)
		}
		defer rpcResp.Body.Close()
		return rpcResp.StatusCode
	}
	if got := postRPC(foreignOrigin); got != http.StatusForbidden {
		t.Fatalf("expected 403 for unknown origin, got %d", got)
	}

	// An origin matching the request host is still accepted without configuration.
	if got := postRPC(fmt.Sprintf("http://127.0.0.1:%d", srv.Port())); got != http.StatusOK {
		t.Fatalf("expected 200 for same-host origin, got %d", got)
	}
}

func TestOriginHostMatches(t *testing.T) {
	cases := []struct {
		host, pattern string
		want          bool
	}{
		{"ui.example.com", "ui.example.com", true},
		{"ui.example.com", " UI.Example.COM ", true},
		{"ui.example.com", "example.com", false},
		{"a.proxy.example.com", "*.proxy.example.com", true},
		{"a.b.proxy.example.com", "*.proxy.example.com", true},
		{"proxy.example.com", "*.proxy.example.com", false},
		{"evilproxy.example.com", "*.proxy.example.com", false},
		{"ui.example.com", "", false},
		{"ui.example.com", "*.", false},
	}
	for _, tc := range cases {
		if got := originHostMatches(tc.host, tc.pattern); got != tc.want {
			t.Errorf("originHostMatches(%q, %q) = %v, want %v", tc.host, tc.pattern, got, tc.want)
		}
	}
}

// startServerWithConfig creates, listens and starts a server for the given
// config and closes it when the test ends.
func startServerWithConfig(t *testing.T, cfg Config) *Server {
	t.Helper()
	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}
	if err := srv.Listen(); err != nil {
		t.Fatalf("failed to listen: %v", err)
	}
	go func() {
		_ = srv.Start()
	}()
	t.Cleanup(func() { _ = srv.Close(context.Background()) })
	return srv
}
