# Connect a Session: Create → QR / Pairing Code → Ready

Tutorial for the full OpenWA session lifecycle: create a session, start the engine, authenticate with a **QR code** or **pairing code**, and poll until the session is `ready`.

For request/response schemas, field constraints, and HTTP status codes, see the [API Specification — Sessions](../06-api-specification.md) and interactive Swagger at `$BASE_URL/api/docs`.

Replace placeholders:

| Placeholder | Meaning |
| ----------- | ------- |
| `BASE_URL` | Your OpenWA base URL, e.g. `http://127.0.0.1:2785` or `https://openwa.example.com` |
| `API_KEY` | Admin / OPERATOR API key (`API_MASTER_KEY` or a key from the dashboard) |
| `SESSION_ID` | UUID returned by `POST /api/sessions` |

All requests need the `X-API-Key` header (and `Content-Type: application/json` on bodies).

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

**Status transitions to expect**

```
created → initializing → qr_ready → authenticating → ready
```

After a normal stop or server restart (credentials still on disk):

```
ready → disconnected → (start) → initializing → ready
```

Poll `GET /api/sessions/:id` and act on `status` / `lastError`. Full status definitions live in [§06](../06-api-specification.md) (`created | initializing | qr_ready | authenticating | ready | disconnected | failed`).

| When status is… | Do this |
| --------------- | ------- |
| `created` | Call `POST .../start` |
| `initializing` | Wait; do not fetch QR yet |
| `qr_ready` | Fetch QR and/or request a pairing code |
| `authenticating` | Keep polling; do not restart |
| `ready` | Send/receive messages |
| `disconnected` | Call `start` again (often no new QR) |
| `failed` | Check `lastError` and logs, then restart or recreate |

---

## 1. Create a session

```bash
curl -X POST "$BASE_URL/api/sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-bot"}'
```

Save the returned `id` as `SESSION_ID`.

> **Shape note:** `POST /api/sessions` returns the **raw session entity**, including `config`, `proxyUrl`, `proxyType`, and `lastActiveAt`. Later reads (`GET /api/sessions/:id`, `start`, etc.) use `SessionResponseDto`, which strips those fields and renames `lastActiveAt` → `lastActive`. Prefer `GET` when you only care about status. Full schemas: [§06](../06-api-specification.md) / `$BASE_URL/api/docs`.

> Leave `proxyUrl` unset unless you use a real reachable proxy. A bad proxy blocks WhatsApp forever — **no QR**, and `start` can time out with `504`.

---

## 2. Start the session

```bash
curl -X POST "$BASE_URL/api/sessions/$SESSION_ID/start" \
  -H "X-API-Key: $API_KEY"
```

Poll until `qr_ready` (first link) or `ready` (already linked):

```bash
curl -s "$BASE_URL/api/sessions/$SESSION_ID" \
  -H "X-API-Key: $API_KEY" | jq '{status, lastError, phone, lastActive}'
```

---

## 3a. Authenticate with QR code

Once status is `qr_ready`:

```bash
curl -s "$BASE_URL/api/sessions/$SESSION_ID/qr" \
  -H "X-API-Key: $API_KEY" | jq -r '.qrCode'
```

`qrCode` is a PNG **data URL** (`data:image/png;base64,...`). Show it in an `<img>`, decode to a file, or open it for a manual scan.

**On the phone:** WhatsApp → **Settings → Linked devices → Link a device** → scan the QR.

After scan, status moves to `authenticating`, then `ready`.

If `/qr` fails: session not started, still `initializing`, or already authenticated — see [§06 QR endpoint](../06-api-specification.md).

---

## 3b. Authenticate with pairing code (no camera)

Session must already be started (usually `qr_ready`). `phoneNumber` is digits only, international format (no `+` / spaces / dashes).

```bash
curl -X POST "$BASE_URL/api/sessions/$SESSION_ID/pairing-code" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "628123456789"}'
```

**On the phone:** WhatsApp → **Settings → Linked devices → Link with phone number** → enter the 8-character code.

More detail: [Session Phone-Number Pairing](./session-phone-number-pairing.md).

---

## 4. Wait until status is `ready`

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

Then you can send messages, for example:

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

**Reference:** [API Specification](../06-api-specification.md) · Swagger `$BASE_URL/api/docs` · [Phone-number pairing](./session-phone-number-pairing.md)
