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
npm run diagnose:native
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
ZAPCAST_DHT_PORT=49737
ZAPCAST_SWARM_SERVER=false
```

## Endpoints

- `GET /health`
- `GET /stats`
- `WS /stream?streamId=zc1...`

Gateway Corestore data is temporary. Each stream session uses a unique storage folder, per-stream storage is deleted when a stream session closes, and `ZAPCAST_CLEAR_STORAGE_ON_START=true` clears old gateway Corestore data at startup so stale video chunks are never replayed. If startup clearing is disabled, stale inactive storage folders older than `ZAPCAST_STORAGE_MAX_AGE_MS` are pruned on startup and every `ZAPCAST_STORAGE_CLEANUP_INTERVAL_MS`.

The gateway joins Hyperswarm as a client by default. It does not announce itself as a server for the stream topic, because browser viewers do not relay and stale gateway server announcements can make other viewers dial a gateway that has no useful stream data.

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

The gateway still depends on native Linux addons from the Holepunch stack:

- `hyperswarm` loads `udx-native`
- `corestore` loads `rocksdb-native`

Installing Pear on the server is not required for this Node gateway. It does not replace these Node native addons for `npm start`.

Clean deploy:

```bash
apt-get update
apt-get install -y libatomic1
cd /root/zapcast-gateway
git pull
rm -rf node_modules package-lock.json
npm install
npm run diagnose:native
npm run smoke
npm start
```

Expected smoke output:

```text
gateway native preload ok
```

If `npm run diagnose:native` shows `libatomic.so.1 => not found`, install `libatomic1` and reinstall dependencies.

If it shows `GLIBC_2.xx not found` or `GLIBCXX_3.4.xx not found`, the OS C/C++ runtime is too old for the shipped `rocksdb-native` or `udx-native` prebuild. Move the gateway to Debian 12/bookworm, Ubuntu 22.04+, Ubuntu 24.04, or run it with the included bookworm-based Dockerfile.

Docker fallback on an older host:

```bash
cd /root/zapcast-gateway
git pull
docker build -t zapcast-gateway .
docker rm -f zapcast-gateway 2>/dev/null || true
docker run -d --name zapcast-gateway --restart unless-stopped --network host \
  -e PORT=8787 \
  -e ZAPCAST_DHT_PORT=49737 \
  -e ZAPCAST_SWARM_SERVER=false \
  -e ZAPCAST_LOG_LEVEL=info \
  zapcast-gateway
docker logs -f zapcast-gateway
```

Use host networking for Docker on Linux. Publishing `-p 8787:8787` only exposes the browser WebSocket HTTP port; Hyperswarm also needs UDP DHT and holepunch traffic. `ZAPCAST_DHT_PORT=49737` pins the gateway DHT socket to a stable UDP port so the VM firewall can allow it.

Minimum VM firewall:

```bash
ufw allow 8787/tcp
ufw allow 49737/udp
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
