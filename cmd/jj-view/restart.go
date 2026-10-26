// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
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

// terminateProcess sends SIGTERM so the daemon can shut down gracefully.
func terminateProcess(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Signal(syscall.SIGTERM)
}

// restartRunningDaemons terminates daemons currently running from binaryPath.
// The Antigravity hub launches sidecars with restart_policy "always", so a
// terminated daemon is respawned from the freshly installed binary. Without
// this, a rebuilt binary on disk is never picked up: the running daemon keeps
// executing the old (deleted) inode together with its embedded web assets.
func restartRunningDaemons(binaryPath string, procs []runningProcess, selfPid int, terminate func(pid int) error) []int {
	pids := findRunningDaemons(binaryPath, procs, selfPid)
	var restarted []int
	for _, pid := range pids {
		if err := terminate(pid); err != nil {
			fmt.Printf("[Install] Warning: failed to stop daemon pid %d: %v\n", pid, err)
			continue
		}
		restarted = append(restarted, pid)
	}
	return restarted
}
