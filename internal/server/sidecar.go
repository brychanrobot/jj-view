// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
)

func (s *Server) handleSidecarProxy(w http.ResponseWriter, r *http.Request) {
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authenticateRequest(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	reqMap := make(map[string]any)
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&reqMap); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}
	}

	var args []string
	var projectID string
	cleanPath := path.Clean(r.URL.Path)
	switch cleanPath {
	case "/_sidecar/send-message":
		msg, _ := reqMap["message"].(string)
		convID, _ := reqMap["conversationId"].(string)
		title, _ := reqMap["title"].(string)
		projectID, _ = reqMap["projectId"].(string)

		args = []string{"send-message"}
		if title != "" {
			args = append(args, "--title", title)
		}
		if convID != "" {
			args = append(args, convID)
		}
		args = append(args, msg)

	case "/_sidecar/new-conversation":
		msg, _ := reqMap["message"].(string)
		model, _ := reqMap["model"].(string)
		title, _ := reqMap["title"].(string)
		projectID, _ = reqMap["projectId"].(string)

		args = []string{"new-conversation"}
		if model != "" {
			args = append(args, "--model", model)
		}
		if title != "" {
			args = append(args, "--title", title)
		}
		args = append(args, msg)

	case "/_sidecar/get-conversation-metadata":
		convID, _ := reqMap["conversationId"].(string)
		args = []string{"get-conversation-metadata"}
		if convID != "" {
			args = append(args, convID)
		}

	default:
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}

	result, err := s.runAgentAPI(r.Context(), projectID, args)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func (s *Server) runAgentAPI(ctx context.Context, projectID string, args []string) (any, error) {
	agentAPIPath, err := exec.LookPath("agentapi")
	if err != nil {
		if home, hErr := os.UserHomeDir(); hErr == nil {
			candidate := filepath.Join(home, ".gemini", "antigravity", "bin", "agentapi")
			if fi, sErr := os.Stat(candidate); sErr == nil && !fi.IsDir() {
				agentAPIPath = candidate
			}
		}
	}
	if agentAPIPath == "" {
		return nil, errors.New("agentapi binary not found in PATH or standard location")
	}

	cmd := exec.CommandContext(ctx, agentAPIPath, args...)
	cmd.Env = os.Environ()
	if projectID != "" {
		cmd.Env = append(cmd.Env, fmt.Sprintf("ANTIGRAVITY_PROJECT_ID=%s", projectID))
	}

	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("agentapi failed: %s", string(exitErr.Stderr))
		}
		return nil, fmt.Errorf("failed to execute agentapi: %w", err)
	}

	if len(out) == 0 {
		return map[string]any{}, nil
	}

	var result any
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, fmt.Errorf("failed to parse agentapi JSON output: %w", err)
	}
	return result, nil
}
