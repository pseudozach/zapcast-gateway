# ZapCast Gateway

Long-running Node.js WebSocket gateway for ZapCast browser viewers.

The gateway is intended to run on a VM at `gateway.zapcast.live`. It joins the same Hyperswarm topic and reads the same Hypercore feed as the ZapCast desktop viewer, then forwards init/media chunks to browser clients over WebSocket. Browser viewers do not relay chunks back into the peer-to-peer network.

## Architecture

- `zapcast.live`: Next.js frontend on Vercel
- `gateway.zapcast.live`: this Node.js WebSocket gateway on a VM
- ZapCast desktop app: broadcaster and true P2P viewer/relayer
- Browser viewer: gateway-assisted, no P2P relaying

## Run Locally

```bash
cd services/zapcast-gateway
npm install
npm run smoke
npm start
```

If this repository is checked out directly instead of under `services/`, run the commands from this directory.

## Environment

```bash
PORT=8787
ZAPCAST_MAX_CLIENTS_PER_STREAM=50
ZAPCAST_CACHE_CHUNKS=300
ZAPCAST_LOG_LEVEL=debug
ZAPCAST_GATEWAY_STORAGE=./data/corestore
ZAPCAST_CLEAR_STORAGE_ON_START=true
ZAPCAST_STORAGE_MAX_AGE_MS=86400000
ZAPCAST_STORAGE_CLEANUP_INTERVAL_MS=3600000
```

## Endpoints

- `GET /health`
- `GET /stats`
- `WS /stream?streamId=zc1...`

Gateway Corestore data is temporary. Each stream session uses a unique storage folder, per-stream storage is deleted when a stream session closes, and `ZAPCAST_CLEAR_STORAGE_ON_START=true` clears old gateway Corestore data at startup so stale video chunks are never replayed. If startup clearing is disabled, stale inactive storage folders older than `ZAPCAST_STORAGE_MAX_AGE_MS` are pruned on startup and every `ZAPCAST_STORAGE_CLEANUP_INTERVAL_MS`.

Gateway messages:

```json
{ "type": "init", "seq": 0, "mime": "video/mp4; codecs=\"avc1.42E01E,mp4a.40.2\"", "dataBase64": "..." }
```

```json
{ "type": "chunk", "seq": 123, "timestamp": 1234567890, "durationMs": 2000, "mime": "video/mp4", "dataBase64": "..." }
```

```json
{ "type": "stats", "connectedPeers": 3, "browserClients": 8, "latestSeq": 123, "gatewayLatencyMs": 300 }
```

```json
{ "type": "error", "message": "..." }
```

## VM Deployment

On Debian/Ubuntu, use the package scripts exactly as written. The gateway preloads `src/preload-sodium.cjs` so Holepunch dependencies use `sodium-javascript` instead of loading the `sodium-native` addon, which can fail on older Debian/glibc systems.

Clean deploy:

```bash
cd /root/zapcast-gateway
git pull
rm -rf node_modules package-lock.json
npm install
npm run smoke
npm start
```

Expected smoke output:

```text
gateway sodium preload ok
```

Run with pm2:

```bash
npm install --omit=dev
PORT=8787 ZAPCAST_LOG_LEVEL=info pm2 start npm --name zapcast-gateway -- start
pm2 save
```

Or run with systemd:

```ini
[Unit]
Description=ZapCast Gateway
After=network-online.target

[Service]
WorkingDirectory=/opt/zapcast-gateway
ExecStart=/usr/bin/npm start
Restart=always
Environment=PORT=8787
Environment=ZAPCAST_MAX_CLIENTS_PER_STREAM=50
Environment=ZAPCAST_CACHE_CHUNKS=300
Environment=ZAPCAST_LOG_LEVEL=info

[Install]
WantedBy=multi-user.target
```

Put nginx or Caddy in front for TLS:

```text
gateway.zapcast.live -> localhost:8787
```

Keep Vercel only for the static/Next.js frontend. Do not put WebSocket streaming in Vercel functions.

## Known Limitations

- Browser viewers do not relay.
- Browser viewing is gateway-assisted.
- Gateway bandwidth costs scale with browser viewers.
- Use the desktop app for true P2P relaying and earning.
- This is for demo and casual viewing, not production CDN scale.

## Success Test

1. Start ZapCast desktop broadcaster.
2. Announce stream via Nostr.
3. Website discovers the live stream at `/streams`.
4. Click Watch in Browser.
5. Browser connects to gateway.
6. Gateway joins the Hyperswarm topic.
7. Gateway receives Hypercore chunks.
8. Browser plays video.
