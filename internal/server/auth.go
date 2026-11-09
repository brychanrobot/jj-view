// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"crypto/subtle"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// activeAuthToken returns the token used to authenticate sidecar / web client
// requests: SidecarToken if non-empty, otherwise SessionToken.
func (s *Server) activeAuthToken() string {
	if s.cfg.SidecarToken != "" {
		return s.cfg.SidecarToken
	}
	return s.cfg.SessionToken
}

func (s *Server) authenticateRequest(r *http.Request) bool {
	var token string
	if sidecarHeader := r.Header.Get("X-Sidecar-Token"); sidecarHeader != "" {
		token = strings.TrimSpace(sidecarHeader)
	}
	if token == "" {
		authHeader := r.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bearer ") {
			token = strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		}
	}
	if token == "" {
		if qToken := r.URL.Query().Get("token"); qToken != "" {
			token = qToken
		} else if qSidecar := r.URL.Query().Get("sidecar_token"); qSidecar != "" {
			token = qSidecar
		}
	}
	if token == "" {
		if cookie, err := r.Cookie("jj_view_token"); err == nil {
			token = cookie.Value
		}
	}
	if token == "" {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.SessionToken)) == 1 {
		return true
	}
	if s.cfg.SidecarToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.SidecarToken)) == 1 {
		return true
	}
	return false
}

func (s *Server) verifyCSRF(r *http.Request) bool {
	if s.cfg.CSRFToken == "" {
		return true
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return true
	}
	csrf := r.Header.Get("X-CSRF-Token")
	if csrf == "" {
		csrf = r.Header.Get("X-Antigravity-CSRF-Token")
	}
	return subtle.ConstantTimeCompare([]byte(csrf), []byte(s.cfg.CSRFToken)) == 1
}

func (s *Server) isOriginAllowed(origin string, reqHost ...string) bool {
	if origin == "" {
		return true
	}
	if origin == "null" {
		return true
	}
	// In sidecar mode, all requests are gated by the sidecar UI token (ANTIGRAVITY_SIDECAR_UI_TOKEN).
	// Allow any origin so the sidecar works across Antigravity Web, Desktop, proxies, and tunnels.
	if s.cfg.SidecarToken != "" {
		return true
	}

	parsedOrigin, err := url.Parse(origin)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(parsedOrigin.Scheme)
	if scheme == "vscode-webview" || scheme == "antigravity-webview" || scheme == "antigravity" || scheme == "vscode-file" {
		return true
	}
	if scheme != "http" && scheme != "https" {
		return false
	}
	originHost := strings.ToLower(parsedOrigin.Hostname())
	if originHost == "localhost" || originHost == "127.0.0.1" || originHost == "::1" || originHost == strings.ToLower(s.cfg.Host) {
		return true
	}
	for _, rh := range reqHost {
		if rh != "" {
			h := rh
			if host, _, err := net.SplitHostPort(rh); err == nil {
				h = host
			}
			if strings.EqualFold(originHost, h) {
				return true
			}
		}
	}
	for _, pattern := range s.cfg.AllowedOrigins {
		if originHostMatches(originHost, pattern) {
			return true
		}
	}
	return false
}

// originHostMatches reports whether a lower-cased origin hostname matches an
// AllowedOrigins entry. "*.example.com" matches any subdomain of example.com
// (not example.com itself); any other entry must equal the hostname.
func originHostMatches(originHost, pattern string) bool {
	pattern = strings.ToLower(strings.TrimSpace(pattern))
	if pattern == "" {
		return false
	}
	if suffix, ok := strings.CutPrefix(pattern, "*."); ok {
		return strings.HasSuffix(originHost, "."+suffix)
	}
	return originHost == pattern
}

func (s *Server) applyCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if s.isOriginAllowed(origin, r.Host) {
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		} else {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Sidecar-Token, X-CSRF-Token, X-Antigravity-CSRF-Token, Cache-Control, X-Client-ID")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Access-Control-Max-Age", "86400")
	}
}
