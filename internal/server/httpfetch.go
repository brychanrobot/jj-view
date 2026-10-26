// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/brychanrobot/jj-view/internal/gitcred"
	"github.com/brychanrobot/jj-view/internal/protocol"
)

const (
	httpFetchDefaultTimeout = 15 * time.Second
	httpFetchMaxTimeout     = 2 * time.Minute
	httpFetchMaxBody        = 32 * 1024 * 1024
	httpFetchMaxRedirects   = 10
)

// httpFetchAuth selects how the daemon authenticates an outbound request.
// Exactly one kind applies:
//   - "git":    credentials git would use for the URL (git-remote-sso,
//     gitcookies, credential helper), scoped by GitDir.
//   - "secret": Bearer token read from the daemon secret store under Key.
//   - "bearer": Bearer token supplied by the caller.
type httpFetchAuth struct {
	Kind   string `json:"kind"`
	GitDir string `json:"gitDir,omitempty"`
	Key    string `json:"key,omitempty"`
	Token  string `json:"token,omitempty"`
}

type httpFetchParams struct {
	URL       string            `json:"url"`
	Method    string            `json:"method,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	Body      *string           `json:"body,omitempty"`
	Auth      *httpFetchAuth    `json:"auth,omitempty"`
	TimeoutMs int               `json:"timeoutMs,omitempty"`
}

type httpFetchResult struct {
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
}

// requestHeaderBlocklist lists caller headers that are never forwarded: the
// transport owns them or they would let the page smuggle credentials.
var requestHeaderBlocklist = map[string]bool{
	"host":              true,
	"cookie":            true,
	"content-length":    true,
	"connection":        true,
	"transfer-encoding": true,
	"keep-alive":        true,
	"upgrade":           true,
}

// responseHeaderBlocklist lists upstream headers not relayed to the page.
var responseHeaderBlocklist = map[string]bool{
	"set-cookie":        true,
	"set-cookie2":       true,
	"connection":        true,
	"transfer-encoding": true,
	"keep-alive":        true,
	"content-length":    true,
	"content-encoding":  true,
}

// validateFetchURL enforces the outbound URL policy: HTTPS anywhere, plain
// HTTP only to loopback (local test servers and self-hosted dev instances).
func validateFetchURL(target *url.URL) error {
	if ip := net.ParseIP(target.Hostname()); ip != nil && ip.IsLinkLocalUnicast() {
		return fmt.Errorf("http.fetch refuses link-local address %q", target.Hostname())
	}
	switch target.Scheme {
	case "https":
		return nil
	case "http":
		if gitcred.IsLoopbackHost(target.Hostname()) {
			return nil
		}
		return fmt.Errorf("plain http is only allowed for loopback hosts, got %s", target.Host)
	default:
		return fmt.Errorf("unsupported URL scheme %q", target.Scheme)
	}
}

func (s *Server) httpClient() *http.Client {
	return &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= httpFetchMaxRedirects {
				return fmt.Errorf("stopped after %d redirects", httpFetchMaxRedirects)
			}
			if len(via) > 0 && req.URL.Host != via[0].URL.Host {
				req.Header.Del("Authorization")
				req.Header.Del("Cookie")
			}
			return validateFetchURL(req.URL)
		},
	}
}

// applyFetchAuth attaches the credential selected by auth. When a git
// credential was attached it returns a function that drops it from the cache,
// for the caller to invoke on 401/403.
func (s *Server) applyFetchAuth(ctx context.Context, req *http.Request, auth *httpFetchAuth) (func(), *protocol.RPCError) {
	if auth == nil {
		return nil, nil
	}
	switch auth.Kind {
	case "git":
		gitDir, rpcErr := s.validateGitDir(auth.GitDir)
		if rpcErr != nil {
			return nil, rpcErr
		}
		cred, err := s.gitCreds.Resolve(ctx, req.URL, gitDir)
		if err != nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
		}
		if cred == nil {
			return nil, nil
		}
		req.Header.Set(cred.HeaderName, cred.HeaderValue)
		target := req.URL
		return func() { s.gitCreds.Invalidate(target, gitDir) }, nil
	case "secret":
		if auth.Key == "" {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: "auth.key is required for secret auth"}
		}
		if s.secretStore == nil {
			return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: "secret store unavailable"}
		}
		token, ok := s.secretStore.Get(auth.Key)
		if !ok || token == "" {
			return nil, nil
		}
		req.Header.Set("Authorization", "Bearer "+token)
		return nil, nil
	case "bearer":
		if auth.Token == "" {
			return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: "auth.token is required for bearer auth"}
		}
		req.Header.Set("Authorization", "Bearer "+auth.Token)
		return nil, nil
	default:
		return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: fmt.Sprintf("unknown auth kind %q", auth.Kind)}
	}
}

// validateGitDir confines git-scoped credential lookups to repositories the
// daemon already serves.
func (s *Server) validateGitDir(gitDir string) (string, *protocol.RPCError) {
	if gitDir == "" {
		return "", nil
	}
	validated, err := s.fsMgr.ValidatePath(gitDir)
	if err != nil {
		return "", &protocol.RPCError{Code: protocol.CodeSecurityError, Message: err.Error()}
	}
	return validated, nil
}

// httpFetch performs an outbound HTTP request on behalf of the web UI. The
// page never sees the credential: it only names how to authenticate.
func (s *Server) httpFetch(ctx context.Context, params httpFetchParams) (*httpFetchResult, *protocol.RPCError) {
	target, err := url.Parse(params.URL)
	if err != nil || target.Hostname() == "" {
		return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: "url must be absolute"}
	}
	if err := validateFetchURL(target); err != nil {
		return nil, &protocol.RPCError{Code: protocol.CodeSecurityError, Message: err.Error()}
	}

	timeout := httpFetchDefaultTimeout
	if params.TimeoutMs > 0 {
		timeout = time.Duration(params.TimeoutMs) * time.Millisecond
	}
	if timeout > httpFetchMaxTimeout {
		timeout = httpFetchMaxTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	method := strings.ToUpper(strings.TrimSpace(params.Method))
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader
	if params.Body != nil {
		body = strings.NewReader(*params.Body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: err.Error()}
	}
	for name, value := range params.Headers {
		if requestHeaderBlocklist[strings.ToLower(name)] {
			continue
		}
		req.Header.Set(name, value)
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "jj-view/"+s.cfg.Version)
	}

	invalidateGitCred, rpcErr := s.applyFetchAuth(ctx, req, params.Auth)
	if rpcErr != nil {
		return nil, rpcErr
	}

	resp, err := s.httpClient().Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, &protocol.RPCError{Code: protocol.CodeRequestCancelled, Message: "request cancelled"}
		}
		return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: fmt.Sprintf("fetch %s failed: %v", target.Redacted(), err)}
	}
	defer resp.Body.Close()

	if invalidateGitCred != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
		invalidateGitCred()
	}

	data, err := io.ReadAll(io.LimitReader(resp.Body, httpFetchMaxBody+1))
	if err != nil {
		return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: fmt.Sprintf("reading response from %s failed: %v", target.Redacted(), err)}
	}
	if len(data) > httpFetchMaxBody {
		return nil, &protocol.RPCError{Code: protocol.CodeInternalError, Message: fmt.Sprintf("response from %s exceeds %d bytes", target.Redacted(), httpFetchMaxBody)}
	}

	headers := make(map[string]string, len(resp.Header))
	for name, values := range resp.Header {
		if responseHeaderBlocklist[strings.ToLower(name)] {
			continue
		}
		headers[name] = strings.Join(values, ", ")
	}
	statusText := strings.TrimSpace(strings.TrimPrefix(resp.Status, fmt.Sprintf("%d", resp.StatusCode)))
	return &httpFetchResult{
		Status:     resp.StatusCode,
		StatusText: statusText,
		Headers:    headers,
		Body:       string(data),
	}, nil
}

// httpHasGitCredentials reports whether a git-authenticated fetch to url
// would carry a credential, without revealing it.
func (s *Server) httpHasGitCredentials(ctx context.Context, rawURL, gitDir string) (bool, *protocol.RPCError) {
	target, err := url.Parse(rawURL)
	if err != nil || target.Hostname() == "" {
		return false, &protocol.RPCError{Code: protocol.CodeInvalidParams, Message: "url must be absolute"}
	}
	validatedGitDir, rpcErr := s.validateGitDir(gitDir)
	if rpcErr != nil {
		return false, rpcErr
	}
	cred, err := s.gitCreds.Resolve(ctx, target, validatedGitDir)
	if err != nil {
		return false, &protocol.RPCError{Code: protocol.CodeInternalError, Message: err.Error()}
	}
	return cred != nil, nil
}
