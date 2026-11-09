// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSidecar_MethodAndAuthEnforcement(t *testing.T) {
	srv := &Server{
		cfg: Config{
			SessionToken: "sidecar-test-token",
		},
	}

	// 1. OPTIONS returns 204
	reqOpt := httptest.NewRequest(http.MethodOptions, "/_sidecar/send-message", nil)
	recOpt := httptest.NewRecorder()
	srv.handleSidecarProxy(recOpt, reqOpt)
	if recOpt.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS expected 204, got %d", recOpt.Code)
	}

	// 2. Non-POST returns 405
	reqGet := httptest.NewRequest(http.MethodGet, "/_sidecar/send-message", nil)
	recGet := httptest.NewRecorder()
	srv.handleSidecarProxy(recGet, reqGet)
	if recGet.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET expected 405, got %d", recGet.Code)
	}

	// 3. Unauthenticated POST returns 401
	reqUnauth := httptest.NewRequest(http.MethodPost, "/_sidecar/send-message", bytes.NewBufferString("{}"))
	recUnauth := httptest.NewRecorder()
	srv.handleSidecarProxy(recUnauth, reqUnauth)
	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("Unauthenticated POST expected 401, got %d", recUnauth.Code)
	}

	// 4. Invalid JSON body returns 400
	reqBadJSON := httptest.NewRequest(http.MethodPost, "/_sidecar/send-message", bytes.NewBufferString("not-valid-json"))
	reqBadJSON.Header.Set("Authorization", "Bearer sidecar-test-token")
	reqBadJSON.Header.Set("Content-Type", "application/json")
	recBadJSON := httptest.NewRecorder()
	srv.handleSidecarProxy(recBadJSON, reqBadJSON)
	if recBadJSON.Code != http.StatusBadRequest {
		t.Fatalf("Invalid JSON expected 400, got %d", recBadJSON.Code)
	}

	// 5. Unknown sidecar route returns 404
	reqUnknown := httptest.NewRequest(http.MethodPost, "/_sidecar/unknown-route", bytes.NewBufferString("{}"))
	reqUnknown.Header.Set("Authorization", "Bearer sidecar-test-token")
	reqUnknown.Header.Set("Content-Type", "application/json")
	recUnknown := httptest.NewRecorder()
	srv.handleSidecarProxy(recUnknown, reqUnknown)
	if recUnknown.Code != http.StatusNotFound {
		t.Fatalf("Unknown route expected 404, got %d", recUnknown.Code)
	}
}

func TestSidecar_UnconfiguredBinaryHandling(t *testing.T) {
	// Restrict PATH to an empty directory so agentapi cannot be found
	tempEmptyDir := t.TempDir()
	t.Setenv("PATH", tempEmptyDir)
	t.Setenv("HOME", tempEmptyDir)        // ensure ~/.gemini lookup also fails on Unix
	t.Setenv("USERPROFILE", tempEmptyDir) // ensure %USERPROFILE%\.gemini lookup also fails on Windows

	srv := &Server{
		cfg: Config{
			SessionToken: "sidecar-test-token",
		},
	}

	bodyBytes, _ := json.Marshal(map[string]any{
		"message": "hello",
	})
	req := httptest.NewRequest(http.MethodPost, "/_sidecar/send-message", bytes.NewReader(bodyBytes))
	req.Header.Set("Authorization", "Bearer sidecar-test-token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	srv.handleSidecarProxy(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 when agentapi is unconfigured, got %d", rec.Code)
	}

	var errResp map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &errResp); err != nil {
		t.Fatalf("failed to decode error JSON: %v", err)
	}
	if errResp["error"] == "" {
		t.Fatalf("expected error message in response body, got %v", errResp)
	}
}

func TestSidecar_ProxyRoundTrip(t *testing.T) {
	// Compile a real cross-platform mock "agentapi" executable (.exe on Windows).
	binDir := t.TempDir()
	srcDir := t.TempDir()
	mockSrc := filepath.Join(srcDir, "main.go")
	goSource := `package main

import "fmt"

func main() {
	fmt.Println("{\"status\":\"ok\",\"delivered\":true}")
}
`
	if err := os.WriteFile(mockSrc, []byte(goSource), 0644); err != nil {
		t.Fatalf("failed to write mock agentapi source: %v", err)
	}
	binName := "agentapi"
	if runtime.GOOS == "windows" {
		binName = "agentapi.exe"
	}
	mockBin := filepath.Join(binDir, binName)
	if out, err := exec.Command("go", "build", "-o", mockBin, mockSrc).CombinedOutput(); err != nil {
		t.Fatalf("failed to compile mock agentapi (%v): %s", err, string(out))
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	srv := &Server{
		cfg: Config{
			SessionToken: "valid-sidecar-token",
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/_sidecar/", srv.handleSidecarProxy)
	ts := httptest.NewServer(mux)
	defer ts.Close()

	client := ts.Client()

	routes := []struct {
		endpoint string
		payload  map[string]any
	}{
		{
			endpoint: "/_sidecar/send-message",
			payload: map[string]any{
				"message":        "ping",
				"conversationId": "conv-1",
				"title":          "Test Title",
				"projectId":      "proj-1",
			},
		},
		{
			endpoint: "/_sidecar/new-conversation",
			payload: map[string]any{
				"message":   "start conversation",
				"model":     "test-model",
				"title":     "New Conv",
				"projectId": "proj-2",
			},
		},
		{
			endpoint: "/_sidecar/get-conversation-metadata",
			payload: map[string]any{
				"conversationId": "conv-2",
			},
		},
	}

	for _, route := range routes {
		t.Run(route.endpoint, func(t *testing.T) {
			jsonBytes, err := json.Marshal(route.payload)
			if err != nil {
				t.Fatalf("marshal error: %v", err)
			}
			req, err := http.NewRequest(http.MethodPost, ts.URL+route.endpoint, bytes.NewReader(jsonBytes))
			if err != nil {
				t.Fatalf("NewRequest error: %v", err)
			}
			req.Header.Set("Authorization", "Bearer valid-sidecar-token")
			req.Header.Set("Content-Type", "application/json")

			resp, err := client.Do(req)
			if err != nil {
				t.Fatalf("client.Do error: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				t.Fatalf("expected 200 OK from %s, got %d", route.endpoint, resp.StatusCode)
			}

			var result map[string]any
			if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
				t.Fatalf("failed to decode response JSON: %v", err)
			}
			if result["status"] != "ok" || result["delivered"] != true {
				t.Fatalf("unexpected mock agentapi response: %v", result)
			}
		})
	}
}
