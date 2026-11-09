// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuth_ActiveAuthToken(t *testing.T) {
	// 1. Session token only
	srvSession := &Server{
		cfg: Config{
			SessionToken: "session-secret-123",
		},
	}
	if tok := srvSession.activeAuthToken(); tok != "session-secret-123" {
		t.Fatalf("expected session token, got %q", tok)
	}

	// 2. Sidecar token takes precedence
	srvSidecar := &Server{
		cfg: Config{
			SessionToken: "session-secret-123",
			SidecarToken: "sidecar-secret-456",
		},
	}
	if tok := srvSidecar.activeAuthToken(); tok != "sidecar-secret-456" {
		t.Fatalf("expected sidecar token, got %q", tok)
	}
}

func TestAuth_AuthenticateRequest(t *testing.T) {
	srv := &Server{
		cfg: Config{
			SessionToken: "session-token-xyz",
			SidecarToken: "sidecar-token-abc",
		},
	}

	tests := []struct {
		name    string
		req     *http.Request
		allowed bool
	}{
		{
			name: "X-Sidecar-Token header matching sidecar token",
			req: func() *http.Request {
				r := httptest.NewRequest(http.MethodGet, "/", nil)
				r.Header.Set("X-Sidecar-Token", "sidecar-token-abc")
				return r
			}(),
			allowed: true,
		},
		{
			name: "X-Sidecar-Token header matching session token",
			req: func() *http.Request {
				r := httptest.NewRequest(http.MethodGet, "/", nil)
				r.Header.Set("X-Sidecar-Token", "session-token-xyz")
				return r
			}(),
			allowed: true,
		},
		{
			name: "Authorization Bearer header matching session token",
			req: func() *http.Request {
				r := httptest.NewRequest(http.MethodGet, "/", nil)
				r.Header.Set("Authorization", "Bearer session-token-xyz")
				return r
			}(),
			allowed: true,
		},
		{
			name: "Authorization Bearer header matching sidecar token",
			req: func() *http.Request {
				r := httptest.NewRequest(http.MethodGet, "/", nil)
				r.Header.Set("Authorization", "Bearer sidecar-token-abc")
				return r
			}(),
			allowed: true,
		},
		{
			name: "URL query param token",
			req:  httptest.NewRequest(http.MethodGet, "/?token=session-token-xyz", nil),
			allowed: true,
		},
		{
			name: "URL query param sidecar_token",
			req:  httptest.NewRequest(http.MethodGet, "/?sidecar_token=sidecar-token-abc", nil),
			allowed: true,
		},
		{
			name: "Cookie jj_view_token matching session token",
			req: func() *http.Request {
				r := httptest.NewRequest(http.MethodGet, "/", nil)
				r.AddCookie(&http.Cookie{Name: "jj_view_token", Value: "session-token-xyz"})
				return r
			}(),
			allowed: true,
		},
		{
			name: "Cookie jj_view_token matching sidecar token",
			req: func() *http.Request {
				r := httptest.NewRequest(http.MethodGet, "/", nil)
				r.AddCookie(&http.Cookie{Name: "jj_view_token", Value: "sidecar-token-abc"})
				return r
			}(),
			allowed: true,
		},
		{
			name: "Invalid token header",
			req: func() *http.Request {
				r := httptest.NewRequest(http.MethodGet, "/", nil)
				r.Header.Set("Authorization", "Bearer wrong-token")
				return r
			}(),
			allowed: false,
		},
		{
			name:    "Missing token entirely",
			req:     httptest.NewRequest(http.MethodGet, "/", nil),
			allowed: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := srv.authenticateRequest(tc.req)
			if got != tc.allowed {
				t.Fatalf("authenticateRequest() = %v, want %v", got, tc.allowed)
			}
		})
	}
}

func TestAuth_VerifyCSRF(t *testing.T) {
	// Server with no CSRF token configured allows everything
	srvNoCSRF := &Server{cfg: Config{CSRFToken: ""}}
	reqPost := httptest.NewRequest(http.MethodPost, "/api/rpc", nil)
	if !srvNoCSRF.verifyCSRF(reqPost) {
		t.Fatalf("expected verifyCSRF to return true when CSRFToken is not configured")
	}

	// Server with CSRF token configured
	srvCSRF := &Server{cfg: Config{CSRFToken: "csrf-secret-999"}}

	// Safe methods bypass CSRF check
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodOptions} {
		reqSafe := httptest.NewRequest(method, "/api/rpc", nil)
		if !srvCSRF.verifyCSRF(reqSafe) {
			t.Fatalf("expected method %s to bypass CSRF check", method)
		}
	}

	// Unsafe methods require valid header
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		// Valid X-CSRF-Token
		reqValid := httptest.NewRequest(method, "/api/rpc", nil)
		reqValid.Header.Set("X-CSRF-Token", "csrf-secret-999")
		if !srvCSRF.verifyCSRF(reqValid) {
			t.Fatalf("expected valid X-CSRF-Token to pass for %s", method)
		}

		// Valid X-Antigravity-CSRF-Token
		reqValidAntigravity := httptest.NewRequest(method, "/api/rpc", nil)
		reqValidAntigravity.Header.Set("X-Antigravity-CSRF-Token", "csrf-secret-999")
		if !srvCSRF.verifyCSRF(reqValidAntigravity) {
			t.Fatalf("expected valid X-Antigravity-CSRF-Token to pass for %s", method)
		}

		// Invalid token
		reqInvalid := httptest.NewRequest(method, "/api/rpc", nil)
		reqInvalid.Header.Set("X-CSRF-Token", "wrong-csrf")
		if srvCSRF.verifyCSRF(reqInvalid) {
			t.Fatalf("expected wrong CSRF token to be rejected for %s", method)
		}

		// Missing token
		reqMissing := httptest.NewRequest(method, "/api/rpc", nil)
		if srvCSRF.verifyCSRF(reqMissing) {
			t.Fatalf("expected missing CSRF token to be rejected for %s", method)
		}
	}
}

func TestAuth_OriginHostMatches(t *testing.T) {
	tests := []struct {
		originHost string
		pattern    string
		want       bool
	}{
		{"example.com", "example.com", true},
		{"example.com", "EXAMPLE.COM", true},
		{"sub.example.com", "*.example.com", true},
		{"deep.nested.sub.example.com", "*.example.com", true},
		{"example.com", "*.example.com", false}, // *.example.com must not match example.com itself
		{"badexample.com", "*.example.com", false},
		{"other.org", "example.com", false},
		{"localhost", "", false},
		{"", "example.com", false},
	}

	for _, tc := range tests {
		got := originHostMatches(tc.originHost, tc.pattern)
		if got != tc.want {
			t.Errorf("originHostMatches(%q, %q) = %v, want %v", tc.originHost, tc.pattern, got, tc.want)
		}
	}
}

func TestAuth_IsOriginAllowed(t *testing.T) {
	srv := &Server{
		cfg: Config{
			Host:           "custom.local",
			AllowedOrigins: []string{"*.sub.domain.org", "trusted.site.com"},
		},
	}

	// 1. Empty and "null" origin
	if !srv.isOriginAllowed("") {
		t.Errorf("empty origin should be allowed")
	}
	if !srv.isOriginAllowed("null") {
		t.Errorf("null origin should be allowed")
	}

	// 2. Sidecar mode allows any origin
	srvSidecar := &Server{cfg: Config{SidecarToken: "token-active"}}
	if !srvSidecar.isOriginAllowed("https://random-untrusted.com") {
		t.Errorf("sidecar mode should allow any origin")
	}

	// 3. Webview schemes allowed
	for _, scheme := range []string{"vscode-webview://guid", "antigravity-webview://guid", "antigravity://guid", "vscode-file://vscode-app"} {
		if !srv.isOriginAllowed(scheme) {
			t.Errorf("expected scheme %s to be allowed", scheme)
		}
	}

	// 4. Disallowed scheme (e.g. ftp)
	if srv.isOriginAllowed("ftp://localhost") {
		t.Errorf("ftp scheme should not be allowed")
	}

	// 5. Loopback & Host origins
	for _, origin := range []string{
		"http://localhost",
		"http://localhost:3000",
		"http://127.0.0.1:8080",
		"http://[::1]:9090",
		"http://custom.local:4000",
	} {
		if !srv.isOriginAllowed(origin) {
			t.Errorf("expected loopback/host origin %s to be allowed", origin)
		}
	}

	// 6. reqHost match
	if !srv.isOriginAllowed("http://proxy.internal:8080", "proxy.internal:8080") {
		t.Errorf("expected reqHost match to be allowed")
	}
	if !srv.isOriginAllowed("http://proxy.internal", "proxy.internal:8080") {
		t.Errorf("expected reqHost host-only match to be allowed")
	}

	// 7. AllowedOrigins match
	if !srv.isOriginAllowed("https://a.sub.domain.org") {
		t.Errorf("expected wildcard match in AllowedOrigins to be allowed")
	}
	if !srv.isOriginAllowed("https://trusted.site.com") {
		t.Errorf("expected exact match in AllowedOrigins to be allowed")
	}

	// 8. Disallowed origin
	if srv.isOriginAllowed("https://malicious.attacker.com") {
		t.Errorf("untrusted origin should not be allowed")
	}

	// 9. Malformed origin
	if srv.isOriginAllowed("://bad-url") {
		t.Errorf("malformed origin should return false")
	}
}

func TestAuth_ApplyCORS(t *testing.T) {
	srv := &Server{
		cfg: Config{
			AllowedOrigins: []string{"trusted.com"},
		},
	}

	// 1. Allowed origin with Origin header
	w1 := httptest.NewRecorder()
	r1 := httptest.NewRequest(http.MethodGet, "/api/rpc", nil)
	r1.Header.Set("Origin", "https://trusted.com")
	srv.applyCORS(w1, r1)

	if got := w1.Header().Get("Access-Control-Allow-Origin"); got != "https://trusted.com" {
		t.Errorf("Access-Control-Allow-Origin = %q, want https://trusted.com", got)
	}
	if got := w1.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Errorf("Access-Control-Allow-Credentials = %q, want true", got)
	}
	if got := w1.Header().Get("Access-Control-Allow-Private-Network"); got != "true" {
		t.Errorf("Access-Control-Allow-Private-Network = %q, want true", got)
	}

	// 2. Allowed origin without Origin header (local request)
	w2 := httptest.NewRecorder()
	r2 := httptest.NewRequest(http.MethodGet, "/api/rpc", nil)
	srv.applyCORS(w2, r2)
	if got := w2.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
	if got := w2.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Errorf("Access-Control-Allow-Credentials should not be set when origin is wildcard")
	}

	// 3. Disallowed origin
	w3 := httptest.NewRecorder()
	r3 := httptest.NewRequest(http.MethodGet, "/api/rpc", nil)
	r3.Header.Set("Origin", "https://evil.com")
	srv.applyCORS(w3, r3)
	if got := w3.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Access-Control-Allow-Origin should not be set for disallowed origin, got %q", got)
	}
}
