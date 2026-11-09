// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/brychanrobot/jj-view/internal/protocol"
)

type sseClient struct {
	id            string
	w             http.ResponseWriter
	flusher       http.Flusher
	writeMu       sync.Mutex
	subsMu        sync.Mutex
	subscriptions map[string]bool
	done          chan struct{}
	closed        bool
}

func newSSEClient(id string, w http.ResponseWriter, flusher http.Flusher) *sseClient {
	return &sseClient{
		id:            id,
		w:             w,
		flusher:       flusher,
		subscriptions: make(map[string]bool),
		done:          make(chan struct{}),
	}
}

func (c *sseClient) send(notification any) error {
	data, err := json.Marshal(notification)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return errors.New("client closed")
	}
	_, err = fmt.Fprintf(c.w, "data: %s\n\n", data)
	if err != nil {
		return err
	}
	c.flusher.Flush()
	return nil
}

func (c *sseClient) ping() error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return errors.New("client closed")
	}
	_, err := fmt.Fprintf(c.w, ": ping\n\n")
	if err != nil {
		return err
	}
	c.flusher.Flush()
	return nil
}

func (c *sseClient) close() {
	c.writeMu.Lock()
	if !c.closed {
		c.closed = true
		close(c.done)
	}
	c.writeMu.Unlock()
}

func (c *sseClient) cleanup(s *Server) {
	c.close()
	c.subsMu.Lock()
	subs := make([]string, 0, len(c.subscriptions))
	for subID := range c.subscriptions {
		subs = append(subs, subID)
	}
	c.subscriptions = make(map[string]bool)
	c.subsMu.Unlock()

	for _, subID := range subs {
		s.watcherHub.Unwatch(subID)
	}
}

func (s *Server) broadcastNotification(method string, params any) {
	s.clientsMu.Lock()
	clients := make([]*sseClient, 0, len(s.sseClients))
	for _, client := range s.sseClients {
		clients = append(clients, client)
	}
	s.clientsMu.Unlock()

	notification := protocol.NewNotification(method, params)
	for _, client := range clients {
		_ = client.send(notification)
	}
}

func (s *Server) notifyClient(clientID string, method string, params any) {
	if clientID == "" {
		s.broadcastNotification(method, params)
		return
	}
	s.clientsMu.Lock()
	client := s.sseClients[clientID]
	s.clientsMu.Unlock()
	if client != nil {
		_ = client.send(protocol.NewNotification(method, params))
	}
}

func (s *Server) trackClientSubscription(clientID, subID string) {
	if clientID == "" {
		return
	}
	s.clientsMu.Lock()
	client := s.sseClients[clientID]
	s.clientsMu.Unlock()
	if client != nil {
		client.subsMu.Lock()
		client.subscriptions[subID] = true
		client.subsMu.Unlock()
	}
}

func (s *Server) untrackClientSubscription(clientID, subID string) {
	if clientID == "" {
		return
	}
	s.clientsMu.Lock()
	client := s.sseClients[clientID]
	s.clientsMu.Unlock()
	if client != nil {
		client.subsMu.Lock()
		delete(client.subscriptions, subID)
		client.subsMu.Unlock()
	}
}

func (s *Server) broadcastConfigChange(key string, scope string) {
	s.broadcastNotification("config/didChange", map[string]any{
		"key":   key,
		"scope": scope,
	})
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if !s.authenticateRequest(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	origin := r.Header.Get("Origin")
	if origin != "" && !s.isOriginAllowed(origin, r.Host) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

	clientID := r.URL.Query().Get("clientId")
	if clientID == "" {
		clientID = r.Header.Get("X-Client-ID")
	}
	if clientID == "" {
		tokenBytes := make([]byte, 16)
		_, _ = rand.Read(tokenBytes)
		clientID = hex.EncodeToString(tokenBytes)
	}

	client := newSSEClient(clientID, w, flusher)

	s.clientsMu.Lock()
	s.sseClients[clientID] = client
	s.clientsMu.Unlock()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// Send initial connected event
	_ = client.send(protocol.NewNotification("system.connected", map[string]any{
		"clientId": clientID,
	}))

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	defer func() {
		s.clientsMu.Lock()
		delete(s.sseClients, clientID)
		s.clientsMu.Unlock()

		client.cleanup(s)
	}()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-client.done:
			return
		case <-ticker.C:
			if err := client.ping(); err != nil {
				return
			}
		}
	}
}
