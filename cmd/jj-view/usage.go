// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

// printUsage writes help for fs to stderr with every flag spelled `--name`.
// The standard library accepts both `-name` and `--name`; its default usage
// only advertises the single-dash form, which is not the one we document.
// footer is optional extra text printed after the flag list.
func printUsage(fs *flag.FlagSet, usageLine, summary, footer string) {
	w := fs.Output()
	if w == nil {
		w = os.Stderr
	}
	fmt.Fprintf(w, "Usage: %s\n\n%s\n\nFlags:\n", usageLine, summary)
	fs.VisitAll(func(f *flag.Flag) {
		name, usage := flag.UnquoteUsage(f)
		line := "  --" + f.Name
		if name != "" {
			line += " " + name
		}
		fmt.Fprintf(w, "%s\n    \t%s", line, strings.ReplaceAll(usage, "\n", "\n    \t"))
		if f.DefValue != "" && f.DefValue != "false" {
			if name == "string" {
				fmt.Fprintf(w, " (default %q)", f.DefValue)
			} else {
				fmt.Fprintf(w, " (default %s)", f.DefValue)
			}
		}
		fmt.Fprintln(w)
	})
	if footer != "" {
		fmt.Fprintf(w, "\n%s\n", footer)
	}
}
