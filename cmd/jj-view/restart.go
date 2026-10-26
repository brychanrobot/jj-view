// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

const (
	reloadPortEnvVar         = "JJ_VIEW_RELOAD_PORT"
	reloadSessionTokenEnvVar = "JJ_VIEW_RELOAD_SESSION_TOKEN"
)

// runningProcess is one entry from the process table.
type runningProcess struct {
	pid  int
	args []string
}

// listProcesses returns the process table via `ps`. Supported on Linux and
// macOS; other platforms return an error so the caller can skip restarts.
func listProcesses() ([]runningProcess, error) {
	if runtime.GOOS == "windows" {
		return nil, fmt.Errorf("process listing not supported on %s", runtime.GOOS)
	}
	out, err := exec.Command("ps", "-eo", "pid=,args=").Output()
	if err != nil {
		return nil, fmt.Errorf("ps failed: %w", err)
	}
	var procs []runningProcess
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		procs = append(procs, runningProcess{pid: pid, args: fields[1:]})
	}
	return procs, nil
}

// findRunningDaemons returns the pids of jj-view daemons launched from
// binaryPath. Subcommand invocations (install-antigravity-plugin) are
// excluded; anything whose first argument is a flag (--host, -host, --version)
// is treated as a daemon.
func findRunningDaemons(binaryPath string, procs []runningProcess, selfPid int) []int {
	var pids []int
	for _, p := range procs {
		if p.pid == selfPid || len(p.args) == 0 || p.args[0] != binaryPath {
			continue
		}
		if len(p.args) > 1 && !strings.HasPrefix(p.args[1], "-") {
			// A subcommand such as "install"; not a daemon.
			continue
		}
		pids = append(pids, p.pid)
	}
	return pids
}

// reloadProcess sends SIGHUP so the daemon reloads its binary in-place via
// execve without exiting or changing its PID (preserving the Antigravity
// sidecar gateway port).
func reloadProcess(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Signal(syscall.SIGHUP)
}

// resolveExecutablePath returns the absolute filesystem path of the running
// binary so SIGHUP can exec the newly installed inode at that path even after
// the original binary on disk has been replaced.
func resolveExecutablePath(arg0 string) string {
	if exe, err := os.Executable(); err == nil {
		exe = strings.TrimSuffix(exe, " (deleted)")
		if abs, err := filepath.Abs(exe); err == nil {
			return abs
		}
		return exe
	}
	if lookedUp, err := exec.LookPath(arg0); err == nil {
		if abs, err := filepath.Abs(lookedUp); err == nil {
			return abs
		}
		return lookedUp
	}
	if abs, err := filepath.Abs(arg0); err == nil {
		return abs
	}
	return arg0
}

// buildReloadEnv returns a copy of environ with the bound port and session
// token recorded for the post-exec process image.
func buildReloadEnv(environ []string, port int, sessionToken string) []string {
	prefixPort := reloadPortEnvVar + "="
	prefixToken := reloadSessionTokenEnvVar + "="
	env := make([]string, 0, len(environ)+2)
	for _, entry := range environ {
		if strings.HasPrefix(entry, prefixPort) || strings.HasPrefix(entry, prefixToken) {
			continue
		}
		env = append(env, entry)
	}
	if port > 0 {
		env = append(env, fmt.Sprintf("%s=%d", reloadPortEnvVar, port))
	}
	if sessionToken != "" {
		env = append(env, fmt.Sprintf("%s=%s", reloadSessionTokenEnvVar, sessionToken))
	}
	return env
}

// execInPlace replaces the current process image with execPath while preserving
// its PID, bound port, and session token.
func execInPlace(execPath string, args []string, environ []string, port int, sessionToken string) error {
	env := buildReloadEnv(environ, port, sessionToken)
	return syscall.Exec(execPath, args, env)
}

// restartRunningDaemons signals daemons currently running from binaryPath to
// reload in-place via SIGHUP (or be respawned by the Antigravity hub if running
// an older binary without SIGHUP handling). Without this, a rebuilt binary on
// disk is never picked up: the running daemon keeps executing the old (deleted)
// inode together with its embedded web assets.
func restartRunningDaemons(binaryPath string, procs []runningProcess, selfPid int, signalFn func(pid int) error) []int {
	pids := findRunningDaemons(binaryPath, procs, selfPid)
	var restarted []int
	for _, pid := range pids {
		if err := signalFn(pid); err != nil {
			fmt.Printf("[Install] Warning: failed to reload daemon pid %d: %v\n", pid, err)
			continue
		}
		restarted = append(restarted, pid)
	}
	return restarted
}
