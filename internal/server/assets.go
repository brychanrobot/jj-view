// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	iofs "io/fs"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"

	"github.com/brychanrobot/jj-view/web"
)

// versionedAssets are the embedded files whose contents feed the asset
// cache-buster. Any change to these files must produce a new ?v= tag;
// otherwise browsers holding an "immutable" cached copy keep serving the
// previous build's JS/CSS.
var versionedAssets = []string{
	"dist/codicons/codicon.css",
	"dist/custom-icons/jj-view-icons.css",
	"dist/app.js",
	"dist/app.css",
	"dist/preload.js",
	"preload.js",
}

var (
	cssURLRegex = regexp.MustCompile(`(?i)url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")\s]+))\s*\)`)
	fontExtensions = map[string]bool{
		".ttf":   true,
		".woff":  true,
		".woff2": true,
		".eot":   true,
		".svg":   true,
		".otf":   true,
	}
)

func rewriteCSSFontURLs(cssContent, token string) string {
	if token == "" {
		return cssContent
	}
	escapedToken := url.QueryEscape(token)
	return cssURLRegex.ReplaceAllStringFunc(cssContent, func(match string) string {
		submatches := cssURLRegex.FindStringSubmatch(match)
		if len(submatches) < 4 {
			return match
		}
		quote := ""
		rawURL := ""
		if submatches[1] != "" {
			quote = "\""
			rawURL = submatches[1]
		} else if submatches[2] != "" {
			quote = "'"
			rawURL = submatches[2]
		} else {
			rawURL = submatches[3]
		}

		trimmedURL := strings.TrimSpace(rawURL)
		if strings.HasPrefix(trimmedURL, "http://") ||
			strings.HasPrefix(trimmedURL, "https://") ||
			strings.HasPrefix(trimmedURL, "data:") ||
			strings.HasPrefix(trimmedURL, "//") {
			return match
		}

		var withoutHash, hash string
		if hashIdx := strings.Index(trimmedURL, "#"); hashIdx != -1 {
			withoutHash = trimmedURL[:hashIdx]
			hash = trimmedURL[hashIdx:]
		} else {
			withoutHash = trimmedURL
		}

		var pathPart, queryPart string
		if queryIdx := strings.Index(withoutHash, "?"); queryIdx != -1 {
			pathPart = withoutHash[:queryIdx]
			queryPart = withoutHash[queryIdx+1:]
		} else {
			pathPart = withoutHash
		}

		ext := strings.ToLower(path.Ext(pathPart))
		if !fontExtensions[ext] {
			return match
		}

		if strings.Contains(queryPart, "token=") {
			return match
		}

		var newQuery string
		if queryPart != "" {
			newQuery = pathPart + "?" + queryPart + "&token=" + escapedToken
		} else {
			newQuery = pathPart + "?token=" + escapedToken
		}

		newURL := newQuery + hash
		if quote != "" {
			return fmt.Sprintf("url(%s%s%s)", quote, newURL, quote)
		}
		return fmt.Sprintf("url(%s)", newURL)
	})
}

// computeAssetVersion returns "<version>-<hash>" where hash is derived from the
// embedded asset contents. The semver string alone is not a safe cache key:
// successive dev builds share the same version yet ship different assets.
func computeAssetVersion(version string) string {
	if version == "" {
		version = "dev"
	}
	h := sha256.New()
	for _, name := range versionedAssets {
		content, err := web.FS.ReadFile(name)
		if err != nil {
			continue
		}
		_, _ = h.Write([]byte(name))
		_, _ = h.Write(content)
	}
	return fmt.Sprintf("%s-%s", version, hex.EncodeToString(h.Sum(nil))[:12])
}

// AssetVersion returns the cache-busting tag applied to embedded asset URLs.
func (s *Server) AssetVersion() string {
	return s.assetVersion
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":  "ok",
		"version": s.cfg.Version,
		"build":   s.assetVersion,
		"repo":    s.cfg.RepoRoot,
		"sidecar": s.cfg.SidecarToken != "",
	})
}

func (s *Server) handlePreload(w http.ResponseWriter, r *http.Request) {
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	content, err := web.FS.ReadFile("dist/preload.js")
	if err != nil {
		content, err = web.FS.ReadFile("preload.js")
	}
	if err != nil {
		http.Error(w, "preload.js not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(content)
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	cleanPath := path.Clean(r.URL.Path)

	// If the path is not root or index.html, check if it's an existing static file in web.FS
	if cleanPath != "/" && cleanPath != "/index.html" && cleanPath != "." {
		trimmed := strings.TrimPrefix(cleanPath, "/")
		if file, err := web.FS.Open(trimmed); err == nil {
			stat, statErr := file.Stat()
			_ = file.Close()
			if statErr == nil && !stat.IsDir() {
				token := r.URL.Query().Get("token")
				if token == "" {
					token = s.activeAuthToken()
				}
				if strings.HasSuffix(cleanPath, ".css") && token != "" {
					cssBytes, readErr := web.FS.ReadFile(trimmed)
					if readErr == nil {
						rewritten := rewriteCSSFontURLs(string(cssBytes), token)
						if r.URL.Query().Get("v") != "" {
							w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
						} else {
							w.Header().Set("Cache-Control", "private, max-age=86400")
						}
						w.Header().Set("Content-Type", "text/css; charset=utf-8")
						_, _ = w.Write([]byte(rewritten))
						return
					}
				}

				// Versioned assets and content-hashed code-splitting chunks
				// (/dist/chunks/<name>-<hash>.js) never change in place.
				if r.URL.Query().Get("v") != "" || strings.HasPrefix(cleanPath, "/dist/chunks/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "public, max-age=86400")
				}
				s.fileServer.ServeHTTP(w, r)
				return
			}
		}
	}

	// In sidecar mode, allow loading the root UI without an explicit token so iframes
	// can load index.html and receive the session token and fresh cookie.
	// If an explicit token is provided, it must be valid.
	hasExplicitToken := r.Header.Get("X-Sidecar-Token") != "" ||
		r.Header.Get("Authorization") != "" ||
		r.URL.Query().Get("token") != "" ||
		r.URL.Query().Get("sidecar_token") != ""

	if s.cfg.SidecarToken != "" {
		if hasExplicitToken && !s.authenticateRequest(r) {
			http.Error(w, "Unauthorized: invalid session token", http.StatusUnauthorized)
			return
		}
	} else if !s.authenticateRequest(r) {
		http.Error(w, "Unauthorized: missing or invalid session token", http.StatusUnauthorized)
		return
	}

	content, err := web.FS.ReadFile("index.html")
	if err != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}

	activeToken := s.activeAuthToken()

	configPayload := map[string]any{
		"token":    activeToken,
		"port":     s.cfg.Port,
		"repoRoot": s.cfg.RepoRoot,
	}
	if s.cfg.SidecarToken != "" {
		configPayload["sidecarToken"] = s.cfg.SidecarToken
	}
	if s.cfg.CSRFToken != "" {
		configPayload["csrfToken"] = s.cfg.CSRFToken
	}
	configJSON, _ := json.Marshal(configPayload)

	versionTag := s.assetVersion
	assetQuery := "?v=" + url.QueryEscape(versionTag)
	if activeToken != "" {
		assetQuery += "&token=" + url.QueryEscape(activeToken)
	}

	importMap := map[string]map[string]string{
		"imports": make(map[string]string),
	}
	if entries, err := iofs.ReadDir(web.FS, "dist/chunks"); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".js") {
				key := "/dist/chunks/" + entry.Name()
				importMap["imports"][key] = key + assetQuery
			}
		}
	}

	var importMapScript string
	if len(importMap["imports"]) > 0 {
		if importMapBytes, err := json.Marshal(importMap); err == nil {
			importMapScript = fmt.Sprintf("<script type=\"importmap\">\n%s\n</script>\n", string(importMapBytes))
		}
	}

	injected := fmt.Sprintf("<script>window.__JJ_VIEW_CONFIG__ = %s;</script>\n%s</head>", string(configJSON), importMapScript)
	html := strings.Replace(string(content), "</head>", injected, 1)

	for _, asset := range []string{
		"/dist/codicons/codicon.css",
		"/dist/custom-icons/jj-view-icons.css",
		"/dist/app.css",
		"/dist/app.js",
		"/preload.js",
	} {
		html = strings.ReplaceAll(html, asset, asset+assetQuery)
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "jj_view_token",
		Value:    activeToken,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	_, _ = w.Write([]byte(html))
}
