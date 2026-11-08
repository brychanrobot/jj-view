// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/brychanrobot/jj-view/internal/update"
)

func runUpdateCommand(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet(updateCommand, flag.ContinueOnError)
	fs.SetOutput(stderr)

	checkFlag := fs.Bool("check", false, "Only check if an update is available without installing")
	prereleaseFlag := fs.Bool("prerelease", false, "Include pre-release versions")
	updateURLFlag := fs.String("update-url", "", "Override the GitHub Releases API URL")
	binaryPathFlag := fs.String("binary-path", "", "Path to jj-view executable (defaults to current binary)")

	fs.Usage = func() {
		printUsage(fs, "jj-view "+updateCommand+" [flags]",
			"Check for and install JJ View updates from GitHub Releases.", "")
	}

	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		fs.Usage()
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}

	execPath := strings.TrimSpace(*binaryPathFlag)
	if execPath == "" {
		execPath = resolveExecutablePath(os.Args[0])
	} else if abs, err := filepath.Abs(execPath); err == nil {
		execPath = abs
	}

	update.CleanupStaleFiles(execPath)

	u := update.NewUpdater(update.Options{
		CurrentVersion: version,
		ReleaseAsset:   effectiveReleaseAsset(),
		ExecutablePath: execPath,
		ReleasesURL:    effectiveUpdateURL(*updateURLFlag),
	})

	if !u.CanSelfUpdate() {
		return fmt.Errorf("self-update is not available for this build (missing release asset target)")
	}

	ctx := context.Background()
	info, err := u.Check(ctx, update.CheckOptions{
		Force:      true,
		Prerelease: *prereleaseFlag,
	})
	if err != nil {
		return err
	}

	if !info.UpdateAvailable {
		fmt.Fprintf(stdout, "jj-view v%s is already up to date.\n", info.CurrentVersion)
		return nil
	}

	if *checkFlag {
		fmt.Fprintf(stdout, "Update available: v%s -> v%s\n", info.CurrentVersion, info.LatestVersion)
		if info.ReleaseURL != "" {
			fmt.Fprintf(stdout, "Release URL: %s\n", info.ReleaseURL)
		}
		return nil
	}

	fmt.Fprintf(stdout, "Updating jj-view v%s -> v%s (%s)...\n", info.CurrentVersion, info.LatestVersion, info.ReleaseAsset)
	res, err := u.Apply(ctx, update.ApplyOptions{
		Prerelease:    *prereleaseFlag,
		TriggerReload: false,
	})
	if err != nil {
		return err
	}

	fmt.Fprintf(stdout, "Successfully updated %s to v%s.\n", res.BinaryPath, res.UpdatedVersion)

	maybeRefreshAntigravityPlugin(res.BinaryPath)

	if procs, err := listProcesses(); err == nil {
		restarted := restartRunningDaemons(res.BinaryPath, procs, os.Getpid(), reloadProcess)
		if len(restarted) > 0 {
			fmt.Fprintf(stdout, "Reloaded %d running daemon(s) in-place %v.\n", len(restarted), restarted)
		}
	}

	return nil
}
