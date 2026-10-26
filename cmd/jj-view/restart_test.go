// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"reflect"
	"testing"
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
