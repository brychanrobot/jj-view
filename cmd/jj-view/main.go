// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
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
	"strings"
	"syscall"
	"time"

	"github.com/brychanrobot/jj-view/internal/server"
)

var (
	version = "2.10.0"
)

const installAntigravityPluginCommand = "install-antigravity-plugin"

func main() {
	if len(os.Args) > 1 && os.Args[1] == installAntigravityPluginCommand {
		err := runInstallAntigravityPlugin(os.Args[2:])
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		if err != nil {
			log.Fatalf("Install failed: %v", err)
		}
		return
	}

	flag.Usage = func() {
		printUsage(flag.CommandLine, "jj-view [flags]",
			"Serve the JJ View UI for a Jujutsu repository.",
			"Subcommands:\n  "+installAntigravityPluginCommand+"  Register this binary as an Antigravity plugin.")
	}
	hostFlag := flag.String("host", "127.0.0.1", "Host address to bind to")
	portFlag := flag.Int("port", 8080, "Port to listen on (0 for dynamic port)")
	repoFlag := flag.String("repo", ".", "Path to Jujutsu repository")
	userDataDirFlag := flag.String("user-data-dir", "", "Path to user data directory for settings and state")
	userConfigFlag := flag.String("user-config", "", "Path to custom user configuration JSON file")
	noOpenFlag := flag.Bool("no-open", false, "Do not open browser automatically")
	allowedOriginsFlag := flag.String("allowed-origins", "", "Comma-separated extra browser origin hosts to accept, e.g. 'ui.example.com,*.proxy.example.com'. Loopback, the bound host and the request host are always accepted.")
	versionFlag := flag.Bool("version", false, "Print version and exit")

	flag.Parse()

	// The standard flag package stops at the first positional argument and
	// silently ignores the rest, so a mistyped subcommand would otherwise
	// start the server with defaults.
	if flag.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "jj-view: unknown command %q\n\n", flag.Arg(0))
		flag.Usage()
		os.Exit(2)
	}

	if *versionFlag {
		fmt.Printf("jj-view version %s\n", version)
		os.Exit(0)
	}

	execPath := resolveExecutablePath(os.Args[0])
	reloadPortStr := os.Getenv(reloadPortEnvVar)
	reloadSessionToken := os.Getenv(reloadSessionTokenEnvVar)
	_ = os.Unsetenv(reloadPortEnvVar)
	_ = os.Unsetenv(reloadSessionTokenEnvVar)
	isReload := reloadPortStr != "" || reloadSessionToken != ""

	passedFlags := make(map[string]bool)
	flag.Visit(func(f *flag.Flag) {
		passedFlags[f.Name] = true
	})

	isSidecar := os.Getenv("ANTIGRAVITY_SIDECAR_WEB_PORT") != "" ||
		os.Getenv("ANTIGRAVITY_SIDECAR_UI_TOKEN") != "" ||
		os.Getenv("ANTIGRAVITY_EXECUTABLE_DATA_DIR") != "" ||
		os.Getenv("JJ_VIEW_AGY_SIDECAR") != ""

	port := *portFlag
	if reloadPortStr != "" {
		if p, err := strconv.Atoi(reloadPortStr); err == nil && p > 0 && p <= 65535 {
			port = p
		}
	} else if !passedFlags["port"] {
		if pStr := os.Getenv("ANTIGRAVITY_SIDECAR_WEB_PORT"); pStr != "" {
			if p, err := strconv.Atoi(pStr); err == nil && p >= 0 && p <= 65535 {
				port = p
			} else {
				log.Printf("[WARN] Invalid ANTIGRAVITY_SIDECAR_WEB_PORT %q: %v; using %d", pStr, err, port)
			}
		}
	}

	noOpen := *noOpenFlag
	if isReload || (!passedFlags["no-open"] && isSidecar) {
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

	var allowedOrigins []string
	for _, entry := range strings.Split(*allowedOriginsFlag, ",") {
		if trimmed := strings.TrimSpace(entry); trimmed != "" {
			allowedOrigins = append(allowedOrigins, trimmed)
		}
	}

	cfg := server.Config{
		Host:           *hostFlag,
		Port:           port,
		RepoRoot:       absRepo,
		SessionToken:   reloadSessionToken,
		SidecarToken:   os.Getenv("ANTIGRAVITY_SIDECAR_UI_TOKEN"),
		CSRFToken:      os.Getenv("ANTIGRAVITY_CSRF_TOKEN"),
		Version:        version,
		UserDataDir:    absUserDataDir,
		UserConfigPath: userConfigPath,
		AllowedOrigins: allowedOrigins,
	}

	srv, err := server.NewServer(cfg)
	if err != nil {
		log.Fatalf("Failed to initialize server: %v", err)
	}

	if err := listenWithReloadRetry(srv, isReload); err != nil {
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

	// Handle graceful shutdown and in-place reload (SIGHUP)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	sig := <-sigChan

	if sig == syscall.SIGHUP {
		fmt.Println("\nReloading JJ View server in-place (SIGHUP)...")
	} else {
		fmt.Println("\nShutting down JJ View server...")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Close(ctx); err != nil {
		log.Printf("Error during shutdown: %v", err)
	}

	if sig == syscall.SIGHUP {
		signal.Reset(syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
		if err := execInPlace(execPath, os.Args, os.Environ(), srv.Port(), srv.SessionToken()); err != nil {
			log.Fatalf("In-place reload failed: %v", err)
		}
	}
}

func listenWithReloadRetry(srv *server.Server, isReload bool) error {
	err := srv.Listen()
	if err == nil || !isReload {
		return err
	}
	for i := 0; i < 50; i++ {
		time.Sleep(10 * time.Millisecond)
		if err = srv.Listen(); err == nil {
			return nil
		}
	}
	return err
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
