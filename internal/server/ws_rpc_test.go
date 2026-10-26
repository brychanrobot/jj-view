// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/brychanrobot/jj-view/internal/protocol"
)

// wsFrame is the union of every frame shape the server can emit on /api/ws:
// JSON-RPC responses and $/chunk notifications.
type wsFrame struct {
	JSONRPC string             `json:"jsonrpc"`
	ID      *json.RawMessage   `json:"id"`
	Method  string             `json:"method"`
	Params  json.RawMessage    `json:"params"`
	Result  json.RawMessage    `json:"result"`
	Error   *protocol.RPCError `json:"error"`
}

func (f wsFrame) idString() string {
	return protocol.NormalizeID(f.ID)
}

func wsURL(srv *Server, withToken bool) string {
	u := fmt.Sprintf("ws://127.0.0.1:%d/api/ws?clientId=ws-test", srv.Port())
	if withToken {
		u += "&token=" + srv.SessionToken()
	}
	return u
}

func dialWS(t *testing.T, srv *Server) *websocket.Conn {
	t.Helper()
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, true), nil)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("ws dial failed (status %d): %v", status, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func sendFrame(t *testing.T, conn *websocket.Conn, id any, method string, params any) {
	t.Helper()
	msg := map[string]any{"jsonrpc": "2.0", "method": method}
	if id != nil {
		msg["id"] = id
	}
	if params != nil {
		msg["params"] = params
	}
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal frame: %v", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

func readFrame(t *testing.T, conn *websocket.Conn, timeout time.Duration) wsFrame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var f wsFrame
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("unmarshal frame %q: %v", data, err)
	}
	return f
}

func TestWSRejectsMissingToken(t *testing.T) {
	srv, _ := setupTestServer(t)
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, false), nil)
	if err == nil {
		conn.Close()
		t.Fatal("expected handshake to fail without a token")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %+v", resp)
	}
}

func TestWSReturns421OnSNIMismatch(t *testing.T) {
	srv, _ := setupTestServer(t)
	header := http.Header{}
	header.Set("X-Google-GFE-Frontline-Info", "sni=other-host.proxy.example.com,proto=h2")
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, true), header)
	if err == nil {
		conn.Close()
		t.Fatal("expected handshake to fail on SNI mismatch")
	}
	if resp == nil || resp.StatusCode != http.StatusMisdirectedRequest {
		t.Fatalf("expected 421, got %+v", resp)
	}

	// A matching SNI must not trip the check.
	header.Set("X-Google-GFE-Frontline-Info", fmt.Sprintf("sni=127.0.0.1:%d", srv.Port()))
	conn, _, err = websocket.DefaultDialer.Dial(wsURL(srv, true), header)
	if err != nil {
		t.Fatalf("expected handshake to succeed with matching SNI: %v", err)
	}
	conn.Close()
}

func TestWSAnswersPingWithoutDispatch(t *testing.T) {
	srv, _ := setupTestServer(t)
	conn := dialWS(t, srv)

	sendFrame(t, conn, "ping-1", wsPingMethod, nil)
	f := readFrame(t, conn, 2*time.Second)
	if f.idString() != "ping-1" || f.Error != nil {
		t.Fatalf("unexpected ping response: %+v", f)
	}
	var result struct {
		T int64 `json:"t"`
	}
	if err := json.Unmarshal(f.Result, &result); err != nil || result.T == 0 {
		t.Fatalf("expected {t} in ping result, got %s", f.Result)
	}
}

func TestWSMalformedFramesGetErrorResponses(t *testing.T) {
	srv, _ := setupTestServer(t)
	conn := dialWS(t, srv)

	if err := conn.WriteMessage(websocket.TextMessage, []byte("{not json")); err != nil {
		t.Fatal(err)
	}
	f := readFrame(t, conn, 2*time.Second)
	if f.Error == nil || f.Error.Code != protocol.CodeParseError {
		t.Fatalf("expected parse error, got %+v", f)
	}

	sendFrame(t, conn, 9, "system.info", nil)
	// Overwrite the version by sending a raw frame.
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"jsonrpc":"1.0","id":10,"method":"system.info"}`)); err != nil {
		t.Fatal(err)
	}
	seen := map[string]wsFrame{}
	for range 2 {
		f := readFrame(t, conn, 2*time.Second)
		seen[f.idString()] = f
	}
	if seen["9"].Error != nil {
		t.Fatalf("valid request should succeed: %+v", seen["9"])
	}
	if seen["10"].Error == nil || seen["10"].Error.Code != protocol.CodeInvalidRequest {
		t.Fatalf("expected invalid request for bad version, got %+v", seen["10"])
	}
}

func TestWSRequestsRunConcurrentlyAndCompleteOutOfOrder(t *testing.T) {
	srv, _ := setupTestServer(t)
	conn := dialWS(t, srv)

	// The exec allowlist only permits jj and git; a shell alias is the
	// simplest way to get a request that takes a known amount of time.
	sendFrame(t, conn, 1, "process.execFile", map[string]any{"file": "git", "args": []string{"-c", "alias.slow=!sleep 0.4", "slow"}})
	sendFrame(t, conn, 2, "system.info", nil)

	first := readFrame(t, conn, 3*time.Second)
	second := readFrame(t, conn, 3*time.Second)
	if first.idString() != "2" || second.idString() != "1" {
		t.Fatalf("expected fast request (2) to complete before slow (1); got %s then %s", first.idString(), second.idString())
	}
	if first.Error != nil || second.Error != nil {
		t.Fatalf("unexpected errors: %+v / %+v", first.Error, second.Error)
	}
}

func TestWSCancelRequestCancelsInFlightContext(t *testing.T) {
	c := &wsConn{wake: make(chan struct{}, 1), inflight: make(map[string]context.CancelFunc)}

	register := func(id string) context.Context {
		ctx, cancel := context.WithCancel(context.Background())
		c.inflightMu.Lock()
		c.inflight[id] = cancel
		c.inflightMu.Unlock()
		return ctx
	}
	numeric := register("7")
	str := register("abc")
	untouched := register("8")

	// Ids are matched after normalization, so 7 and "7" are the same request.
	c.handleFrame([]byte(`{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":7}}`))
	c.handleFrame([]byte(`{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":"abc"}}`))
	// Unknown ids and malformed params are ignored rather than answered.
	c.handleFrame([]byte(`{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":999}}`))
	c.handleFrame([]byte(`{"jsonrpc":"2.0","method":"$/cancelRequest","params":{}}`))

	for name, ctx := range map[string]context.Context{"numeric": numeric, "string": str} {
		select {
		case <-ctx.Done():
		default:
			t.Fatalf("%s id was not cancelled", name)
		}
	}
	if untouched.Err() != nil {
		t.Fatal("unrelated request was cancelled")
	}
	if _, ok := c.nextFrame(); ok {
		t.Fatal("cancel notifications must not produce responses")
	}
}

func TestWSDispatchRegistersAndClearsInFlightIDs(t *testing.T) {
	srv, _ := setupTestServer(t)
	conn := dialWS(t, srv)

	sendFrame(t, conn, "req-x", "system.info", nil)
	f := readFrame(t, conn, 2*time.Second)
	if f.idString() != "req-x" || f.Error != nil {
		t.Fatalf("unexpected response: %+v", f)
	}
	// A cancel for an already-completed id must be a no-op (no response, no
	// panic, connection stays usable).
	sendFrame(t, conn, nil, wsCancelMethod, map[string]any{"id": "req-x"})
	sendFrame(t, conn, "after", wsPingMethod, nil)
	f = readFrame(t, conn, 2*time.Second)
	if f.idString() != "after" {
		t.Fatalf("expected ping response after stale cancel, got %+v", f)
	}
}

func TestWSLargeResponseIsChunkedAndReassembles(t *testing.T) {
	srv, tempRepo := setupTestServer(t)
	conn := dialWS(t, srv)

	// 3 chunks of base64 payload plus the JSON envelope.
	content := bytes.Repeat([]byte("0123456789abcdef"), (2*wsChunkSize)/16+1)
	path := filepath.Join(tempRepo, "big.bin")
	writeRes := postRPC(t, srv, 1, "fs.writeFile", map[string]string{
		"path":    path,
		"content": base64.StdEncoding.EncodeToString(content),
	})
	if writeRes.Error != nil {
		t.Fatalf("fs.writeFile: %+v", writeRes.Error)
	}

	sendFrame(t, conn, "big", "fs.readFile", map[string]string{"path": path})

	var assembled strings.Builder
	chunks := 0
	for {
		f := readFrame(t, conn, 5*time.Second)
		if f.Method != wsChunkMethod {
			t.Fatalf("expected $/chunk frames for a large response, got %+v", f)
		}
		var p wsChunkParams
		if err := json.Unmarshal(f.Params, &p); err != nil {
			t.Fatalf("bad chunk params: %v", err)
		}
		if string(p.ID) != `"big"` || p.Seq != chunks {
			t.Fatalf("chunk out of sequence: id=%s seq=%d want=%d", p.ID, p.Seq, chunks)
		}
		assembled.WriteString(p.Data)
		chunks++
		if p.Last {
			break
		}
	}
	if chunks < 3 {
		t.Fatalf("expected >=3 chunks, got %d", chunks)
	}

	var resp wsFrame
	if err := json.Unmarshal([]byte(assembled.String()), &resp); err != nil {
		t.Fatalf("reassembled payload is not a JSON-RPC response: %v", err)
	}
	if resp.idString() != "big" || resp.Error != nil {
		t.Fatalf("unexpected reassembled response: %+v", resp)
	}
	var result struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatal(err)
	}
	got, err := base64.StdEncoding.DecodeString(result.Content)
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("reassembled content mismatch (err=%v, len=%d want %d)", err, len(got), len(content))
	}
}

func TestSplitResponseBoundaries(t *testing.T) {
	id := json.RawMessage(`42`)

	small := splitResponse(&id, []byte(`{"jsonrpc":"2.0","id":42,"result":1}`))
	if len(small.frames) != 1 || !bytes.HasPrefix(small.frames[0], []byte(`{"jsonrpc"`)) {
		t.Fatalf("small response must be a single plain frame: %q", small.frames)
	}

	exact := splitResponse(&id, bytes.Repeat([]byte("x"), wsChunkSize))
	if len(exact.frames) != 1 {
		t.Fatalf("response of exactly wsChunkSize must not be chunked, got %d frames", len(exact.frames))
	}

	big := splitResponse(nil, bytes.Repeat([]byte("y"), wsChunkSize*2+1))
	if len(big.frames) != 3 {
		t.Fatalf("expected 3 chunks, got %d", len(big.frames))
	}
	for i, frame := range big.frames {
		var n struct {
			Method string        `json:"method"`
			Params wsChunkParams `json:"params"`
		}
		if err := json.Unmarshal(frame, &n); err != nil {
			t.Fatal(err)
		}
		if n.Method != wsChunkMethod || n.Params.Seq != i || string(n.Params.ID) != "null" {
			t.Fatalf("chunk %d malformed: %+v", i, n)
		}
		if n.Params.Last != (i == 2) {
			t.Fatalf("chunk %d last=%v", i, n.Params.Last)
		}
		wantLen := wsChunkSize
		if i == 2 {
			wantLen = 1
		}
		if len(n.Params.Data) != wantLen {
			t.Fatalf("chunk %d has %d bytes, want %d", i, len(n.Params.Data), wantLen)
		}
	}
}

func TestNextFrameInterleavesStreamsRoundRobin(t *testing.T) {
	c := &wsConn{wake: make(chan struct{}, 1)}
	c.enqueue(&wsOutStream{frames: [][]byte{[]byte("a1"), []byte("a2"), []byte("a3")}})
	c.enqueue(&wsOutStream{frames: [][]byte{[]byte("b1")}})
	c.enqueue(&wsOutStream{frames: [][]byte{[]byte("c1"), []byte("c2")}})

	var order []string
	for {
		frame, ok := c.nextFrame()
		if !ok {
			break
		}
		order = append(order, string(frame))
	}
	want := "a1 b1 c1 a2 c2 a3"
	if got := strings.Join(order, " "); got != want {
		t.Fatalf("round-robin order = %q, want %q", got, want)
	}
}
