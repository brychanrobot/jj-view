// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
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
	reloadAllowedRootsEnvVar = "JJ_VIEW_RELOAD_ALLOWED_ROOTS"
	reloadShellEnvVar        = "JJ_VIEW_SHELL"
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

// buildReloadEnv returns a copy of environ with the bound port, session
// token, and allowed sandbox roots recorded for the post-exec process image.
func buildReloadEnv(environ []string, port int, sessionToken string, allowedRoots ...string) []string {
	prefixPort := reloadPortEnvVar + "="
	prefixToken := reloadSessionTokenEnvVar + "="
	prefixRoots := reloadAllowedRootsEnvVar + "="
	env := make([]string, 0, len(environ)+3)
	for _, entry := range environ {
		if strings.HasPrefix(entry, prefixPort) || strings.HasPrefix(entry, prefixToken) || strings.HasPrefix(entry, prefixRoots) {
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
	if len(allowedRoots) > 0 {
		env = append(env, fmt.Sprintf("%s=%s", reloadAllowedRootsEnvVar, strings.Join(allowedRoots, string(os.PathListSeparator))))
	}
	return env
}

// shellQuote wraps s in single quotes for POSIX and fish shells, escaping any
// embedded single quotes.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// buildShellExecArgs wraps execPath and args in `<shell> -lc "exec ..."` when a
// valid login shell is configured, so SIGHUP reloads re-evaluate the user's
// shell environment in-place.
func buildShellExecArgs(shell string, execPath string, args []string) (string, []string) {
	shell = strings.TrimSpace(shell)
	if runtime.GOOS != "windows" && shell != "" && filepath.IsAbs(shell) {
		if info, err := os.Stat(shell); err == nil && !info.IsDir() {
			quoted := make([]string, 0, max(1, len(args)))
			quoted = append(quoted, shellQuote(execPath))
			if len(args) > 1 {
				for _, a := range args[1:] {
					quoted = append(quoted, shellQuote(a))
				}
			}
			return shell, []string{shell, "-lc", "exec " + strings.Join(quoted, " ")}
		}
	}
	return execPath, args
}

func resolveReloadShell(environ []string) string {
	prefix := reloadShellEnvVar + "="
	isAntigravitySidecar := false
	for _, entry := range environ {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(entry, prefix))
		}
		if strings.HasPrefix(entry, "ANTIGRAVITY_SIDECAR_WEB_PORT=") {
			isAntigravitySidecar = true
		}
	}
	if !isAntigravitySidecar {
		return ""
	}
	homeDir, err := os.UserHomeDir()
	if err != nil || homeDir == "" {
		return ""
	}
	sidecarPath := filepath.Join(homeDir, ".gemini", "config", "plugins", "jj-view", "sidecars", "jj-view", "sidecar.json")
	data, err := os.ReadFile(sidecarPath)
	if err != nil {
		return ""
	}
	var manifest struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return ""
	}
	return strings.TrimSpace(manifest.Env[reloadShellEnvVar])
}

// execInPlace replaces the current process image with execPath while preserving
// its PID, bound port, session token, and allowed sandbox roots.
func execInPlace(execPath string, args []string, environ []string, port int, sessionToken string, allowedRoots ...string) error {
	env := buildReloadEnv(environ, port, sessionToken, allowedRoots...)
	shell := resolveReloadShell(env)
	if shell != "" {
		hasShellVar := false
		prefix := reloadShellEnvVar + "="
		for _, entry := range env {
			if strings.HasPrefix(entry, prefix) {
				hasShellVar = true
				break
			}
		}
		if !hasShellVar {
			env = append(env, prefix+shell)
		}
	}
	targetBin, targetArgs := buildShellExecArgs(shell, execPath, args)
	return syscall.Exec(targetBin, targetArgs, env)
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
