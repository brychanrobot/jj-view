// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/brychanrobot/jj-view/web"
)

func TestAssets_ComputeAssetVersion(t *testing.T) {
	// 1. Dev default when version is empty
	devVer := computeAssetVersion("")
	if !strings.HasPrefix(devVer, "dev-") {
		t.Fatalf("expected prefix 'dev-', got %q", devVer)
	}
	parts := strings.Split(devVer, "-")
	if len(parts) != 2 || len(parts[1]) != 12 {
		t.Fatalf("expected version-12hex, got %q", devVer)
	}

	// 2. Specified semver string
	v1 := computeAssetVersion("1.2.3")
	if !strings.HasPrefix(v1, "1.2.3-") {
		t.Fatalf("expected prefix '1.2.3-', got %q", v1)
	}

	// 3. AssetVersion method returns the cached assetVersion field
	srv := &Server{assetVersion: "custom-build-tag"}
	if srv.AssetVersion() != "custom-build-tag" {
		t.Fatalf("AssetVersion() = %q, want custom-build-tag", srv.AssetVersion())
	}
}

func TestAssets_RewriteCSSFontURLs(t *testing.T) {
	token := "token_secret_123"

	// 1. Empty token leaves content untouched
	origCSS := `@font-face { src: url("codicon.ttf"); }`
	if got := rewriteCSSFontURLs(origCSS, ""); got != origCSS {
		t.Fatalf("expected unchanged CSS when token is empty, got %q", got)
	}

	// 2. Font URLs with and without existing query string
	tests := []struct {
		name     string
		input    string
		contains string
	}{
		{
			name:     "Double quotes without query",
			input:    `@font-face { src: url("codicon.ttf"); }`,
			contains: `url("codicon.ttf?token=` + token + `")`,
		},
		{
			name:     "Single quotes with query",
			input:    `@font-face { src: url('codicon.woff2?v=1.2.3'); }`,
			contains: `url('codicon.woff2?v=1.2.3&token=` + token + `')`,
		},
		{
			name:     "Unquoted URL with hash",
			input:    `@font-face { src: url(font.eot#iefix); }`,
			contains: `url(font.eot?token=` + token + `#iefix)`,
		},
		{
			name:     "URL with query and hash",
			input:    `@font-face { src: url('font.eot?t=123#iefix'); }`,
			contains: `url('font.eot?t=123&token=` + token + `#iefix')`,
		},
		{
			name:     "URL already containing token query param is not modified",
			input:    `@font-face { src: url('codicon.ttf?token=existing'); }`,
			contains: `url('codicon.ttf?token=existing')`,
		},
		{
			name:     "External absolute URL ignored",
			input:    `@font-face { src: url("https://cdn.example.com/font.woff2"); }`,
			contains: `url("https://cdn.example.com/font.woff2")`,
		},
		{
			name:     "Data URL ignored",
			input:    `@font-face { src: url(data:font/woff2;base64,d09GMgABAAAA); }`,
			contains: `url(data:font/woff2;base64,d09GMgABAAAA)`,
		},
		{
			name:     "Non-font asset ignored",
			input:    `.icon { background-image: url('image.png'); }`,
			contains: `url('image.png')`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := rewriteCSSFontURLs(tc.input, token)
			if !strings.Contains(got, tc.contains) {
				t.Fatalf("rewriteCSSFontURLs output missing %q; got: %s", tc.contains, got)
			}
		})
	}
}

func TestAssets_HandleHealth(t *testing.T) {
	srv := &Server{
		cfg: Config{
			Version:      "v0.9.0",
			RepoRoot:     "/workspace/test",
			SidecarToken: "sidecar-xyz",
		},
		assetVersion: "v0.9.0-abcdef123456",
	}

	// 1. OPTIONS request returns 204 No Content
	reqOptions := httptest.NewRequest(http.MethodOptions, "/api/health", nil)
	recOptions := httptest.NewRecorder()
	srv.handleHealth(recOptions, reqOptions)
	if recOptions.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS /api/health expected 204, got %d", recOptions.Code)
	}

	// 2. GET request returns JSON health payload
	reqGet := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	recGet := httptest.NewRecorder()
	srv.handleHealth(recGet, reqGet)
	if recGet.Code != http.StatusOK {
		t.Fatalf("GET /api/health expected 200, got %d", recGet.Code)
	}

	var body map[string]any
	if err := json.Unmarshal(recGet.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to parse health JSON: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("status = %v, want ok", body["status"])
	}
	if body["version"] != "v0.9.0" {
		t.Errorf("version = %v, want v0.9.0", body["version"])
	}
	if body["build"] != "v0.9.0-abcdef123456" {
		t.Errorf("build = %v, want v0.9.0-abcdef123456", body["build"])
	}
	if body["repo"] != "/workspace/test" {
		t.Errorf("repo = %v, want /workspace/test", body["repo"])
	}
	if body["sidecar"] != true {
		t.Errorf("sidecar = %v, want true", body["sidecar"])
	}
}

func TestAssets_HandlePreload(t *testing.T) {
	srv := &Server{}

	// 1. OPTIONS request returns 204
	reqOptions := httptest.NewRequest(http.MethodOptions, "/preload.js", nil)
	recOptions := httptest.NewRecorder()
	srv.handlePreload(recOptions, reqOptions)
	if recOptions.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS /preload.js expected 204, got %d", recOptions.Code)
	}

	// 2. GET request serves preload.js with JS content-type and cache-control
	reqGet := httptest.NewRequest(http.MethodGet, "/preload.js", nil)
	recGet := httptest.NewRecorder()
	srv.handlePreload(recGet, reqGet)
	if recGet.Code != http.StatusOK {
		t.Fatalf("GET /preload.js expected 200, got %d", recGet.Code)
	}
	if ct := recGet.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/javascript") {
		t.Errorf("expected Content-Type application/javascript, got %q", ct)
	}
	if cc := recGet.Header().Get("Cache-Control"); !strings.Contains(cc, "max-age=86400") {
		t.Errorf("expected Cache-Control public, max-age=86400, got %q", cc)
	}
	if recGet.Body.Len() == 0 {
		t.Errorf("expected non-empty body for /preload.js")
	}
}

func TestAssets_HandleIndex(t *testing.T) {
	srv := &Server{
		cfg: Config{
			SessionToken: "session-secret",
			Port:         8080,
			RepoRoot:     "/my/repo",
		},
		assetVersion: "v1.0.0-hash12345678",
		fileServer:   http.FileServer(http.FS(web.FS)),
	}

	// 1. OPTIONS request returns 204
	reqOptions := httptest.NewRequest(http.MethodOptions, "/", nil)
	recOptions := httptest.NewRecorder()
	srv.handleIndex(recOptions, reqOptions)
	if recOptions.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS / expected 204, got %d", recOptions.Code)
	}

	// 2. Unauthenticated GET / is rejected with 401
	reqUnauth := httptest.NewRequest(http.MethodGet, "/", nil)
	recUnauth := httptest.NewRecorder()
	srv.handleIndex(recUnauth, reqUnauth)
	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET / expected 401, got %d", recUnauth.Code)
	}

	// 3. Sidecar mode allows unauthenticated root UI load
	srvSidecar := &Server{
		cfg: Config{
			SessionToken: "session-secret",
			SidecarToken: "sidecar-secret",
			Port:         8080,
			RepoRoot:     "/my/repo",
		},
		assetVersion: "v1.0.0-hash12345678",
		fileServer:   http.FileServer(http.FS(web.FS)),
	}
	reqSidecarUnauth := httptest.NewRequest(http.MethodGet, "/", nil)
	recSidecarUnauth := httptest.NewRecorder()
	srvSidecar.handleIndex(recSidecarUnauth, reqSidecarUnauth)
	if recSidecarUnauth.Code != http.StatusOK {
		t.Fatalf("sidecar GET / without explicit token expected 200, got %d", recSidecarUnauth.Code)
	}

	// 4. Authenticated GET / injects config, cookie, and asset queries
	authURL := "/?token=session-secret"
	reqAuth := httptest.NewRequest(http.MethodGet, authURL, nil)
	recAuth := httptest.NewRecorder()
	srv.handleIndex(recAuth, reqAuth)
	if recAuth.Code != http.StatusOK {
		t.Fatalf("authenticated GET / expected 200, got %d", recAuth.Code)
	}

	bodyStr := recAuth.Body.String()
	if !strings.Contains(bodyStr, "window.__JJ_VIEW_CONFIG__") {
		t.Errorf("missing injected __JJ_VIEW_CONFIG__ in index.html")
	}
	if !strings.Contains(bodyStr, `"session-secret"`) {
		t.Errorf("missing session token in injected config")
	}
	expectedAssetQuery := "?v=" + url.QueryEscape(srv.assetVersion) + "&token=session-secret"
	if !strings.Contains(bodyStr, expectedAssetQuery) {
		t.Errorf("missing assetQuery %q in index.html", expectedAssetQuery)
	}

	// Cookie verification
	cookies := recAuth.Result().Cookies()
	var foundCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == "jj_view_token" {
			foundCookie = c
			break
		}
	}
	if foundCookie == nil || foundCookie.Value != "session-secret" {
		t.Fatalf("expected jj_view_token cookie with value session-secret, got %v", foundCookie)
	}

	// 5. Static CSS file rewritten with font URLs
	cssReq := httptest.NewRequest(http.MethodGet, "/dist/codicons/codicon.css?token=session-secret", nil)
	cssRec := httptest.NewRecorder()
	srv.handleIndex(cssRec, cssReq)
	if cssRec.Code != http.StatusOK {
		t.Fatalf("GET /dist/codicons/codicon.css expected 200, got %d", cssRec.Code)
	}
	if !strings.Contains(cssRec.Body.String(), "token=session-secret") {
		t.Errorf("codicon.css missing font token query: %s", cssRec.Body.String())
	}
}
