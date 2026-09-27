// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package secret

import (
	"os"
	"path/filepath"

	"github.com/brychanrobot/jj-view/internal/state"
)

func readPayload(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func writePayload(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	_ = os.Chmod(dir, 0700)

	if err := state.AtomicWriteFile(path, data, 0700, 0600); err != nil {
		return err
	}
	_ = os.Chmod(path, 0600)
	return nil
}
