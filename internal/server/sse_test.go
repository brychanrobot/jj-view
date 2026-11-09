// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/brychanrobot/jj-view/internal/protocol"
	"github.com/brychanrobot/jj-view/internal/watcher"
)

func TestSSE_ClientLifecycle(t *testing.T) {
	rec := httptest.NewRecorder()
	client := newSSEClient("test-client", rec, rec)

	// 1. send writes formatted SSE event
	notif := protocol.NewNotification("test/event", map[string]string{"foo": "bar"})
	if err := client.send(notif); err != nil {
		t.Fatalf("client.send failed: %v", err)
	}
	body := rec.Body.String()
	if !strings.HasPrefix(body, "data: {") || !strings.HasSuffix(body, "\n\n") {
		t.Fatalf("unexpected SSE format: %q", body)
	}
	if !strings.Contains(body, `"method":"test/event"`) {
		t.Fatalf("notification method missing from body: %s", body)
	}

	// 2. ping writes comment frame
	rec.Body.Reset()
	if err := client.ping(); err != nil {
		t.Fatalf("client.ping failed: %v", err)
	}
	if rec.Body.String() != ": ping\n\n" {
		t.Fatalf("expected ': ping\\n\\n', got %q", rec.Body.String())
	}

	// 3. close idempotency
	client.close()
	select {
	case <-client.done:
	default:
		t.Fatalf("expected client.done channel to be closed")
	}
	// Calling close() again must not panic
	client.close()

	// 4. write after close returns error
	if err := client.send(notif); err == nil {
		t.Fatalf("expected send after close to return error")
	}
	if err := client.ping(); err == nil {
		t.Fatalf("expected ping after close to return error")
	}
}

func TestSSE_SubscriptionsAndCleanup(t *testing.T) {
	srv := &Server{
		watcherHub: watcher.NewHub(),
		sseClients: make(map[string]*sseClient),
	}
	defer srv.watcherHub.Close()

	rec := httptest.NewRecorder()
	client := newSSEClient("client-sub", rec, rec)
	srv.sseClients["client-sub"] = client

	// 1. Track subscriptions
	srv.trackClientSubscription("client-sub", "sub-1")
	srv.trackClientSubscription("client-sub", "sub-2")

	client.subsMu.Lock()
	count := len(client.subscriptions)
	sub1 := client.subscriptions["sub-1"]
	sub2 := client.subscriptions["sub-2"]
	client.subsMu.Unlock()

	if count != 2 || !sub1 || !sub2 {
		t.Fatalf("expected 2 subscriptions, got count=%d, sub-1=%v, sub-2=%v", count, sub1, sub2)
	}

	// 2. Untrack subscription
	srv.untrackClientSubscription("client-sub", "sub-1")
	client.subsMu.Lock()
	countAfter := len(client.subscriptions)
	sub1After := client.subscriptions["sub-1"]
	client.subsMu.Unlock()

	if countAfter != 1 || sub1After {
		t.Fatalf("expected sub-1 to be untracked, count=%d", countAfter)
	}

	// 3. Cleanup releases all watches and closes client
	client.cleanup(srv)
	select {
	case <-client.done:
	default:
		t.Fatalf("expected client to be closed after cleanup")
	}
	client.subsMu.Lock()
	rem := len(client.subscriptions)
	client.subsMu.Unlock()
	if rem != 0 {
		t.Fatalf("expected subscriptions map to be emptied after cleanup, got %d", rem)
	}
}

func TestSSE_BroadcastAndNotify(t *testing.T) {
	srv := &Server{
		sseClients: make(map[string]*sseClient),
	}

	rec1 := httptest.NewRecorder()
	rec2 := httptest.NewRecorder()
	c1 := newSSEClient("client-1", rec1, rec1)
	c2 := newSSEClient("client-2", rec2, rec2)
	srv.sseClients["client-1"] = c1
	srv.sseClients["client-2"] = c2

	// 1. notifyClient targeted to client-1 only
	srv.notifyClient("client-1", "user/message", map[string]string{"text": "hello 1"})
	if !strings.Contains(rec1.Body.String(), "user/message") {
		t.Errorf("client-1 missing targeted message")
	}
	if rec2.Body.Len() > 0 {
		t.Errorf("client-2 unexpectedly received targeted message for client-1")
	}

	// 2. notifyClient with empty clientID broadcasts to all
	rec1.Body.Reset()
	rec2.Body.Reset()
	srv.notifyClient("", "broadcast/test", map[string]string{"text": "hello all"})
	if !strings.Contains(rec1.Body.String(), "broadcast/test") {
		t.Errorf("client-1 missing broadcast message")
	}
	if !strings.Contains(rec2.Body.String(), "broadcast/test") {
		t.Errorf("client-2 missing broadcast message")
	}

	// 3. broadcastNotification sends to all
	rec1.Body.Reset()
	rec2.Body.Reset()
	srv.broadcastNotification("system/alert", map[string]string{"level": "info"})
	if !strings.Contains(rec1.Body.String(), "system/alert") {
		t.Errorf("client-1 missing broadcastNotification")
	}
	if !strings.Contains(rec2.Body.String(), "system/alert") {
		t.Errorf("client-2 missing broadcastNotification")
	}
}

func TestSSE_HandleEvents(t *testing.T) {
	srv := &Server{
		cfg: Config{
			SessionToken: "test-token",
		},
		watcherHub: watcher.NewHub(),
		sseClients: make(map[string]*sseClient),
	}
	defer srv.watcherHub.Close()

	// 1. Unauthenticated request rejected
	reqUnauth := httptest.NewRequest(http.MethodGet, "/api/events", nil)
	recUnauth := httptest.NewRecorder()
	srv.handleEvents(recUnauth, reqUnauth)
	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauth /api/events, got %d", recUnauth.Code)
	}

	// 2. OPTIONS returns 204
	reqOptions := httptest.NewRequest(http.MethodOptions, "/api/events", nil)
	recOptions := httptest.NewRecorder()
	srv.handleEvents(recOptions, reqOptions)
	if recOptions.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for OPTIONS, got %d", recOptions.Code)
	}

	// 3. Streaming connection with cancellation cleanup
	ctx, cancel := context.WithCancel(context.Background())
	reqAuth := httptest.NewRequest(http.MethodGet, "/api/events?clientId=stream-test&token=test-token", nil).WithContext(ctx)
	recAuth := httptest.NewRecorder()

	doneCh := make(chan struct{})
	go func() {
		defer close(doneCh)
		srv.handleEvents(recAuth, reqAuth)
	}()

	// Wait for client to be registered in sseClients
	var clientFound bool
	for range 50 {
		srv.clientsMu.Lock()
		_, clientFound = srv.sseClients["stream-test"]
		srv.clientsMu.Unlock()
		if clientFound {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !clientFound {
		t.Fatalf("client was not registered in sseClients")
	}

	// Cancel context to trigger cleanup
	cancel()
	select {
	case <-doneCh:
	case <-time.After(2 * time.Second):
		t.Fatalf("handleEvents did not exit within timeout after context cancellation")
	}

	// Verify headers and initial system.connected event after handler completes
	if ct := recAuth.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
	if !strings.Contains(recAuth.Body.String(), "system.connected") {
		t.Errorf("missing system.connected event in SSE response")
	}

	// Client should be deregistered from sseClients
	srv.clientsMu.Lock()
	_, clientRemaining := srv.sseClients["stream-test"]
	srv.clientsMu.Unlock()
	if clientRemaining {
		t.Errorf("expected client to be removed from sseClients after disconnect")
	}
}
