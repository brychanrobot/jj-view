// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"flag"
	"strings"
	"testing"
)

func TestPrintUsageAdvertisesDoubleDashFlags(t *testing.T) {
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	fs.String("repo", ".", "Path to repository")
	fs.Int("port", 8080, "Port")
	fs.Bool("no-open", false, "Do not open browser")
	var out bytes.Buffer
	fs.SetOutput(&out)

	printUsage(fs, "jj-view [flags]", "Serve.", "Subcommands:\n  foo  Bar.")

	got := out.String()
	for _, want := range []string{
		"Usage: jj-view [flags]",
		"  --repo string\n    \tPath to repository (default \".\")\n",
		"  --port int\n    \tPort (default 8080)\n",
		"  --no-open\n    \tDo not open browser\n",
		"Subcommands:\n  foo  Bar.",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("usage output missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "\n  -repo") {
		t.Errorf("usage output advertises single-dash flag:\n%s", got)
	}
}
