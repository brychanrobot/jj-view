// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package web

import "embed"

// FS embeds the web client assets.
//
//go:embed all:*
var FS embed.FS
