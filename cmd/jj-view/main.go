// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/brychanrobot/jj-view/internal/server"
)

var (
	version = "2.9.0"
)

func main() {
	hostFlag := flag.String("host", "127.0.0.1", "Host address to bind to")
	portFlag := flag.Int("port", 8080, "Port to listen on (0 for dynamic port)")
	repoFlag := flag.String("repo", ".", "Path to Jujutsu repository")
	userDataDirFlag := flag.String("user-data-dir", "", "Path to user data directory for settings and state")
	userConfigFlag := flag.String("user-config", "", "Path to custom user configuration JSON file")
	noOpenFlag := flag.Bool("no-open", false, "Do not open browser automatically")
	versionFlag := flag.Bool("version", false, "Print version and exit")

	flag.Parse()

	if *versionFlag {
		fmt.Printf("jj-view version %s\n", version)
		os.Exit(0)
	}

	passedFlags := make(map[string]bool)
	flag.Visit(func(f *flag.Flag) {
		passedFlags[f.Name] = true
	})

	isSidecar := os.Getenv("ANTIGRAVITY_SIDECAR_WEB_PORT") != "" ||
		os.Getenv("ANTIGRAVITY_SIDECAR_UI_TOKEN") != "" ||
		os.Getenv("ANTIGRAVITY_EXECUTABLE_DATA_DIR") != "" ||
		os.Getenv("JJ_VIEW_AGY_SIDECAR") != ""

	port := *portFlag
	if !passedFlags["port"] {
		if pStr := os.Getenv("ANTIGRAVITY_SIDECAR_WEB_PORT"); pStr != "" {
			if p, err := strconv.Atoi(pStr); err == nil && p >= 0 && p <= 65535 {
				port = p
			} else {
				log.Printf("[WARN] Invalid ANTIGRAVITY_SIDECAR_WEB_PORT %q: %v; using %d", pStr, err, port)
			}
		}
	}

	noOpen := *noOpenFlag
	if !passedFlags["no-open"] && isSidecar {
		noOpen = true
	}

	absRepo, err := filepath.Abs(*repoFlag)
	if err != nil {
		log.Fatalf("Failed to resolve repository path: %v", err)
	}

	var userConfigPath string
	if *userConfigFlag != "" {
		absConfig, err := filepath.Abs(*userConfigFlag)
		if err != nil {
			log.Fatalf("Failed to resolve user config path: %v", err)
		}
		userConfigPath = absConfig
	}

	var absUserDataDir string
	if passedFlags["user-data-dir"] && *userDataDirFlag != "" {
		resolved, err := filepath.Abs(*userDataDirFlag)
		if err != nil {
			log.Fatalf("Failed to resolve user data directory: %v", err)
		}
		absUserDataDir = resolved
	}

	cfg := server.Config{
		Host:           *hostFlag,
		Port:           port,
		RepoRoot:       absRepo,
		SidecarToken:   os.Getenv("ANTIGRAVITY_SIDECAR_UI_TOKEN"),
		CSRFToken:      os.Getenv("ANTIGRAVITY_CSRF_TOKEN"),
		Version:        version,
		UserDataDir:    absUserDataDir,
		UserConfigPath: userConfigPath,
	}

	srv, err := server.NewServer(cfg)
	if err != nil {
		log.Fatalf("Failed to initialize server: %v", err)
	}

	if err := srv.Listen(); err != nil {
		log.Fatalf("Failed to listen: %v", err)
	}

	go func() {
		if err := srv.Start(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	serverURL := fmt.Sprintf("http://%s:%d/?token=%s", *hostFlag, srv.Port(), srv.SessionToken())
	fmt.Printf("\n  JJ View is running at:\n  %s\n\n", serverURL)

	if !noOpen {
		go openBrowser(serverURL)
	}

	// Handle graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	fmt.Println("\nShutting down JJ View server...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Close(ctx); err != nil {
		log.Printf("Error during shutdown: %v", err)
	}
}

func openBrowser(targetURL string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", targetURL)
	case "darwin":
		cmd = exec.Command("open", targetURL)
	default:
		cmd = exec.Command("xdg-open", targetURL)
	}
	_ = cmd.Start()
}
