// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/brychanrobot/jj-view/internal/config"
	"github.com/brychanrobot/jj-view/internal/fs"
	"github.com/brychanrobot/jj-view/internal/process"
	"github.com/brychanrobot/jj-view/internal/protocol"
	"github.com/brychanrobot/jj-view/internal/secret"
	"github.com/brychanrobot/jj-view/internal/state"
	"github.com/brychanrobot/jj-view/internal/watcher"
	"github.com/brychanrobot/jj-view/web"
)

const (
	maxWSReadLimit = 100 * 1024 * 1024 // 100 MB
)

// Config configures the server instance.
type Config struct {
	Host           string
	Port           int
	RepoRoot       string
	SessionToken   string
	Version        string
	UserDataDir    string
	UserConfigPath string
	UserStatePath  string
	UserSecretPath string
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
	httpServer   *http.Server
	listener     net.Listener
	readyCh      chan struct{}
	upgrader     websocket.Upgrader
	allowedHosts map[string]bool
	fileServer   http.Handler
	clientsMu    sync.Mutex
	clients      map[*wsClient]bool
	mu           sync.RWMutex
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
		cfg:        cfg,
		fsMgr:      fsMgr,
		watcherHub: watcher.NewHub(),
		readyCh:    make(chan struct{}),
		clients:    make(map[*wsClient]bool),
		allowedHosts: map[string]bool{
			"api.github.com": true,
			"github.com":     true,
			"gitlab.com":     true,
		},
		fileServer: http.FileServer(http.FS(web.FS)),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024 * 1024,
			WriteBufferSize: 1024 * 1024,
			CheckOrigin:     func(r *http.Request) bool { return true },
		},
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

// AddAllowedHost adds a trusted forge host to the proxy whitelist.
func (s *Server) AddAllowedHost(host string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.allowedHosts[host] = true
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
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/forge-proxy", s.handleForgeProxy)
	mux.HandleFunc("/ws/system", s.handleWebSocket)

	s.httpServer = &http.Server{
		Handler:      mux,
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 60 * time.Second,
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
	for client := range s.clients {
		client.close()
	}
	s.clients = make(map[*wsClient]bool)
	s.clientsMu.Unlock()

	if s.httpServer != nil {
		return s.httpServer.Shutdown(ctx)
	}
	return nil
}

func (s *Server) broadcastNotification(method string, params any) {
	s.clientsMu.Lock()
	clients := make([]*wsClient, 0, len(s.clients))
	for client := range s.clients {
		clients = append(clients, client)
	}
	s.clientsMu.Unlock()

	notification := protocol.NewNotification(method, params)
	for _, client := range clients {
		_ = client.send(notification)
	}
}

func (s *Server) broadcastConfigChange(key string, scope string) {
	s.broadcastNotification("config/didChange", map[string]any{
		"key":   key,
		"scope": scope,
	})
}

func (s *Server) authenticateRequest(r *http.Request) bool {
	token := r.URL.Query().Get("token")
	if token == "" {
		authHeader := r.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bearer ") {
			token = strings.TrimPrefix(authHeader, "Bearer ")
		}
	}
	if token == "" {
		if cookie, err := r.Cookie("jj_view_token"); err == nil {
			token = cookie.Value
		}
	}
	return token == s.cfg.SessionToken
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":  "ok",
		"version": s.cfg.Version,
		"repo":    s.cfg.RepoRoot,
	})
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	cleanPath := path.Clean(r.URL.Path)

	// If the path is not root or index.html, check if it's an existing static file in web.FS
	if cleanPath != "/" && cleanPath != "/index.html" && cleanPath != "." {
		trimmed := strings.TrimPrefix(cleanPath, "/")
		if file, err := web.FS.Open(trimmed); err == nil {
			stat, statErr := file.Stat()
			_ = file.Close()
			if statErr == nil && !stat.IsDir() {
				s.fileServer.ServeHTTP(w, r)
				return
			}
		}
	}

	// For root, /index.html, or client-side SPA routes (fallback to index.html):
	// Authenticate to prevent local processes from scraping the session token
	if !s.authenticateRequest(r) {
		http.Error(w, "Unauthorized: missing or invalid session token", http.StatusUnauthorized)
		return
	}

	content, err := web.FS.ReadFile("index.html")
	if err != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}

	configJSON, _ := json.Marshal(map[string]any{
		"token":    s.cfg.SessionToken,
		"port":     s.cfg.Port,
		"repoRoot": s.cfg.RepoRoot,
	})

	injected := fmt.Sprintf("<script>window.__JJ_VIEW_CONFIG__ = %s;</script>\n</head>", string(configJSON))
	html := strings.Replace(string(content), "</head>", injected, 1)

	http.SetCookie(w, &http.Cookie{
		Name:     "jj_view_token",
		Value:    s.cfg.SessionToken,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	_, _ = w.Write([]byte(html))
}

func (s *Server) handleForgeProxy(w http.ResponseWriter, r *http.Request) {
	// Authenticate proxy endpoint
	if !s.authenticateRequest(r) {
		http.Error(w, "Unauthorized: invalid session token", http.StatusUnauthorized)
		return
	}

	rawTarget := r.URL.Query().Get("url")
	if rawTarget == "" {
		http.Error(w, "missing url query parameter", http.StatusBadRequest)
		return
	}

	targetURL, err := url.Parse(rawTarget)
	if err != nil || targetURL.Scheme != "https" {
		http.Error(w, "target URL must be valid HTTPS", http.StatusBadRequest)
		return
	}

	hostname := targetURL.Hostname()
	s.mu.RLock()
	allowed := s.allowedHosts[hostname]
	s.mu.RUnlock()

	if !allowed {
		http.Error(w, fmt.Sprintf("target host %s not allowed by proxy whitelist", hostname), http.StatusForbidden)
		return
	}

	proxyReq, err := http.NewRequestWithContext(r.Context(), r.Method, rawTarget, r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	for _, h := range []string{"Authorization", "Accept", "Content-Type", "User-Agent"} {
		if val := r.Header.Get(h); val != "" {
			proxyReq.Header.Set(h, val)
		}
	}

	client := &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("stopped after 10 redirects")
			}
			if req.URL.Scheme != "https" {
				return fmt.Errorf("insecure redirect scheme: %s", req.URL.Scheme)
			}
			s.mu.RLock()
			isAllowed := s.allowedHosts[req.URL.Hostname()]
			s.mu.RUnlock()
			if !isAllowed {
				return fmt.Errorf("redirect host %s not in allowed list", req.URL.Hostname())
			}
			return nil
		},
	}

	resp, err := client.Do(proxyReq)
	if err != nil {
		http.Error(w, fmt.Sprintf("proxy request failed: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	if !s.authenticateRequest(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Validate Origin to prevent Cross-Site WebSocket Hijacking (CSWSH)
	origin := r.Header.Get("Origin")
	if origin != "" {
		if origin == "null" {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		parsedOrigin, err := url.Parse(origin)
		if err != nil || (parsedOrigin.Scheme != "http" && parsedOrigin.Scheme != "https" && parsedOrigin.Scheme != "vscode-webview") {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		host := parsedOrigin.Hostname()
		if host != "localhost" && host != "127.0.0.1" && host != s.cfg.Host {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	// CRITICAL FIX: Clear http.Server Read/Write timeouts on the hijacked TCP connection!
	_ = conn.UnderlyingConn().SetDeadline(time.Time{})
	_ = conn.UnderlyingConn().SetReadDeadline(time.Time{})
	_ = conn.UnderlyingConn().SetWriteDeadline(time.Time{})

	conn.SetReadLimit(maxWSReadLimit)

	client := newWsClient(conn, s)

	s.clientsMu.Lock()
	s.clients[client] = true
	s.clientsMu.Unlock()

	defer func() {
		s.clientsMu.Lock()
		delete(s.clients, client)
		s.clientsMu.Unlock()
		client.cleanup()
		_ = conn.Close()
	}()

	client.serve()
}

type wsClient struct {
	conn          *websocket.Conn
	server        *Server
	writeMu       sync.Mutex
	reqMu         sync.Mutex
	cancelFunc    map[string]context.CancelFunc
	subsMu        sync.Mutex
	subscriptions map[string]bool
	closed        bool
}

func newWsClient(conn *websocket.Conn, s *Server) *wsClient {
	return &wsClient{
		conn:          conn,
		server:        s,
		cancelFunc:    make(map[string]context.CancelFunc),
		subscriptions: make(map[string]bool),
	}
}

func (c *wsClient) send(v any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return errors.New("connection closed")
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return c.conn.WriteJSON(v)
}

func (c *wsClient) trackSubscription(subID string) {
	c.subsMu.Lock()
	if c.closed {
		c.subsMu.Unlock()
		c.server.watcherHub.Unwatch(subID)
		return
	}
	c.subscriptions[subID] = true
	c.subsMu.Unlock()
}

func (c *wsClient) untrackSubscription(subID string) {
	c.subsMu.Lock()
	defer c.subsMu.Unlock()
	delete(c.subscriptions, subID)
}

func (c *wsClient) close() {
	c.writeMu.Lock()
	if !c.closed {
		c.closed = true
		_ = c.conn.SetWriteDeadline(time.Now().Add(1 * time.Second))
		_ = c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
		_ = c.conn.Close()
	}
	c.writeMu.Unlock()
}

func (c *wsClient) cleanup() {
	// Cancel all in-flight request contexts
	c.reqMu.Lock()
	for _, cancel := range c.cancelFunc {
		cancel()
	}
	c.cancelFunc = make(map[string]context.CancelFunc)
	c.reqMu.Unlock()

	// Clean up all active watcher subscriptions to prevent inotify leaks
	c.subsMu.Lock()
	c.closed = true
	for subID := range c.subscriptions {
		c.server.watcherHub.Unwatch(subID)
	}
	c.subscriptions = make(map[string]bool)
	c.subsMu.Unlock()
}

func (c *wsClient) serve() {
	for {
		var req protocol.Request
		if err := c.conn.ReadJSON(&req); err != nil {
			break
		}

		if req.JSONRPC != "2.0" {
			if !req.IsNotification() {
				_ = c.send(protocol.NewErrorResponse(req.ID, protocol.CodeInvalidRequest, "invalid jsonrpc version", nil))
			}
			continue
		}

		// Handle cancellation notification
		if req.Method == "$/cancelRequest" {
			var cancelParams struct {
				ID any `json:"id"`
			}
			if err := json.Unmarshal(req.Params, &cancelParams); err == nil {
				key := fmt.Sprintf("%v", cancelParams.ID)
				c.reqMu.Lock()
				cancel, ok := c.cancelFunc[key]
				c.reqMu.Unlock()
				if ok {
					cancel()
				}
			}
			continue
		}

		ctx, cancel := context.WithCancel(context.Background())
		var cancelKey string
		if req.ID != nil {
			cancelKey = protocol.NormalizeID(req.ID)
			c.reqMu.Lock()
			c.cancelFunc[cancelKey] = cancel
			c.reqMu.Unlock()
		}

		go c.handleRequest(&req, ctx, cancel, cancelKey)
	}
}

func (c *wsClient) handleRequest(req *protocol.Request, ctx context.Context, cancel context.CancelFunc, cancelKey string) {
	defer cancel()

	if cancelKey != "" {
		defer func() {
			c.reqMu.Lock()
			delete(c.cancelFunc, cancelKey)
			c.reqMu.Unlock()
		}()
	}

	res, rpcErr := c.dispatch(ctx, req)
	if req.IsNotification() {
		return
	}

	if rpcErr != nil {
		_ = c.send(protocol.NewErrorResponse(req.ID, rpcErr.Code, rpcErr.Message, rpcErr.Data))
		return
	}

	_ = c.send(protocol.NewSuccessResponse(req.ID, res))
}

func (c *wsClient) dispatch(ctx context.Context, req *protocol.Request) (any, *protocol.RPCError) {
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
			"version":  c.server.cfg.Version,
			"repoRoot": c.server.cfg.RepoRoot,
			"tempDir":  c.server.fsMgr.DaemonTempDir(),
		}, nil

	case "process.execFile":
		var params process.ExecParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		if params.Cwd == "" {
			params.Cwd = c.server.cfg.RepoRoot
		} else {
			// Validate cwd inside sandbox
			validatedCwd, err := c.server.fsMgr.ValidatePath(params.Cwd)
			if err != nil {
				return nil, &protocol.RPCError{Code: protocol.CodeSecurityError, Message: err.Error()}
			}
			params.Cwd = validatedCwd
		}

		res, err := c.server.procMgr.ExecFile(ctx, params)
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
		path, err := c.server.procMgr.GetHelperScriptPath(params.Name)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]string{"path": path}, nil

	case "fs.readFile":
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		data, err := c.server.fsMgr.ReadFile(params.Path)
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
		if err := c.server.fsMgr.WriteFile(params.Path, data); err != nil {
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
		if err := c.server.fsMgr.Mkdir(params.Path, params.Recursive); err != nil {
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
		st, err := c.server.fsMgr.Stat(params.Path)
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
		st, err := c.server.fsMgr.Lstat(params.Path)
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
		files, err := c.server.fsMgr.Readdir(params.Path)
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
		exists := c.server.fsMgr.Exists(params.Path)
		return map[string]bool{"exists": exists}, nil

	case "fs.realpath":
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		resolved, err := c.server.fsMgr.Realpath(params.Path)
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
		dir, err := c.server.fsMgr.Mkdtemp(params.Prefix)
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
		if err := c.server.fsMgr.Rm(params.Path, params.Recursive, params.Force); err != nil {
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
		files, err := c.server.fsMgr.FindFiles(fs.FindFilesOptions{
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
		validatedDir, err := c.server.fsMgr.ValidatePath(params.DirPath)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeSecurityError, Message: err.Error()}
		}
		subID, err := c.server.watcherHub.Watch(validatedDir, watcher.WatchOptions{Ignore: params.Ignore}, func(reportedSubID string, events []watcher.FileEvent) {
			_ = c.send(protocol.NewNotification("watcher.change", map[string]any{
				"subscriptionId": reportedSubID,
				"events":         events,
			}))
		})
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		c.trackSubscription(subID)
		return map[string]string{"subscriptionId": subID}, nil

	case "watcher.unwatch":
		var params struct {
			SubscriptionID string `json:"subscriptionId"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		c.untrackSubscription(params.SubscriptionID)
		c.server.watcherHub.Unwatch(params.SubscriptionID)
		return map[string]bool{"success": true}, nil

	case "config.get":
		var params struct {
			Key   string `json:"key"`
			Scope string `json:"scope,omitempty"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		val, ok := c.server.configStore.GetScoped(params.Scope, params.Key)
		return map[string]any{"value": val, "found": ok}, nil

	case "config.set":
		var params struct {
			Key   string `json:"key"`
			Value any    `json:"value"`
			Scope string `json:"scope,omitempty"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		if err := c.server.configStore.SetScoped(params.Scope, params.Key, params.Value); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]bool{"success": true}, nil

	case "config.getAll":
		var params struct {
			Scope string `json:"scope,omitempty"`
		}
		if len(req.Params) > 0 {
			_ = json.Unmarshal(req.Params, &params)
		}
		return c.server.configStore.GetAllScoped(params.Scope), nil

	case "state.get":
		var params struct {
			Key string `json:"key"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		val, ok := c.server.stateStore.Get(params.Key)
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
		if err := c.server.stateStore.Set(params.Key, params.Value); err != nil {
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
		if err := c.server.stateStore.Delete(params.Key); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		return map[string]bool{"success": true}, nil

	case "state.getAll":
		return c.server.stateStore.GetAll(), nil

	case "secrets.get":
		var params struct {
			Key string `json:"key"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		val, ok := c.server.secretStore.Get(params.Key)
		if !ok {
			return map[string]any{"found": false}, nil
		}
		return map[string]any{"value": val, "found": true}, nil

	case "secrets.store":
		var params struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
		}
		if err := c.server.secretStore.Store(params.Key, params.Value); err != nil {
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
		if err := c.server.secretStore.Delete(params.Key); err != nil {
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
