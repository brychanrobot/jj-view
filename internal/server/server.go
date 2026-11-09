// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/brychanrobot/jj-view/internal/config"
	"github.com/brychanrobot/jj-view/internal/fs"
	"github.com/brychanrobot/jj-view/internal/gitcred"
	"github.com/brychanrobot/jj-view/internal/process"
	"github.com/brychanrobot/jj-view/internal/secret"
	"github.com/brychanrobot/jj-view/internal/state"
	"github.com/brychanrobot/jj-view/internal/update"
	"github.com/brychanrobot/jj-view/internal/watcher"
	"github.com/brychanrobot/jj-view/web"
)

// Config configures the server instance.
type Config struct {
	Host              string
	Port              int
	RepoRoot          string
	SessionToken      string
	SidecarToken      string
	CSRFToken         string
	Version           string
	ReleaseAsset      string
	ExecutablePath    string
	ReleasesURL       string
	OnReload          func() error
	UserDataDir       string
	UserConfigPath    string
	UserStatePath     string
	UserSecretPath    string
	AllowedOrigins    []string
	ExtraAllowedRoots []string
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
	updater      *update.Updater
	httpServer   *http.Server
	listener     net.Listener
	readyCh      chan struct{}
	bgCtx        context.Context
	bgCancel     context.CancelFunc
	fileServer   http.Handler
	assetVersion string
	clientsMu    sync.Mutex
	sseClients   map[string]*sseClient
	wsClients    map[*wsConn]struct{}
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
	extraRoots = append(extraRoots, cfg.ExtraAllowedRoots...)

	fsMgr, err := fs.NewSandboxManager(cfg.RepoRoot, extraRoots...)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize sandbox: %w", err)
	}

	bgCtx, bgCancel := context.WithCancel(context.Background())

	s := &Server{
		cfg:        cfg,
		fsMgr:      fsMgr,
		watcherHub: watcher.NewHub(),
		readyCh:    make(chan struct{}),
		bgCtx:      bgCtx,
		bgCancel:   bgCancel,
		sseClients: make(map[string]*sseClient),
		wsClients:  make(map[*wsConn]struct{}),
		gitCreds:   gitcred.NewResolver(gitcred.Options{Logf: log.Printf}),
		updater: update.NewUpdater(update.Options{
			CurrentVersion: cfg.Version,
			ReleaseAsset:   cfg.ReleaseAsset,
			ExecutablePath: cfg.ExecutablePath,
			ReleasesURL:    cfg.ReleasesURL,
			OnReload:       cfg.OnReload,
		}),
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
		bgCancel()
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
		bgCancel()
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
		bgCancel()
		return nil, fmt.Errorf("failed to initialize secret store: %w", err)
	}
	s.secretStore = secretStore
	s.procMgr = process.NewManager(filepath.Join(fsMgr.DaemonTempDir(), "scripts"))
	s.procMgr.SetAllowedForgeCommand(func() string {
		userCfg := s.configStore.GetAllScoped(string(config.ScopeUser))
		if val, ok := userCfg["codeForge.adapterCommand"].(string); ok && strings.TrimSpace(val) != "" {
			return strings.TrimSpace(val)
		}
		if val, ok := userCfg["jj-view.codeForge.adapterCommand"].(string); ok && strings.TrimSpace(val) != "" {
			return strings.TrimSpace(val)
		}
		vscodeUserCfg := s.configStore.GetAllScoped(string(config.ScopeVscodeUser))
		if val, ok := vscodeUserCfg["codeForge.adapterCommand"].(string); ok && strings.TrimSpace(val) != "" {
			return strings.TrimSpace(val)
		}
		if val, ok := vscodeUserCfg["jj-view.codeForge.adapterCommand"].(string); ok && strings.TrimSpace(val) != "" {
			return strings.TrimSpace(val)
		}
		return ""
	})

	s.restoreAllowedRootsFromState()
	s.maybeWarmRepoRoot(cfg.RepoRoot)
	for _, r := range cfg.ExtraAllowedRoots {
		s.maybeWarmRepoRoot(r)
	}

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

func (s *Server) maybeWarmRepoRoot(dir string) {
	if dir == "" {
		return
	}
	if _, err := os.Stat(filepath.Join(dir, ".jj")); err == nil {
		s.fsMgr.WarmFileIndex(s.bgCtx, dir)
		return
	}
}

func (s *Server) restoreAllowedRootsFromState() {
	if s.stateStore == nil {
		return
	}
	allState := s.stateStore.GetAll()
	seen := make(map[string]bool)
	addCandidate := func(p string) {
		if p == "" || !filepath.IsAbs(p) || seen[p] {
			return
		}
		seen[p] = true
		fi, err := os.Stat(filepath.Join(p, ".jj"))
		if err != nil || !fi.IsDir() {
			return
		}
		resolved, err := filepath.EvalSymlinks(p)
		if err != nil {
			resolved = p
		}
		s.fsMgr.AddAllowedRoot(p)
		if resolved != p {
			s.fsMgr.AddAllowedRoot(resolved)
		}
		if s.configStore != nil {
			s.configStore.WatchWorkspaceRoot(resolved)
		}
	}

	for key, raw := range allState {
		baseKey := strings.TrimPrefix(key, "jj-view.")
		if strings.HasPrefix(baseKey, "discoveredRepoPaths") {
			var entries []struct {
				RootPath string `json:"rootPath"`
			}
			if err := json.Unmarshal(raw, &entries); err == nil {
				for _, e := range entries {
					addCandidate(e.RootPath)
				}
			}
		} else if strings.HasPrefix(baseKey, "lastFocusedRepoPath") {
			var rootPath string
			if err := json.Unmarshal(raw, &rootPath); err == nil {
				addCandidate(rootPath)
			}
		}
	}
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

	httpSrv := &http.Server{
		Handler:      mux,
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 0,
	}

	s.mu.Lock()
	s.httpServer = httpSrv
	listener := s.listener
	s.mu.Unlock()

	return httpSrv.Serve(listener)
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

// AllowedRoots returns the currently allowed sandbox root directories.
func (s *Server) AllowedRoots() []string {
	return s.fsMgr.AllowedRoots()
}

// Close gracefully stops the server and closes all active clients.
func (s *Server) Close(ctx context.Context) error {
	if s.bgCancel != nil {
		s.bgCancel()
	}
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

	s.mu.RLock()
	httpSrv := s.httpServer
	listener := s.listener
	s.mu.RUnlock()

	if httpSrv != nil {
		if err := httpSrv.Shutdown(ctx); err != nil {
			_ = httpSrv.Close()
			return err
		}
	} else if listener != nil {
		_ = listener.Close()
	}
	return nil
}
