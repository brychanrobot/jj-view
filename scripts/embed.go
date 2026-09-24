// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package scripts

import "embed"

// FS embeds the helper shell and batch scripts.
//
//go:embed batch-diff.* batch-edit.* conflict-capture.*
var FS embed.FS
