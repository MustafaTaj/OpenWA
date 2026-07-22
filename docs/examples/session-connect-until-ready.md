# Connect a Session: Create → QR / Pairing Code → Ready

This guide walks through the full OpenWA session lifecycle: create a session, understand every status, start the engine, authenticate with a **QR code** or **pairing code**, and poll until the session is `ready`.

Replace placeholders:

| Placeholder | Meaning |
| ----------- | ------- |
| `BASE_URL` | Your OpenWA base URL, e.g. `http://127.0.0.1:2785` or `https://openwa.example.com` |
| `API_KEY` | Admin / OPERATOR API key (`API_MASTER_KEY` or a key from the dashboard) |
| `SESSION_ID` | UUID returned by `POST /api/sessions` |

All requests need:

```http
X-API-Key: $API_KEY
Content-Type: application/json
```

---

## Flow overview

```
[Create session]  status → created
        │
        ▼
[Start session]   status → initializing → qr_ready
        │
        ├──────────────┬──────────────────┐
        ▼              ▼                  │
   [Get QR code]  [Request pairing code]  │
        │              │                  │
        ▼              ▼                  │
   Scan in WhatsApp / enter code on phone │
        │              │                  │
        └──────┬───────┘                  │
               ▼                          │
        authenticating ───────────────────┘
               │
               ▼
            ready   ← you can send/receive messages
```

---

## Session statuses explained

Wire values are **lowercase**. Poll `GET /api/sessions/:id` (or listen to WebSocket/webhook session events) to observe transitions.

| Status | Meaning | What you should do |
| ------ | ------- | ------------------ |
| `created` | Session row exists in the database. WhatsApp engine is **not** running. | Call `POST /api/sessions/:id/start`. |
| `initializing` | Engine is starting (Chromium / Baileys socket). No QR yet, or QR not ready to fetch. | Wait a few seconds, then poll status or retry QR. |
| `qr_ready` | A QR (and optionally a pairing code) is available for linking. | Fetch QR and/or request a pairing code; scan or enter the code on the phone. |
| `authenticating` | User scanned the QR or entered the pairing code; WhatsApp is finishing the link. | Keep polling; do not restart unless it fails. |
| `ready` | Session is linked and online. `phone` / `pushName` are usually filled. | Send messages, manage chats, etc. |
| `disconnected` | Engine stopped or lost connection (manual stop, logout, network, restart). Auth data may still exist — restart often reconnects without a new QR. | Call `start` again, or create a new session if credentials were cleared. |
| `failed` | Terminal error (engine crash, reconnect exhausted, bad proxy, etc.). Check `lastError` on the session. | Inspect logs / `lastError`, fix the cause, then `start` again or recreate the session. |

### Typical happy path

```
created → initializing → qr_ready → authenticating → ready
```

### After a normal stop or server restart

```
ready → disconnected → (start) → initializing → ready
```

(If session credentials are still on disk, you often skip QR and go straight back to `ready`.)

---

## 1. Create a session

```bash
curl -X POST "$BASE_URL/api/sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-bot"
  }'
```

**Rules for `name`:** 3–50 characters; letters, numbers, and hyphens only (`^[a-zA-Z0-9-]+$`). Duplicate names return `409`.

**Example response** `201`:

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "created",
  "phone": null,
  "pushName": null,
  "connectedAt": null,
  "lastActiveAt": null,
  "createdAt": "2026-06-25T09:00:00.000Z",
  "updatedAt": "2026-06-25T09:00:00.000Z"
}
```

Save `id` as `SESSION_ID`.

> Leave `proxyUrl` unset unless you use a real reachable proxy. A bad proxy blocks WhatsApp forever — **no QR** and `start` can time out with `504`.

---

## 2. Start the session

```bash
curl -X POST "$BASE_URL/api/sessions/$SESSION_ID/start" \
  -H "X-API-Key: $API_KEY"
```

**Example response** `200`:

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "initializing",
  "phone": null,
  "pushName": null,
  "lastError": null
}
```

Status then moves to `qr_ready` (first link) or quickly to `ready` (already linked).

Poll status:

```bash
curl -s "$BASE_URL/api/sessions/$SESSION_ID" \
  -H "X-API-Key: $API_KEY" | jq '.status, .lastError'
```

Wait until status is `qr_ready` (or `ready` if already authenticated).

---

## 3a. Authenticate with QR code

Once status is `qr_ready`:

```bash
curl -s "$BASE_URL/api/sessions/$SESSION_ID/qr" \
  -H "X-API-Key: $API_KEY"
```

**Example response** `200`:

```json
{
  "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "status": "qr_ready"
}
```

`qrCode` is a PNG **data URL**. You can:

- Show it in a browser/dashboard `<img src="...">`
- Decode the base64 and save a PNG file
- Open it temporarily for manual scan

**On the phone:**

1. Open WhatsApp  
2. **Settings → Linked devices → Link a device**  
3. Scan the QR  

After scan, status becomes `authenticating`, then `ready`.

**Common errors on `/qr`:**

| Error | Cause |
| ----- | ----- |
| Session not started | Call `/start` first |
| QR not ready yet | Still `initializing` — wait and retry |
| Already authenticated | Session is already `ready` — no QR needed |

---

## 3b. Authenticate with pairing code (no camera)

Alternative to QR. Session must already be started (usually `qr_ready`).

```bash
curl -X POST "$BASE_URL/api/sessions/$SESSION_ID/pairing-code" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "628123456789"
  }'
```

`phoneNumber`: digits only, international format, **no** `+`, spaces, or dashes (6–15 digits).

| Country | Example |
| ------- | ------- |
| Indonesia | `628123456789` |
| Spain | `34612345678` |
| United States | `14155552671` |

**Example response** `201`:

```json
{
  "pairingCode": "ABCD1234",
  "status": "qr_ready"
}
```

**On the phone:**

1. WhatsApp → **Settings → Linked devices**  
2. **Link with phone number**  
3. Enter the 8-character `pairingCode`  

See also: [Session Phone-Number Pairing](./session-phone-number-pairing.md).

---

## 4. Wait until status is `ready`

Poll every 1–2 seconds:

```bash
while true; do
  STATUS=$(curl -s "$BASE_URL/api/sessions/$SESSION_ID" \
    -H "X-API-Key: $API_KEY" | jq -r '.status')
  echo "status=$STATUS"
  case "$STATUS" in
    ready) echo "Session is ready"; break ;;
    failed)
      curl -s "$BASE_URL/api/sessions/$SESSION_ID" -H "X-API-Key: $API_KEY" | jq .
      exit 1
      ;;
  esac
  sleep 2
done
```

**Ready session example:**

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "ready",
  "phone": "6281234567890",
  "pushName": "My Bot",
  "connectedAt": "2026-06-25T08:14:02.000Z",
  "lastActive": "2026-06-25T09:01:55.000Z",
  "lastError": null
}
```

You can now send messages, for example:

```bash
curl -X POST "$BASE_URL/api/sessions/$SESSION_ID/messages/send-text" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "6281234567890@c.us",
    "text": "Hello from OpenWA"
  }'
```

---

## End-to-end script (QR path)

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:2785}"
API_KEY="${API_KEY:?set API_KEY}"
NAME="${NAME:-my-bot}"

# 1. Create
SESSION_ID=$(curl -s -X POST "$BASE_URL/api/sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$NAME\"}" | jq -r '.id')
echo "Created session: $SESSION_ID"

# 2. Start
curl -s -X POST "$BASE_URL/api/sessions/$SESSION_ID/start" \
  -H "X-API-Key: $API_KEY" | jq '{id,status}'

# 3. Wait for qr_ready (or ready)
for i in $(seq 1 60); do
  STATUS=$(curl -s "$BASE_URL/api/sessions/$SESSION_ID" \
    -H "X-API-Key: $API_KEY" | jq -r '.status')
  echo "[$i] status=$STATUS"
  [[ "$STATUS" == "qr_ready" || "$STATUS" == "ready" ]] && break
  [[ "$STATUS" == "failed" ]] && exit 1
  sleep 2
done

if [[ "$STATUS" == "qr_ready" ]]; then
  # 4. Fetch QR (save PNG)
  curl -s "$BASE_URL/api/sessions/$SESSION_ID/qr" \
    -H "X-API-Key: $API_KEY" | jq -r '.qrCode' \
    | sed 's|^data:image/png;base64,||' | base64 -d > qr.png
  echo "QR saved to qr.png — scan it in WhatsApp Linked Devices"

  # 5. Wait for ready
  for i in $(seq 1 90); do
    STATUS=$(curl -s "$BASE_URL/api/sessions/$SESSION_ID" \
      -H "X-API-Key: $API_KEY" | jq -r '.status')
    echo "[$i] status=$STATUS"
    [[ "$STATUS" == "ready" ]] && break
    [[ "$STATUS" == "failed" ]] && exit 1
    sleep 2
  done
fi

curl -s "$BASE_URL/api/sessions/$SESSION_ID" -H "X-API-Key: $API_KEY" | jq .
```

---

## End-to-end script (pairing-code path)

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:2785}"
API_KEY="${API_KEY:?set API_KEY}"
NAME="${NAME:-my-bot}"
PHONE="${PHONE:?set PHONE e.g. 628123456789}"

SESSION_ID=$(curl -s -X POST "$BASE_URL/api/sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$NAME\"}" | jq -r '.id')

curl -s -X POST "$BASE_URL/api/sessions/$SESSION_ID/start" \
  -H "X-API-Key: $API_KEY" >/dev/null

# Wait until engine can issue a code
for i in $(seq 1 60); do
  STATUS=$(curl -s "$BASE_URL/api/sessions/$SESSION_ID" \
    -H "X-API-Key: $API_KEY" | jq -r '.status')
  echo "[$i] status=$STATUS"
  [[ "$STATUS" == "qr_ready" || "$STATUS" == "ready" ]] && break
  [[ "$STATUS" == "failed" ]] && exit 1
  sleep 2
done

[[ "$STATUS" == "ready" ]] && { echo "Already ready"; exit 0; }

CODE=$(curl -s -X POST "$BASE_URL/api/sessions/$SESSION_ID/pairing-code" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"phoneNumber\":\"$PHONE\"}" | jq -r '.pairingCode')
echo "Enter this code in WhatsApp → Linked devices → Link with phone number: $CODE"

for i in $(seq 1 90); do
  STATUS=$(curl -s "$BASE_URL/api/sessions/$SESSION_ID" \
    -H "X-API-Key: $API_KEY" | jq -r '.status')
  echo "[$i] status=$STATUS"
  [[ "$STATUS" == "ready" ]] && break
  [[ "$STATUS" == "failed" ]] && exit 1
  sleep 2
done

curl -s "$BASE_URL/api/sessions/$SESSION_ID" -H "X-API-Key: $API_KEY" | jq .
```

---

## Useful related endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/api/sessions` | List sessions |
| `GET` | `/api/sessions/:id` | Get status / `lastError` |
| `GET` | `/api/sessions/:id/qr` | QR PNG data URL |
| `POST` | `/api/sessions/:id/start` | Start engine |
| `POST` | `/api/sessions/:id/stop` | Stop → `disconnected` |
| `POST` | `/api/sessions/:id/pairing-code` | 8-char link code |
| `POST` | `/api/sessions/:id/force-kill` | Kill a stuck engine |
| `DELETE` | `/api/sessions/:id` | Delete session |

Interactive docs: `$BASE_URL/api/docs`  
Full reference: [API Specification](../06-api-specification.md)

---

## Troubleshooting

| Symptom | What to check |
| ------- | ------------- |
| Stuck on `initializing` | Server RAM/CPU; Chromium needs memory for `whatsapp-web.js`. Check `docker compose logs openwa-api`. |
| No QR / `504` on start | Bad `proxyUrl`, firewall, or WhatsApp unreachable from the server. |
| `/qr` → not ready | Poll until `qr_ready`; do not call QR during early `initializing`. |
| `/qr` → already authenticated | Session is already linked — use it or stop/logout to re-link. |
| Status `failed` | Read `lastError` on `GET /api/sessions/:id` and API logs. |
| Pairing code rejected | Digits only, with country code; account must already exist on WhatsApp. |
| Blank dashboard over HTTP | Use HTTPS behind a reverse proxy (CSP upgrades insecure requests). |

> Use a **dedicated** WhatsApp number for automation — never your primary personal number. OpenWA is an unofficial gateway; bans are always possible.
