import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createLogger } from './logger.js'
import { cleanupStorageRoot, clearStorageRoot, SessionRegistry } from './stream-session.js'
import { parseStreamId } from './zapcast-protocol.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 8787)
const maxClients = Number(process.env.ZAPCAST_MAX_CLIENTS_PER_STREAM || 50)
const cacheChunks = Number(process.env.ZAPCAST_CACHE_CHUNKS || 300)
const logLevel = process.env.ZAPCAST_LOG_LEVEL || 'info'
const storageRoot = process.env.ZAPCAST_GATEWAY_STORAGE || path.join(__dirname, '..', 'data', 'corestore')
const storageMaxAgeMs = Number(process.env.ZAPCAST_STORAGE_MAX_AGE_MS || 24 * 60 * 60 * 1000)
const storageCleanupIntervalMs = Number(process.env.ZAPCAST_STORAGE_CLEANUP_INTERVAL_MS || 60 * 60 * 1000)
const clearStorageOnStart = process.env.ZAPCAST_CLEAR_STORAGE_ON_START !== 'false'
const dhtPort = Number(process.env.ZAPCAST_DHT_PORT || 0) || 0
const swarmServer = process.env.ZAPCAST_SWARM_SERVER === 'true'

const logger = createLogger(logLevel)
if (clearStorageOnStart) await clearStorageRoot({ storageRoot, logger })
else await cleanupStorageRoot({ storageRoot, maxAgeMs: storageMaxAgeMs, logger })
const registry = new SessionRegistry({ storageRoot, cacheChunks, maxClients, dhtPort, swarmServer, logger })
const storageCleanupTimer = setInterval(() => {
  cleanupStorageRoot({
    storageRoot,
    maxAgeMs: storageMaxAgeMs,
    exclude: registry.activeStorageDirectories(),
    logger
  }).catch(err => logger.error('storage_cleanup_failed', { message: err.message }))
}, storageCleanupIntervalMs)

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (url.pathname === '/health') return json(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()) })
  if (url.pathname === '/stats') return json(res, 200, registry.stats())
  return json(res, 404, { error: 'not found' })
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (url.pathname !== '/stream') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }

  const rawStreamId = url.searchParams.get('streamId')
  try {
    parseStreamId(rawStreamId)
  } catch (err) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req, rawStreamId)
  })
})

wss.on('connection', async (ws, req, rawStreamId) => {
  try {
    const session = await registry.get(rawStreamId)
    session.addClient(ws)
  } catch (err) {
    logger.error('websocket_connection_error', { message: err.message })
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: err.message }))
    ws.close(1011, 'gateway error')
  }
})

server.listen(port, () => {
  logger.info('gateway_listening', { port, dhtPort: dhtPort || 'random', swarmServer, maxClients, cacheChunks, storageRoot })
})

server.on('error', err => {
  logger.error('gateway_server_error', { message: err.message, code: err.code })
  process.exitCode = 1
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    logger.info('gateway_shutdown', { signal })
    clearInterval(storageCleanupTimer)
    server.close()
    await registry.close()
    process.exit(0)
  })
}

function json (res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  })
  res.end(JSON.stringify(body))
}
