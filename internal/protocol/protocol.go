// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package protocol

import (
	"encoding/json"
	"fmt"
)

// Standard JSON-RPC 2.0 and custom error codes.
const (
	CodeParseError       = -32700
	CodeInvalidRequest   = -32600
	CodeMethodNotFound   = -32601
	CodeInvalidParams    = -32602
	CodeInternalError    = -32603
	CodeProcessError     = -32000
	CodeSecurityError    = -32001
	CodeRequestCancelled = -32800
)

// Request represents a JSON-RPC 2.0 request or notification.
type Request struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method"`
	Params  json.RawMessage  `json:"params,omitempty"`
}

// IsNotification returns true if the request does not have an ID.
func (r *Request) IsNotification() bool {
	return r.ID == nil
}

// Response represents a JSON-RPC 2.0 response.
type Response struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id"`
	Result  any              `json:"result"`
	Error   *RPCError        `json:"error"`
}

// MarshalJSON enforces strict JSON-RPC 2.0 response formatting:
// - "id" is always present (serialized as null if ID is nil).
// - Exactly one of "result" or "error" is output (never both).
func (r Response) MarshalJSON() ([]byte, error) {
	if r.Error != nil {
		return json.Marshal(struct {
			JSONRPC string           `json:"jsonrpc"`
			ID      *json.RawMessage `json:"id"`
			Error   *RPCError        `json:"error"`
		}{
			JSONRPC: "2.0",
			ID:      r.ID,
			Error:   r.Error,
		})
	}

	return json.Marshal(struct {
		JSONRPC string           `json:"jsonrpc"`
		ID      *json.RawMessage `json:"id"`
		Result  any              `json:"result"`
	}{
		JSONRPC: "2.0",
		ID:      r.ID,
		Result:  r.Result,
	})
}

// RPCError represents a JSON-RPC 2.0 error.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// NewSuccessResponse constructs a successful JSON-RPC 2.0 response.
func NewSuccessResponse(id *json.RawMessage, result any) Response {
	return Response{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
	}
}

// NewErrorResponse constructs an error JSON-RPC 2.0 response.
func NewErrorResponse(id *json.RawMessage, code int, message string, data any) Response {
	return Response{
		JSONRPC: "2.0",
		ID:      id,
		Error: &RPCError{
			Code:    code,
			Message: message,
			Data:    data,
		},
	}
}

// NormalizeID converts a json.RawMessage ID to a clean string representation.
func NormalizeID(raw *json.RawMessage) string {
	if raw == nil {
		return ""
	}
	var val any
	if err := json.Unmarshal(*raw, &val); err == nil {
		return fmt.Sprintf("%v", val)
	}
	return string(*raw)
}

// Notification represents a JSON-RPC 2.0 notification from server to client.
type Notification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

// NewNotification constructs a JSON-RPC 2.0 notification.
func NewNotification(method string, params any) Notification {
	return Notification{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}
}
