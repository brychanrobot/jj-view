// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/brychanrobot/jj-view/internal/protocol"
	"github.com/brychanrobot/jj-view/internal/server"
)

const (
	openCommand     = "open"
	maxRPCRespBytes = 64 * 1024
)

var (
	errNoExistingServer = errors.New("no running JJ View server found")
	errCandidateAuth    = errors.New("authentication failed")
)

type openOptions struct {
	Host        string
	Port        int
	FolderPath  string
	UserDataDir string
}

type openFolderResult struct {
	Path   string
	TabURL string
}

func isAddrInUse(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "address already in use") ||
		strings.Contains(msg, "only one usage of each socket address")
}

func dialHostForConnect(host string) string {
	trimmed := strings.Trim(strings.TrimSpace(host), "[]")
	switch trimmed {
	case "", "0.0.0.0":
		return "127.0.0.1"
	case "::":
		return "::1"
	default:
		return trimmed
	}
}

func probeServerHealth(client *http.Client, host string, port int) (bool, bool) {
	addr := net.JoinHostPort(dialHostForConnect(host), strconv.Itoa(port))
	resp, err := client.Get("http://" + addr + "/api/health")
	if err != nil {
		return false, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, false
	}
	var body map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxRPCRespBytes)).Decode(&body); err != nil {
		return false, false
	}
	status, _ := body["status"].(string)
	_, hasRepo := body["repo"].(string)
	if status != "ok" || !hasRepo {
		return false, false
	}
	isSidecar, _ := body["sidecar"].(bool)
	return true, isSidecar
}

func sendAddAllowedRootRPC(client *http.Client, addr string, absFolder string, sessionToken string) error {
	reqID := json.RawMessage("1")
	paramsBytes, err := json.Marshal(map[string]any{
		"path": absFolder,
	})
	if err != nil {
		return err
	}
	rpcReq := protocol.Request{
		JSONRPC: "2.0",
		ID:      &reqID,
		Method:  "workspace.addAllowedRoot",
		Params:  paramsBytes,
	}
	reqBytes, err := json.Marshal(rpcReq)
	if err != nil {
		return err
	}

	req, err := http.NewRequest(http.MethodPost, "http://"+addr+"/api/rpc", bytes.NewReader(reqBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+sessionToken)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to contact JJ View server at %s: %w", addr, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("%w for JJ View server at %s (HTTP %d); the instance metadata may be stale", errCandidateAuth, addr, resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("JJ View server at %s returned HTTP %d: %s", addr, resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}

	var rpcResp struct {
		JSONRPC string             `json:"jsonrpc"`
		Error   *protocol.RPCError `json:"error"`
		Result  struct {
			Success bool `json:"success"`
		} `json:"result"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxRPCRespBytes)).Decode(&rpcResp); err != nil {
		return fmt.Errorf("failed to decode server response: %w", err)
	}
	if rpcResp.Error != nil {
		return fmt.Errorf("server rejected folder: %s", rpcResp.Error.Message)
	}
	if !rpcResp.Result.Success {
		return fmt.Errorf("server failed to register folder %q", absFolder)
	}
	return nil
}

func openFolderOnExistingServer(opts openOptions) (*openFolderResult, error) {
	if opts.Port <= 0 || opts.Port > 65535 {
		return nil, fmt.Errorf("invalid port %d", opts.Port)
	}
	rawPath := strings.TrimSpace(opts.FolderPath)
	if rawPath == "" {
		rawPath = "."
	}
	absFolder, err := filepath.Abs(rawPath)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve folder path: %w", err)
	}

	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	isJJView, isSidecar := probeServerHealth(client, opts.Host, opts.Port)
	if !isJJView {
		return nil, errNoExistingServer
	}

	fi, err := os.Stat(absFolder)
	if err != nil {
		return nil, fmt.Errorf("failed to inspect folder %q: %w", absFolder, err)
	}
	if !fi.IsDir() {
		return nil, fmt.Errorf("path is not a directory: %s", absFolder)
	}

	addr := net.JoinHostPort(dialHostForConnect(opts.Host), strconv.Itoa(opts.Port))
	instances, err := server.FindInstances(opts.UserDataDir, opts.Host, opts.Port)
	if err != nil {
		if isSidecar {
			return nil, fmt.Errorf("found an Antigravity sidecar JJ View server on %s, which manages its own workspaces", addr)
		}
		return nil, fmt.Errorf("found a JJ View server on %s, but could not locate its session metadata (if it was started with --user-data-dir, pass the same --user-data-dir): %w", addr, err)
	}

	var authErr error
	for _, info := range instances {
		rpcErr := sendAddAllowedRootRPC(client, addr, absFolder, info.SessionToken)
		if rpcErr == nil {
			query := url.Values{}
			query.Set("repo", absFolder)
			query.Set("token", info.SessionToken)
			return &openFolderResult{
				Path:   absFolder,
				TabURL: fmt.Sprintf("http://%s/?%s", addr, query.Encode()),
			}, nil
		}
		if errors.Is(rpcErr, errCandidateAuth) {
			authErr = rpcErr
			continue
		}
		return nil, rpcErr
	}
	return nil, authErr
}

func runOpenCommand(args []string, stdout, stderr io.Writer) error {
	return runOpenCommandWithBrowser(args, stdout, stderr, openBrowser)
}

func runOpenCommandWithBrowser(args []string, stdout, stderr io.Writer, browserFn func(string)) error {
	fs := flag.NewFlagSet(openCommand, flag.ContinueOnError)
	fs.SetOutput(stderr)
	hostFlag := fs.String("host", "127.0.0.1", "Host address of the running JJ View server")
	portFlag := fs.Int("port", 8080, "Port of the running JJ View server")
	repoFlag := fs.String("repo", "", "Path to folder or Jujutsu repository to open")
	userDataDirFlag := fs.String("user-data-dir", "", "Path to user data directory used by the running server")
	noOpenFlag := fs.Bool("no-open", false, "Do not open a browser tab automatically")
	fs.Usage = func() {
		printUsage(fs, "jj-view "+openCommand+" [flags] [path]",
			"Open a folder in a new browser tab against an already-running JJ View server.", "")
	}

	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		return err
	}
	if *repoFlag != "" && fs.NArg() > 0 {
		return errors.New("specify either a positional path or --repo, not both")
	}
	if fs.NArg() > 1 {
		return fmt.Errorf("expected at most one folder path, got %d", fs.NArg())
	}

	targetPath := "."
	if fs.NArg() == 1 {
		targetPath = fs.Arg(0)
	} else if *repoFlag != "" {
		targetPath = *repoFlag
	}

	var absUserDataDir string
	if *userDataDirFlag != "" {
		resolved, err := filepath.Abs(*userDataDirFlag)
		if err != nil {
			return fmt.Errorf("failed to resolve user data directory: %w", err)
		}
		absUserDataDir = resolved
	}

	res, err := openFolderOnExistingServer(openOptions{
		Host:        *hostFlag,
		Port:        *portFlag,
		FolderPath:  targetPath,
		UserDataDir: absUserDataDir,
	})
	if err != nil {
		if errors.Is(err, errNoExistingServer) {
			addr := net.JoinHostPort(dialHostForConnect(*hostFlag), strconv.Itoa(*portFlag))
			return fmt.Errorf("no running JJ View server found at %s", addr)
		}
		return err
	}

	printOpenResult(stdout, res)
	if !*noOpenFlag && browserFn != nil {
		browserFn(res.TabURL)
	}
	return nil
}

func printOpenResult(w io.Writer, res *openFolderResult) {
	fmt.Fprintf(w, "\n  Opening folder in existing JJ View server: %s\n  %s\n\n", res.Path, res.TabURL)
}
