// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/brychanrobot/jj-view/internal/config"
	"github.com/brychanrobot/jj-view/internal/fs"
	"github.com/brychanrobot/jj-view/internal/gitcred"
	"github.com/brychanrobot/jj-view/internal/process"
	"github.com/brychanrobot/jj-view/internal/protocol"
	"github.com/brychanrobot/jj-view/internal/secret"
	"github.com/brychanrobot/jj-view/internal/state"
	"github.com/brychanrobot/jj-view/internal/watcher"
	"github.com/brychanrobot/jj-view/web"
)

const (
	maxRPCReadLimit = 100 * 1024 * 1024 // 100 MB
)

// Config configures the server instance.
type Config struct {
	Host           string
	Port           int
	RepoRoot       string
	SessionToken   string
	SidecarToken   string
	CSRFToken      string
	Version        string
	UserDataDir    string
	UserConfigPath string
	UserStatePath  string
	UserSecretPath string
	// AllowedOrigins lists extra browser origin hosts accepted in standalone
	// mode, on top of loopback, the bound host and the request host. An entry
	// of the form "*.example.com" matches any subdomain of example.com.
	// Ignored in sidecar mode, where every origin is accepted.
	AllowedOrigins []string
}

// Server provides HTTP and WebSocket services for the JJ View web UI.
type Server struct {
	cfg          Config
	procMgr      *process.Manager
	fsMgr        *fs.SandboxManager
	watcherHub   *watcher.Hub
	configStore  *config.Store
	stateStore   *state.Store
	secretStore  *secret.Store
	gitCreds     *gitcred.Resolver
	httpServer   *http.Server
	listener     net.Listener
	readyCh      chan struct{}
	fileServer   http.Handler
	assetVersion string
	clientsMu    sync.Mutex
	sseClients   map[string]*sseClient
	wsClients    map[*wsConn]struct{}
	mu           sync.RWMutex
}

// versionedAssets are the embedded files whose contents feed the asset
// cache-buster. Any change to these files must produce a new ?v= tag;
// otherwise browsers holding an "immutable" cached copy keep serving the
// previous build's JS/CSS.
var versionedAssets = []string{"dist/app.js", "dist/app.css", "dist/preload.js", "preload.js"}

// computeAssetVersion returns "<version>-<hash>" where hash is derived from the
// embedded asset contents. The semver string alone is not a safe cache key:
// successive dev builds share the same version yet ship different assets.
func computeAssetVersion(version string) string {
	if version == "" {
		version = "dev"
	}
	h := sha256.New()
	for _, name := range versionedAssets {
		content, err := web.FS.ReadFile(name)
		if err != nil {
			continue
		}
		_, _ = h.Write([]byte(name))
		_, _ = h.Write(content)
	}
	return fmt.Sprintf("%s-%s", version, hex.EncodeToString(h.Sum(nil))[:12])
}

// AssetVersion returns the cache-busting tag applied to embedded asset URLs.
func (s *Server) AssetVersion() string {
	return s.assetVersion
}

// NewServer initializes a new Server.
func NewServer(cfg Config) (*Server, error) {
	if cfg.SessionToken == "" {
		tokenBytes := make([]byte, 32)
		if _, err := rand.Read(tokenBytes); err != nil {
			return nil, fmt.Errorf("failed to generate session token: %w", err)
		}
		cfg.SessionToken = hex.EncodeToString(tokenBytes)
	}

	if cfg.SidecarToken == "" {
		cfg.SidecarToken = os.Getenv("ANTIGRAVITY_SIDECAR_UI_TOKEN")
	}
	if cfg.CSRFToken == "" {
		cfg.CSRFToken = os.Getenv("ANTIGRAVITY_CSRF_TOKEN")
	}

	absRepo, err := filepath.Abs(cfg.RepoRoot)
	if err != nil {
		return nil, fmt.Errorf("invalid repo root: %w", err)
	}
	cfg.RepoRoot = absRepo

	if cfg.UserDataDir != "" {
		absDataDir, err := filepath.Abs(cfg.UserDataDir)
		if err != nil {
			return nil, fmt.Errorf("invalid user data dir: %w", err)
		}
		cfg.UserDataDir = absDataDir
		if cfg.UserConfigPath == "" {
			cfg.UserConfigPath = filepath.Join(absDataDir, "config.json")
		}
		if cfg.UserStatePath == "" {
			cfg.UserStatePath = filepath.Join(absDataDir, "state.json")
		}
		if cfg.UserSecretPath == "" {
			cfg.UserSecretPath = filepath.Join(absDataDir, "credentials.json")
		}
	}

	var extraRoots []string
	if cfg.UserDataDir != "" {
		extraRoots = append(extraRoots, cfg.UserDataDir)
	}
	if cfg.UserConfigPath != "" {
		extraRoots = append(extraRoots, filepath.Dir(cfg.UserConfigPath))
	}
	if cfg.UserStatePath != "" {
		extraRoots = append(extraRoots, filepath.Dir(cfg.UserStatePath))
	}
	if cfg.UserSecretPath != "" {
		extraRoots = append(extraRoots, filepath.Dir(cfg.UserSecretPath))
	}

	fsMgr, err := fs.NewSandboxManager(cfg.RepoRoot, extraRoots...)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize sandbox: %w", err)
	}

	s := &Server{
		cfg:          cfg,
		fsMgr:        fsMgr,
		watcherHub:   watcher.NewHub(),
		readyCh:      make(chan struct{}),
		sseClients:   make(map[string]*sseClient),
		wsClients:    make(map[*wsConn]struct{}),
		gitCreds:     gitcred.NewResolver(gitcred.Options{Logf: log.Printf}),
		fileServer:   http.FileServer(http.FS(web.FS)),
		assetVersion: computeAssetVersion(cfg.Version),
	}

	configStore, err := config.NewStore(config.Options{
		UserDataDir:    cfg.UserDataDir,
		UserConfigPath: cfg.UserConfigPath,
		RepoRoot:       cfg.RepoRoot,
		OnChange: func(key string, scope string) {
			s.broadcastConfigChange(key, scope)
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to initialize config store: %w", err)
	}
	s.configStore = configStore

	stateStore, err := state.NewStore(state.Options{
		Path: cfg.UserStatePath,
		OnChange: func(key string, value json.RawMessage) {
			s.broadcastNotification("state/didChange", map[string]any{
				"key":   key,
				"value": value,
			})
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to initialize state store: %w", err)
	}
	s.stateStore = stateStore

	secretStore, err := secret.NewStore(secret.Options{
		Path: cfg.UserSecretPath,
		OnChange: func(key string, action string) {
			s.broadcastNotification("secrets/didChange", map[string]any{
				"key":    key,
				"action": action,
			})
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to initialize secret store: %w", err)
	}
	s.secretStore = secretStore
	s.procMgr = process.NewManager(filepath.Join(fsMgr.DaemonTempDir(), "scripts"))

	_ = mime.AddExtensionType(".woff2", "font/woff2")
	_ = mime.AddExtensionType(".woff", "font/woff")
	_ = mime.AddExtensionType(".ttf", "font/ttf")
	_ = mime.AddExtensionType(".svg", "image/svg+xml")
	// Pre-extract scripts in the background
	go func() {
		_ = s.procMgr.EnsureScriptsExtracted()
	}()

	return s, nil
}

// Ready returns a channel that is closed when the server has bound its port.
func (s *Server) Ready() <-chan struct{} {
	return s.readyCh
}

// Listen binds the TCP listener.
func (s *Server) Listen() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.listener != nil {
		return nil
	}

	addr := fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", addr, err)
	}
	s.listener = listener
	s.cfg.Port = listener.Addr().(*net.TCPAddr).Port

	close(s.readyCh)
	return nil
}

// Start begins listening and serving.
func (s *Server) Start() error {
	if err := s.Listen(); err != nil {
		return err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/preload.js", s.handlePreload)
	mux.HandleFunc("/_sidecar/", s.handleSidecarProxy)
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/rpc", s.handleRPC)
	mux.HandleFunc("/api/events", s.handleEvents)
	mux.HandleFunc("/api/ws", s.handleWS)

	s.httpServer = &http.Server{
		Handler:      mux,
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 0,
	}

	return s.httpServer.Serve(s.listener)
}

// Addr returns the server's listening address.
func (s *Server) Addr() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.listener != nil {
		return s.listener.Addr().String()
	}
	return fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port)
}

// Port returns the bound port.
func (s *Server) Port() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg.Port
}

// SessionToken returns the active session token.
func (s *Server) SessionToken() string {
	return s.cfg.SessionToken
}

// Close gracefully stops the server and closes all active clients.
func (s *Server) Close(ctx context.Context) error {
	s.watcherHub.Close()
	if s.configStore != nil {
		_ = s.configStore.Close()
	}
	if s.stateStore != nil {
		_ = s.stateStore.Close()
	}
	if s.secretStore != nil {
		_ = s.secretStore.Close()
	}

	s.clientsMu.Lock()
	for _, client := range s.sseClients {
		client.close()
	}
	s.sseClients = make(map[string]*sseClient)
	wsClients := make([]*wsConn, 0, len(s.wsClients))
	for ws := range s.wsClients {
		wsClients = append(wsClients, ws)
	}
	s.wsClients = make(map[*wsConn]struct{})
	s.clientsMu.Unlock()

	for _, ws := range wsClients {
		ws.close()
	}

	if s.httpServer != nil {
		if err := s.httpServer.Shutdown(ctx); err != nil {
			_ = s.httpServer.Close()
			return err
		}
	}
	return nil
}

func (s *Server) broadcastNotification(method string, params any) {
	s.clientsMu.Lock()
	clients := make([]*sseClient, 0, len(s.sseClients))
	for _, client := range s.sseClients {
		clients = append(clients, client)
	}
	s.clientsMu.Unlock()

	notification := protocol.NewNotification(method, params)
	for _, client := range clients {
		_ = client.send(notification)
	}
}

func (s *Server) notifyClient(clientID string, method string, params any) {
	if clientID == "" {
		s.broadcastNotification(method, params)
		return
	}
	s.clientsMu.Lock()
	client := s.sseClients[clientID]
	s.clientsMu.Unlock()
	if client != nil {
		_ = client.send(protocol.NewNotification(method, params))
	}
}

func (s *Server) trackClientSubscription(clientID, subID string) {
	if clientID == "" {
		return
	}
	s.clientsMu.Lock()
	client := s.sseClients[clientID]
	s.clientsMu.Unlock()
	if client != nil {
		client.subsMu.Lock()
		client.subscriptions[subID] = true
		client.subsMu.Unlock()
	}
}

func (s *Server) untrackClientSubscription(clientID, subID string) {
	if clientID == "" {
		return
	}
	s.clientsMu.Lock()
	client := s.sseClients[clientID]
	s.clientsMu.Unlock()
	if client != nil {
		client.subsMu.Lock()
		delete(client.subscriptions, subID)
		client.subsMu.Unlock()
	}
}

func (s *Server) broadcastConfigChange(key string, scope string) {
	s.broadcastNotification("config/didChange", map[string]any{
		"key":   key,
		"scope": scope,
	})
}

func (s *Server) authenticateRequest(r *http.Request) bool {
	var token string
	if sidecarHeader := r.Header.Get("X-Sidecar-Token"); sidecarHeader != "" {
		token = strings.TrimSpace(sidecarHeader)
	}
	if token == "" {
		authHeader := r.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bearer ") {
			token = strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		}
	}
	if token == "" {
		if qToken := r.URL.Query().Get("token"); qToken != "" {
			token = qToken
		} else if qSidecar := r.URL.Query().Get("sidecar_token"); qSidecar != "" {
			token = qSidecar
		}
	}
	if token == "" {
		if cookie, err := r.Cookie("jj_view_token"); err == nil {
			token = cookie.Value
		}
	}
	if token == "" {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.SessionToken)) == 1 {
		return true
	}
	if s.cfg.SidecarToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.SidecarToken)) == 1 {
		return true
	}
	return false
}

func (s *Server) verifyCSRF(r *http.Request) bool {
	if s.cfg.CSRFToken == "" {
		return true
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return true
	}
	csrf := r.Header.Get("X-CSRF-Token")
	if csrf == "" {
		csrf = r.Header.Get("X-Antigravity-CSRF-Token")
	}
	return subtle.ConstantTimeCompare([]byte(csrf), []byte(s.cfg.CSRFToken)) == 1
}

func (s *Server) isOriginAllowed(origin string, reqHost ...string) bool {
	if origin == "" {
		return true
	}
	if origin == "null" {
		return true
	}
	// In sidecar mode, all requests are gated by the sidecar UI token (ANTIGRAVITY_SIDECAR_UI_TOKEN).
	// Allow any origin so the sidecar works across Antigravity Web, Desktop, proxies, and tunnels.
	if s.cfg.SidecarToken != "" {
		return true
	}

	parsedOrigin, err := url.Parse(origin)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(parsedOrigin.Scheme)
	if scheme == "vscode-webview" || scheme == "antigravity-webview" || scheme == "antigravity" || scheme == "vscode-file" {
		return true
	}
	if scheme != "http" && scheme != "https" {
		return false
	}
	originHost := strings.ToLower(parsedOrigin.Hostname())
	if originHost == "localhost" || originHost == "127.0.0.1" || originHost == "::1" || originHost == strings.ToLower(s.cfg.Host) {
		return true
	}
	for _, rh := range reqHost {
		if rh != "" {
			h := rh
			if host, _, err := net.SplitHostPort(rh); err == nil {
				h = host
			}
			if strings.EqualFold(originHost, h) {
				return true
			}
		}
	}
	for _, pattern := range s.cfg.AllowedOrigins {
		if originHostMatches(originHost, pattern) {
			return true
		}
	}
	return false
}

// originHostMatches reports whether a lower-cased origin hostname matches an
// AllowedOrigins entry. "*.example.com" matches any subdomain of example.com
// (not example.com itself); any other entry must equal the hostname.
func originHostMatches(originHost, pattern string) bool {
	pattern = strings.ToLower(strings.TrimSpace(pattern))
	if pattern == "" {
		return false
	}
	if suffix, ok := strings.CutPrefix(pattern, "*."); ok {
		return strings.HasSuffix(originHost, "."+suffix)
	}
	return originHost == pattern
}

func (s *Server) applyCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if s.isOriginAllowed(origin, r.Host) {
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		} else {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Sidecar-Token, X-CSRF-Token, X-Antigravity-CSRF-Token, Cache-Control, X-Client-ID")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Access-Control-Max-Age", "86400")
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":  "ok",
		"version": s.cfg.Version,
		"build":   s.assetVersion,
		"repo":    s.cfg.RepoRoot,
		"sidecar": s.cfg.SidecarToken != "",
	})
}

func (s *Server) handlePreload(w http.ResponseWriter, r *http.Request) {
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	content, err := web.FS.ReadFile("dist/preload.js")
	if err != nil {
		content, err = web.FS.ReadFile("preload.js")
	}
	if err != nil {
		http.Error(w, "preload.js not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(content)
}

func (s *Server) handleSidecarProxy(w http.ResponseWriter, r *http.Request) {
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authenticateRequest(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	reqMap := make(map[string]any)
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&reqMap); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}
	}

	var args []string
	var projectID string
	cleanPath := path.Clean(r.URL.Path)
	switch cleanPath {
	case "/_sidecar/send-message":
		msg, _ := reqMap["message"].(string)
		convID, _ := reqMap["conversationId"].(string)
		title, _ := reqMap["title"].(string)
		projectID, _ = reqMap["projectId"].(string)

		args = []string{"send-message"}
		if title != "" {
			args = append(args, "--title", title)
		}
		if convID != "" {
			args = append(args, convID)
		}
		args = append(args, msg)

	case "/_sidecar/new-conversation":
		msg, _ := reqMap["message"].(string)
		model, _ := reqMap["model"].(string)
		title, _ := reqMap["title"].(string)
		projectID, _ = reqMap["projectId"].(string)

		args = []string{"new-conversation"}
		if model != "" {
			args = append(args, "--model", model)
		}
		if title != "" {
			args = append(args, "--title", title)
		}
		args = append(args, msg)

	case "/_sidecar/get-conversation-metadata":
		convID, _ := reqMap["conversationId"].(string)
		args = []string{"get-conversation-metadata"}
		if convID != "" {
			args = append(args, convID)
		}

	default:
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}

	result, err := s.runAgentAPI(r.Context(), projectID, args)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func (s *Server) runAgentAPI(ctx context.Context, projectID string, args []string) (any, error) {
	agentAPIPath, err := exec.LookPath("agentapi")
	if err != nil {
		if home, hErr := os.UserHomeDir(); hErr == nil {
			candidate := filepath.Join(home, ".gemini", "antigravity", "bin", "agentapi")
			if fi, sErr := os.Stat(candidate); sErr == nil && !fi.IsDir() {
				agentAPIPath = candidate
			}
		}
	}
	if agentAPIPath == "" {
		return nil, errors.New("agentapi binary not found in PATH or standard location")
	}

	cmd := exec.CommandContext(ctx, agentAPIPath, args...)
	cmd.Env = os.Environ()
	if projectID != "" {
		cmd.Env = append(cmd.Env, fmt.Sprintf("ANTIGRAVITY_PROJECT_ID=%s", projectID))
	}

	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("agentapi failed: %s", string(exitErr.Stderr))
		}
		return nil, fmt.Errorf("failed to execute agentapi: %w", err)
	}

	if len(out) == 0 {
		return map[string]any{}, nil
	}

	var result any
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, fmt.Errorf("failed to parse agentapi JSON output: %w", err)
	}
	return result, nil
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	cleanPath := path.Clean(r.URL.Path)

	// If the path is not root or index.html, check if it's an existing static file in web.FS
	if cleanPath != "/" && cleanPath != "/index.html" && cleanPath != "." {
		trimmed := strings.TrimPrefix(cleanPath, "/")
		if file, err := web.FS.Open(trimmed); err == nil {
			stat, statErr := file.Stat()
			_ = file.Close()
			if statErr == nil && !stat.IsDir() {
				// Versioned assets and content-hashed code-splitting chunks
				// (/dist/chunks/<name>-<hash>.js) never change in place.
				if r.URL.Query().Get("v") != "" || strings.HasPrefix(cleanPath, "/dist/chunks/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "public, max-age=86400")
				}
				s.fileServer.ServeHTTP(w, r)
				return
			}
		}
	}

	// In sidecar mode, allow loading the root UI without an explicit token so iframes
	// can load index.html and receive the session token and fresh cookie.
	// If an explicit token is provided, it must be valid.
	hasExplicitToken := r.Header.Get("X-Sidecar-Token") != "" ||
		r.Header.Get("Authorization") != "" ||
		r.URL.Query().Get("token") != "" ||
		r.URL.Query().Get("sidecar_token") != ""

	if s.cfg.SidecarToken != "" {
		if hasExplicitToken && !s.authenticateRequest(r) {
			http.Error(w, "Unauthorized: invalid session token", http.StatusUnauthorized)
			return
		}
	} else if !s.authenticateRequest(r) {
		http.Error(w, "Unauthorized: missing or invalid session token", http.StatusUnauthorized)
		return
	}

	content, err := web.FS.ReadFile("index.html")
	if err != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}

	activeToken := s.cfg.SessionToken
	if s.cfg.SidecarToken != "" {
		activeToken = s.cfg.SidecarToken
	}

	configPayload := map[string]any{
		"token":    activeToken,
		"port":     s.cfg.Port,
		"repoRoot": s.cfg.RepoRoot,
	}
	if s.cfg.SidecarToken != "" {
		configPayload["sidecarToken"] = s.cfg.SidecarToken
	}
	if s.cfg.CSRFToken != "" {
		configPayload["csrfToken"] = s.cfg.CSRFToken
	}
	configJSON, _ := json.Marshal(configPayload)

	injected := fmt.Sprintf("<script>window.__JJ_VIEW_CONFIG__ = %s;</script>\n</head>", string(configJSON))
	html := strings.Replace(string(content), "</head>", injected, 1)

	versionTag := s.assetVersion
	html = strings.ReplaceAll(html, "/dist/app.js", fmt.Sprintf("/dist/app.js?v=%s", url.QueryEscape(versionTag)))
	html = strings.ReplaceAll(html, "/dist/app.css", fmt.Sprintf("/dist/app.css?v=%s", url.QueryEscape(versionTag)))
	html = strings.ReplaceAll(html, "/preload.js", fmt.Sprintf("/preload.js?v=%s", url.QueryEscape(versionTag)))

	http.SetCookie(w, &http.Cookie{
		Name:     "jj_view_token",
		Value:    activeToken,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	_, _ = w.Write([]byte(html))
}

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

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
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

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

	clientID := r.URL.Query().Get("clientId")
	if clientID == "" {
		clientID = r.Header.Get("X-Client-ID")
	}
	if clientID == "" {
		tokenBytes := make([]byte, 16)
		_, _ = rand.Read(tokenBytes)
		clientID = hex.EncodeToString(tokenBytes)
	}

	client := newSSEClient(clientID, w, flusher)

	s.clientsMu.Lock()
	s.sseClients[clientID] = client
	s.clientsMu.Unlock()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// Send initial connected event
	_ = client.send(protocol.NewNotification("system.connected", map[string]any{
		"clientId": clientID,
	}))

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	defer func() {
		s.clientsMu.Lock()
		delete(s.sseClients, clientID)
		s.clientsMu.Unlock()

		client.cleanup(s)
	}()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-client.done:
			return
		case <-ticker.C:
			if err := client.ping(); err != nil {
				return
			}
		}
	}
}

type sseClient struct {
	id            string
	w             http.ResponseWriter
	flusher       http.Flusher
	writeMu       sync.Mutex
	subsMu        sync.Mutex
	subscriptions map[string]bool
	done          chan struct{}
	closed        bool
}

func newSSEClient(id string, w http.ResponseWriter, flusher http.Flusher) *sseClient {
	return &sseClient{
		id:            id,
		w:             w,
		flusher:       flusher,
		subscriptions: make(map[string]bool),
		done:          make(chan struct{}),
	}
}

func (c *sseClient) send(notification any) error {
	data, err := json.Marshal(notification)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return errors.New("client closed")
	}
	_, err = fmt.Fprintf(c.w, "data: %s\n\n", data)
	if err != nil {
		return err
	}
	c.flusher.Flush()
	return nil
}

func (c *sseClient) ping() error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return errors.New("client closed")
	}
	_, err := fmt.Fprintf(c.w, ": ping\n\n")
	if err != nil {
		return err
	}
	c.flusher.Flush()
	return nil
}

func (c *sseClient) close() {
	c.writeMu.Lock()
	if !c.closed {
		c.closed = true
		close(c.done)
	}
	c.writeMu.Unlock()
}

func (c *sseClient) cleanup(s *Server) {
	c.close()
	c.subsMu.Lock()
	subs := make([]string, 0, len(c.subscriptions))
	for subID := range c.subscriptions {
		subs = append(subs, subID)
	}
	c.subscriptions = make(map[string]bool)
	c.subsMu.Unlock()

	for _, subID := range subs {
		s.watcherHub.Unwatch(subID)
	}
}

func (s *Server) dispatch(ctx context.Context, clientID string, req *protocol.Request) (any, *protocol.RPCError) {
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
			"platform": plat,
			"version":  s.cfg.Version,
			"build":    s.assetVersion,
			"repoRoot": s.cfg.RepoRoot,
			"tempDir":  s.fsMgr.DaemonTempDir(),
		}, nil

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
			BaseDir:    params.BaseDir,
			Pattern:    params.Pattern,
			MaxResults: params.MaxResults,
			Excludes:   params.Excludes,
		})
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string][]string{"files": files}, nil

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
		subID, err := s.watcherHub.Watch(validatedDir, watcher.WatchOptions{Ignore: params.Ignore}, func(reportedSubID string, events []watcher.FileEvent) {
			s.notifyClient(clientID, "watcher.change", map[string]any{
				"subscriptionId": reportedSubID,
				"events":         events,
			})
		})
		if err != nil {
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
		return map[string]any{"success": true, "path": resolvedPath}, nil

	default:
		return nil, &protocol.RPCError{
			Code:    protocol.CodeMethodNotFound,
			Message: fmt.Sprintf("method not found: %s", req.Method),
		}
	}
}
