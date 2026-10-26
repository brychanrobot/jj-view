// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/brychanrobot/jj-view/internal/protocol"
)

// WebSocket RPC channel.
//
// /api/ws carries the same JSON-RPC 2.0 request/response frames as /api/rpc,
// multiplexed over one long-lived connection. The browser falls back to
// /api/rpc whenever the socket is not open, so this channel is an accelerator,
// not a dependency: it exists because every HTTP request through the
// corporate access proxy -> hub gateway -> daemon pays ~20ms of per-request
// overhead and bursts are serialized to 2-3 in flight by an upstream HTTP/1.1 pool.
//
// Execution is concurrent: every request frame is dispatched on its own
// goroutine, exactly like an HTTP request. Only the wire is ordered, so large
// responses are split into $/chunk frames and interleaved round-robin with
// other pending responses to keep a multi-megabyte file read from blocking a
// `jj status` queued behind it.
//
// Server->client notifications (watcher events, config changes) still travel
// over /api/events; subscriptions remain tied to the SSE client lifecycle.

const (
	// wsChunkSize is the payload size of one $/chunk frame. Responses at or
	// below this size are sent as a single ordinary JSON-RPC frame.
	wsChunkSize = 64 * 1024
	// wsWriteWait bounds a single frame write so one stalled peer cannot pin
	// the write pump forever.
	wsWriteWait = 30 * time.Second
	// wsPingMethod is answered by the channel itself, without dispatch. The
	// browser uses it as an application-level keepalive and liveness check.
	wsPingMethod   = "$/ping"
	wsCancelMethod = "$/cancelRequest"
	wsChunkMethod  = "$/chunk"
)

// wsChunkParams is the payload of a $/chunk frame. The receiver concatenates
// `data` for a given `id` in `seq` order and parses the result as one
// JSON-RPC response once `last` is set.
type wsChunkParams struct {
	ID   json.RawMessage `json:"id"`
	Seq  int             `json:"seq"`
	Last bool            `json:"last"`
	Data string          `json:"data"`
}

// wsOutStream is one response queued for transmission, pre-split into frames.
type wsOutStream struct {
	frames [][]byte
}

// frontlineSNI extracts the TLS SNI the fronting proxy saw, if it reports one.
// An absent header or field means "treat as matching".
func frontlineSNI(r *http.Request) (string, bool) {
	header := r.Header.Get("X-Google-GFE-Frontline-Info")
	for _, kv := range strings.Split(header, ",") {
		parts := strings.SplitN(strings.TrimSpace(kv), "=", 2)
		if len(parts) != 2 || parts[0] != "sni" {
			continue
		}
		return parts[1], true
	}
	return "", false
}

// wsConn is the server side of one WebSocket RPC connection.
type wsConn struct {
	s        *Server
	conn     *websocket.Conn
	clientID string

	// ctx is cancelled when the connection closes; every dispatched request
	// derives from it so in-flight work stops when the peer goes away.
	ctx    context.Context
	cancel context.CancelFunc

	// Outbound frames. streams is a round-robin queue of responses; the write
	// pump takes one frame from each in turn. wake is signalled whenever
	// streams becomes non-empty.
	outMu   sync.Mutex
	streams []*wsOutStream
	wake    chan struct{}

	// In-flight requests by normalized id, so $/cancelRequest can stop them.
	inflightMu sync.Mutex
	inflight   map[string]context.CancelFunc
}

// handleWS upgrades the request and serves JSON-RPC over the socket until the
// peer disconnects.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if !s.authenticateRequest(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Chrome may send the wss:// handshake over a coalesced HTTP/2 connection
	// whose TLS SNI belongs to a different proxied host (crbug.com/329884).
	// The access proxy does not reject that itself, so the backend must: 421
	// makes Chrome retry on a fresh connection with the right SNI.
	if sni, ok := frontlineSNI(r); ok && sni != r.Host {
		log.Printf("[WS] SNI mismatch (sni=%q host=%q) -> 421", sni, r.Host)
		w.WriteHeader(http.StatusMisdirectedRequest)
		return
	}

	upgrader := websocket.Upgrader{
		ReadBufferSize:  32 * 1024,
		WriteBufferSize: 32 * 1024,
		CheckOrigin: func(r *http.Request) bool {
			return s.isOriginAllowed(r.Header.Get("Origin"), r.Host)
		},
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade already wrote the HTTP error response.
		log.Printf("[WS] upgrade failed: %v", err)
		return
	}

	clientID := r.URL.Query().Get("clientId")
	if clientID == "" {
		clientID = r.Header.Get("X-Client-ID")
	}

	ctx, cancel := context.WithCancel(context.Background())
	c := &wsConn{
		s:        s,
		conn:     conn,
		clientID: clientID,
		ctx:      ctx,
		cancel:   cancel,
		wake:     make(chan struct{}, 1),
		inflight: make(map[string]context.CancelFunc),
	}
	c.serve()
}

// serve runs the write pump in the background and the read loop in the
// foreground. Returning closes the connection.
func (c *wsConn) serve() {
	defer c.cancel()
	defer c.conn.Close()

	c.conn.SetReadLimit(maxRPCReadLimit)
	go c.writePump()

	opened := time.Now()
	for {
		msgType, payload, err := c.conn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("[WS] read ended after %s: %v", time.Since(opened).Round(time.Millisecond), err)
			}
			return
		}
		if msgType != websocket.TextMessage {
			continue
		}
		c.handleFrame(payload)
	}
}

// handleFrame parses one inbound frame and either answers it inline (ping,
// cancel, malformed) or dispatches it on a new goroutine.
func (c *wsConn) handleFrame(payload []byte) {
	var req protocol.Request
	if err := json.Unmarshal(payload, &req); err != nil {
		c.sendResponse(protocol.NewErrorResponse(nil, protocol.CodeParseError, "parse error", nil))
		return
	}
	if req.JSONRPC != "2.0" {
		if !req.IsNotification() {
			c.sendResponse(protocol.NewErrorResponse(req.ID, protocol.CodeInvalidRequest, "invalid jsonrpc version", nil))
		}
		return
	}

	switch req.Method {
	case wsPingMethod:
		if !req.IsNotification() {
			c.sendResponse(protocol.NewSuccessResponse(req.ID, map[string]any{"t": time.Now().UnixMilli()}))
		}
		return
	case wsCancelMethod:
		c.cancelRequest(req.Params)
		return
	}

	go c.dispatchRequest(&req)
}

// dispatchRequest runs one request to completion on the calling goroutine
// and queues its response.
func (c *wsConn) dispatchRequest(req *protocol.Request) {
	ctx, cancel := context.WithCancel(c.ctx)
	defer cancel()

	key := protocol.NormalizeID(req.ID)
	if key != "" {
		c.inflightMu.Lock()
		c.inflight[key] = cancel
		c.inflightMu.Unlock()
		defer func() {
			c.inflightMu.Lock()
			delete(c.inflight, key)
			c.inflightMu.Unlock()
		}()
	}

	res, rpcErr := c.s.dispatch(ctx, c.clientID, req)
	if req.IsNotification() {
		return
	}
	if rpcErr != nil {
		c.sendResponse(protocol.NewErrorResponse(req.ID, rpcErr.Code, rpcErr.Message, rpcErr.Data))
		return
	}
	c.sendResponse(protocol.NewSuccessResponse(req.ID, res))
}

// cancelRequest handles $/cancelRequest {id}. Unknown ids are ignored: the
// request may already have completed, or it may have gone over HTTP.
func (c *wsConn) cancelRequest(params json.RawMessage) {
	var p struct {
		ID *json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.ID == nil {
		return
	}
	key := protocol.NormalizeID(p.ID)
	c.inflightMu.Lock()
	cancel := c.inflight[key]
	c.inflightMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// sendResponse serializes a response and queues it, split into $/chunk frames
// if it exceeds wsChunkSize.
func (c *wsConn) sendResponse(resp protocol.Response) {
	data, err := json.Marshal(resp)
	if err != nil {
		data, _ = json.Marshal(protocol.NewErrorResponse(resp.ID, protocol.CodeInternalError, "failed to encode response", nil))
	}
	c.enqueue(splitResponse(resp.ID, data))
}

// splitResponse returns the frames for one encoded response: the response
// itself when small, otherwise a sequence of $/chunk notifications. Chunk
// boundaries are byte offsets into the UTF-8 encoding; the receiver joins the
// bytes before decoding, so splitting mid-codepoint is harmless.
func splitResponse(id *json.RawMessage, encoded []byte) *wsOutStream {
	if len(encoded) <= wsChunkSize {
		return &wsOutStream{frames: [][]byte{encoded}}
	}
	var rawID json.RawMessage
	if id != nil {
		rawID = *id
	} else {
		rawID = json.RawMessage("null")
	}
	var frames [][]byte
	for seq, off := 0, 0; off < len(encoded); seq++ {
		end := min(off+wsChunkSize, len(encoded))
		frame, err := json.Marshal(protocol.NewNotification(wsChunkMethod, wsChunkParams{
			ID:   rawID,
			Seq:  seq,
			Last: end == len(encoded),
			Data: string(encoded[off:end]),
		}))
		if err != nil {
			// Marshalling a struct of primitives cannot fail; keep the
			// signature honest without a panic path.
			return &wsOutStream{frames: [][]byte{encoded}}
		}
		frames = append(frames, frame)
		off = end
	}
	return &wsOutStream{frames: frames}
}

func (c *wsConn) enqueue(stream *wsOutStream) {
	c.outMu.Lock()
	c.streams = append(c.streams, stream)
	c.outMu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// nextFrame pops one frame round-robin across pending streams. ok is false
// when nothing is queued.
func (c *wsConn) nextFrame() (frame []byte, ok bool) {
	c.outMu.Lock()
	defer c.outMu.Unlock()
	if len(c.streams) == 0 {
		return nil, false
	}
	stream := c.streams[0]
	frame = stream.frames[0]
	stream.frames = stream.frames[1:]
	// Rotate: exhausted streams drop out, others go to the back so a long
	// response yields to everything queued behind it after each frame.
	c.streams = c.streams[1:]
	if len(stream.frames) > 0 {
		c.streams = append(c.streams, stream)
	}
	return frame, true
}

// writePump is the single writer for the connection (gorilla permits one
// concurrent writer). It drains queued frames until the connection closes.
func (c *wsConn) writePump() {
	for {
		frame, ok := c.nextFrame()
		if !ok {
			select {
			case <-c.wake:
				continue
			case <-c.ctx.Done():
				return
			}
		}
		_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
		if err := c.conn.WriteMessage(websocket.TextMessage, frame); err != nil {
			if !strings.Contains(err.Error(), "use of closed network connection") {
				log.Printf("[WS] write failed: %v", err)
			}
			c.cancel()
			return
		}
	}
}
