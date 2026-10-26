// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestFindRunningDaemons(t *testing.T) {
	const bin = "/home/u/code/jj-view/dist/bin/jj-view"
	procs := []runningProcess{
		{pid: 10, args: []string{bin, "--host", "127.0.0.1", "--no-open"}}, // sidecar daemon
		{pid: 11, args: []string{bin}},                                     // bare daemon (defaults)
		{pid: 12, args: []string{bin, installAntigravityPluginCommand}},    // another install run
		{pid: 13, args: []string{bin, "--version"}},                        // not a daemon in spirit, but flag-style; tolerated
		{pid: 14, args: []string{"/other/jj-view", "--host", "127.0.0.1"}}, // different binary
		{pid: 15, args: []string{"bash", "-c", bin + " --host 127.0.0.1"}}, // shell wrapper, args[0] mismatch
		{pid: 16, args: []string{bin, "-host", "127.0.0.1", "-no-open"}},   // daemon launched from a manifest written before --flags
		{pid: 99, args: []string{bin, "--host", "127.0.0.1"}},              // self
	}
	got := findRunningDaemons(bin, procs, 99)
	want := []int{10, 11, 13, 16}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("findRunningDaemons = %v, want %v", got, want)
	}
}

func TestRestartRunningDaemonsContinuesOnError(t *testing.T) {
	const bin = "/x/jj-view"
	procs := []runningProcess{
		{pid: 1, args: []string{bin, "--host", "127.0.0.1"}},
		{pid: 2, args: []string{bin, "--host", "127.0.0.1"}},
		{pid: 3, args: []string{bin, "--host", "127.0.0.1"}},
	}
	var signaled []int
	terminate := func(pid int) error {
		signaled = append(signaled, pid)
		if pid == 2 {
			return errors.New("permission denied")
		}
		return nil
	}
	restarted := restartRunningDaemons(bin, procs, 0, terminate)
	if !reflect.DeepEqual(signaled, []int{1, 2, 3}) {
		t.Fatalf("signaled = %v, want all pids", signaled)
	}
	if !reflect.DeepEqual(restarted, []int{1, 3}) {
		t.Fatalf("restarted = %v, want [1 3]", restarted)
	}
}

func TestRestartRunningDaemonsNoMatches(t *testing.T) {
	procs := []runningProcess{{pid: 1, args: []string{"/elsewhere/jj-view", "--host", "x"}}}
	called := false
	restarted := restartRunningDaemons("/x/jj-view", procs, 0, func(int) error {
		called = true
		return nil
	})
	if called || len(restarted) != 0 {
		t.Fatalf("expected no restarts, got %v (called=%v)", restarted, called)
	}
}

func TestBuildReloadEnvReplacesExistingReloadVars(t *testing.T) {
	base := []string{
		"PATH=/usr/bin",
		reloadPortEnvVar + "=1111",
		reloadSessionTokenEnvVar + "=old-token",
		"ANTIGRAVITY_SIDECAR_WEB_PORT=43523",
	}
	got := buildReloadEnv(base, 43523, "new-token")
	want := []string{
		"PATH=/usr/bin",
		"ANTIGRAVITY_SIDECAR_WEB_PORT=43523",
		reloadPortEnvVar + "=43523",
		reloadSessionTokenEnvVar + "=new-token",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buildReloadEnv = %v, want %v", got, want)
	}
}

func TestBuildShellExecArgs(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell exec wrapper is Unix-only")
	}
	bin, args := buildShellExecArgs("/bin/sh", "/path/with'quote/jj-view", []string{"jj-view", "--host", "127.0.0.1", "--no-open"})
	if bin != "/bin/sh" {
		t.Fatalf("bin = %q, want /bin/sh", bin)
	}
	wantArgs := []string{"/bin/sh", "-lc", `exec '/path/with'\''quote/jj-view' '--host' '127.0.0.1' '--no-open'`}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Fatalf("args = %v, want %v", args, wantArgs)
	}
}

func TestDaemonReloadInPlaceOnSIGHUP(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("SIGHUP in-place exec is not supported on Windows")
	}

	tempDir := t.TempDir()
	binPath := filepath.Join(tempDir, "jj-view")
	buildCmd := exec.Command("go", "build", "-o", binPath, ".")
	if out, err := buildCmd.CombinedOutput(); err != nil {
		t.Fatalf("go build failed: %v\n%s", err, string(out))
	}

	cmd := exec.Command(binPath, "--host", "127.0.0.1", "--port", "0", "--repo", tempDir, "--no-open")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Signal(syscall.SIGTERM)
			_, _ = cmd.Process.Wait()
		}
	})

	origPID := cmd.Process.Pid
	urlRe := regexp.MustCompile(`http://127\.0\.0\.1:(\d+)/\?token=([a-f0-9]+)`)
	lines := make(chan string, 16)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()

	waitForServerURL := func() (port string, token string) {
		deadline := time.After(5 * time.Second)
		for {
			select {
			case line, ok := <-lines:
				if !ok {
					t.Fatalf("daemon stdout closed before printing server URL")
				}
				if m := urlRe.FindStringSubmatch(line); m != nil {
					return m[1], m[2]
				}
			case <-deadline:
				t.Fatalf("timed out waiting for server URL")
			}
		}
	}

	port1, token1 := waitForServerURL()

	// Send SIGHUP via reloadProcess and verify the daemon reloads in-place
	// without exiting, keeping the exact same PID, port, and session token.
	if err := reloadProcess(origPID); err != nil {
		t.Fatalf("reloadProcess(%d) failed: %v", origPID, err)
	}

	port2, token2 := waitForServerURL()
	if port2 != port1 {
		t.Fatalf("port changed across SIGHUP reload: got %s, want %s", port2, port1)
	}
	if token2 != token1 {
		t.Fatalf("session token changed across SIGHUP reload: got %s, want %s", token2, token1)
	}
	if cmd.Process.Pid != origPID {
		t.Fatalf("PID changed across SIGHUP reload: got %d, want %d", cmd.Process.Pid, origPID)
	}

	// Verify the reloaded server answers authenticated requests with the preserved token.
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%s/?token=%s", port2, token2))
	if err != nil {
		t.Fatalf("GET after SIGHUP reload failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET status after SIGHUP reload = %d, want 200", resp.StatusCode)
	}
	_ = strings.TrimSpace(port2)
}

