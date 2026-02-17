# Core Contract

This document acts as the source of truth for the API contract between `ag_bridge` (Core) and its clients (Pro Mobile, Extension, etc.).

## 1. API Endpoints

### HTTP

#### Public
- `GET /health`: Returns `{ ok: true, name: "ag_bridge", version: "..." }`. Status 200.
- `POST /pair/claim`: Claims a pairing code. Body: `{ "code": "123456" }`. Returns `{ "token": "..." }`.

#### Protected (Requires `x-ag-token` header)
- `GET /config`: Returns `{ ok: true, strictMode: boolean }`.
- `POST /config/strict-mode`: Body: `{ "strictMode": boolean }`.

- `GET /approvals`: Returns `{ "approvals": [ ... ] }`.
- `POST /approvals/:id/approve`: Approves a request. Returns `{ ok: true, approval: { ... } }`.
- `POST /approvals/:id/deny`: Denies a request. Returns `{ ok: true, approval: { ... } }`.

- `POST /messages/send`: Sends a message. Body: `{ "to": "agent", "text": "hello" }`.
- `GET /messages/inbox`: Params: `?to=agent&status=new`. Returns `{ ok: true, messages: [ ... ] }`.
- `POST /messages/:id/ack`: Marks message as read/done. Body: `{ "status": "read" }`.

- `POST /agent/heartbeat`: Updates agent status. Body: `{ "state": "idle", "task": "..." }`.
- `GET /agent/status`: Returns `{ ok: true, agent: { ... } }`.
- `GET /status`: Returns server health/observability stats.

### WebSocket
- **URL**: `ws://<host>:<port>/events` (Default port 8787)
- **Auth**: `?token=<token>` query parameter.
- **Events**: Server pushes events to connected clients.

## 2. Event Schema

All events follow this envelope structure:

```json
{
  "event": "event_type_string",
  "payload": { ... },
  "ts": "ISO-8601 string"
}
```

### Event Types

- `approval_requested`: Emitted when a tool requires user approval.
    - **Payload**:
        ```json
        {
          "id": "appr_...",
          "kind": "command",
          "details": { "cmd": "..." },
          "status": "pending"
        }
        ```

- `approval_decided`: Emitted when a request is handled (approved/denied).
    - **Payload**:
        ```json
        {
          "id": "appr_...",
          "status": "approved"
        }
        ```

- `message_new`: Emitted when a new message arrives.
    - **Payload**: Message Object.

- `agent_status`: Emitted when agent heartbeat updates.
    - **Payload**: Agent State Object.

- `config_changed`: Emitted when strict mode changes.
    - **Payload**: `{ "strictMode": true/false }`

## 3. Versioning

- The API uses semantic versioning.
- Breaking changes will be signaled by a major version bump in `package.json` and this document.
