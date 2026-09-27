// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package secret

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"unsafe"

	"github.com/brychanrobot/jj-view/internal/state"
	"golang.org/x/sys/windows"
)

func readPayload(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return trimmed, nil
	}

	// If the file is already valid JSON (e.g. from prior unencrypted version or manual edit), return it directly
	var testJSON map[string]string
	if err := json.Unmarshal(trimmed, &testJSON); err == nil {
		return trimmed, nil
	}

	// Decrypt via DPAPI CryptUnprotectData
	var inBlob windows.DataBlob
	inBlob.Size = uint32(len(raw))
	inBlob.Data = &raw[0]

	var outBlob windows.DataBlob
	if err := windows.CryptUnprotectData(&inBlob, nil, nil, 0, nil, 0, &outBlob); err != nil {
		return nil, err
	}
	defer func() {
		if outBlob.Data != nil {
			_, _ = windows.LocalFree(windows.Handle(unsafe.Pointer(outBlob.Data)))
		}
	}()

	decrypted := make([]byte, outBlob.Size)
	copy(decrypted, unsafe.Slice(outBlob.Data, outBlob.Size))
	return decrypted, nil
}

func writePayload(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	var inBlob windows.DataBlob
	if len(data) > 0 {
		inBlob.Size = uint32(len(data))
		inBlob.Data = &data[0]
	}

	var outBlob windows.DataBlob
	if err := windows.CryptProtectData(&inBlob, nil, nil, 0, nil, 0, &outBlob); err != nil {
		return err
	}
	defer func() {
		if outBlob.Data != nil {
			_, _ = windows.LocalFree(windows.Handle(unsafe.Pointer(outBlob.Data)))
		}
	}()

	encrypted := make([]byte, outBlob.Size)
	copy(encrypted, unsafe.Slice(outBlob.Data, outBlob.Size))

	return state.AtomicWriteFile(path, encrypted, 0700, 0600)
}
