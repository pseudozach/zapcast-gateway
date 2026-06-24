import { EventEmitter } from 'node:events'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { WebSocket } from 'ws'
import { decodeRecord, deriveTopic, inspectMp4, parseStreamId, recordToMessage } from './zapcast-protocol.js'

const LIVE_BACKFILL_CHUNKS = 60

export class StreamSession extends EventEmitter {
  constructor ({ streamId, storageRoot, cacheChunks, maxClients, dhtPort, swarmServer, logger }) {
    super()
    const parsed = parseStreamId(streamId)
    this.streamId = parsed.streamId
    this.publicKeyHex = parsed.publicKeyHex
    this.feedKeyHex = parsed.feedKeyHex
    this.topic = deriveTopic(this.publicKeyHex)
    this.storageRoot = storageRoot
    this.cacheChunks = cacheChunks
    this.maxClients = maxClients
    this.dhtPort = dhtPort
    this.swarmServer = swarmServer
    this.logger = logger
    this.clients = new Set()
    this.cache = new Map()
    this.initRecord = null
    this.latestSeq = 0
    this.latestReceivedAt = 0
    this.started = false
    this.closed = false
    this.errors = 0
    this.lastWarmStart = null
    this.store = null
    this.core = null
    this.swarm = null
    this.reader = null
    this.statsTimer = null
    this.downloadRange = null
    this.storageDirectory = null
  }

  async start () {
    if (this.started) return this
    this.started = true

    this.storageDirectory = path.join(
      this.storageRoot,
      `${safePathSegment(this.feedKeyHex)}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    )
    await mkdir(this.storageDirectory, { recursive: true })
    this.store = new Corestore(this.storageDirectory)
    await this.store.ready()
    this.core = this.store.get({ key: b4a.from(this.feedKeyHex, 'hex'), valueEncoding: 'json' })
    await this.core.ready()

    this.swarm = new Hyperswarm({ keyPair: crypto.keyPair(), port: this.dhtPort || 0 })
    this.swarm.on('connection', (socket, info = {}) => this.handlePeer(socket, info))
    this.swarm.on('error', err => this.logError('swarm_error', err))
    this.swarm.on('ban', (peerInfo, err) => {
      this.logger.warn('peer_connection_failed', {
        streamId: this.streamId,
        targetPeerId: peerInfo?.publicKey ? b4a.toString(peerInfo.publicKey, 'hex') : '',
        attempts: peerInfo?.attempts || 0,
        topics: peerInfo?.topics?.length || 0,
        code: err?.code || '',
        message: err?.message || 'peer connection failed'
      })
    })
    this.swarm.on('update', () => {
      this.logger.debug('swarm_update', {
        streamId: this.streamId,
        peers: this.connectedPeers(),
        connecting: this.swarm.connecting,
        clientAttempts: this.swarm.stats?.connects?.client?.attempted || 0,
        clientOpened: this.swarm.stats?.connects?.client?.opened || 0,
        serverOpened: this.swarm.stats?.connects?.server?.opened || 0,
        bannedPeers: this.swarm.stats?.bannedPeers || 0,
        knownPeers: this.swarm.peers?.size || 0
      })
    })

    const discovery = this.swarm.join(this.topic, { client: true, server: this.swarmServer })
    await discovery.flushed()
    this.logger.info('stream_joined', {
      streamId: this.streamId,
      feedKey: this.feedKeyHex.slice(0, 12),
      topic: b4a.toString(this.topic, 'hex'),
      gatewayPeer: b4a.toString(this.swarm.keyPair.publicKey, 'hex'),
      dhtPort: this.dhtPort || 'random',
      swarmClient: true,
      swarmServer: this.swarmServer,
      storageDirectory: this.storageDirectory
    })

    this.reader = this.readLive().catch(err => this.logError('reader_failed', err))
    this.downloadRange = this.core.download({ start: 0, end: -1, linear: true })
    this.statsTimer = setInterval(() => this.broadcastStats(), 3000)
    return this
  }

  addClient (ws) {
    if (this.clients.size >= this.maxClients) {
      sendJson(ws, { type: 'error', message: 'Too many browser viewers for this stream.' })
      ws.close(1013, 'stream client limit reached')
      return false
    }
    this.clients.add(ws)
    this.logger.info('browser_connected', { streamId: this.streamId, browserClients: this.clients.size })
    ws.once('close', () => {
      this.clients.delete(ws)
      this.logger.info('browser_disconnected', { streamId: this.streamId, browserClients: this.clients.size })
      this.emit('client-close')
    })
    ws.on('error', err => this.logError('browser_socket_error', err))
    this.sendWarmStart(ws)
    this.sendStats(ws)
    return true
  }

  async readLive () {
    await this.core.update({ wait: true }).catch(() => this.core.update())
    const tailStart = Math.max(0, this.core.length - this.cacheChunks)
    const latestInitBlock = await this.findLatestInitBlock(tailStart, this.core.length)
    const start = latestInitBlock >= tailStart ? latestInitBlock : tailStart
    this.logger.info('feed_reader_started', {
      streamId: this.streamId,
      start,
      length: this.core.length,
      tailStart,
      latestInitBlock
    })

    if (latestInitBlock < tailStart && start > 0) {
      try {
        this.handleRecord(decodeRecord(await this.core.get(0, { wait: true, timeout: 10_000 })))
      } catch (err) {
        this.logError('init_segment_read_error', err)
      }
    }

    for await (const encoded of this.core.createReadStream({ start, live: true })) {
      if (this.closed) break
      try {
        this.handleRecord(decodeRecord(encoded))
      } catch (err) {
        this.logError('record_decode_error', err)
      }
    }
  }

  async findLatestInitBlock (start, end) {
    let latest = -1
    for (let index = start; index < end; index++) {
      try {
        const record = decodeRecord(await this.core.get(index, { wait: true, timeout: 5000 }))
        if (record.type === 'init') latest = index
      } catch (err) {
        this.logger.warn('tail_scan_record_failed', {
          streamId: this.streamId,
          index,
          message: err.message
        })
      }
    }
    return latest
  }

  handleRecord (record) {
    if (record.type === 'init') {
      const isReset = Boolean(this.initRecord)
      this.initRecord = record
      if (isReset) {
        this.cache.clear()
        this.latestSeq = 0
        this.lastWarmStart = null
        this.logger.info('stream_reset_detected', {
          streamId: this.streamId,
          bytes: record.byteLength,
          message: 'received a new init segment inside an existing feed'
        })
        this.broadcast({ type: 'reset', reason: 'new-init-segment' })
      }
      const inspection = inspectMp4(record.data)
      this.logger.info('init_segment_received', {
        streamId: this.streamId,
        seq: record.seq,
        bytes: record.byteLength,
        mime: record.mime,
        ...inspection
      })
      if (!hasVideoMarker(inspection.markers)) {
        this.logger.warn('init_segment_audio_only', {
          streamId: this.streamId,
          seq: record.seq,
          bytes: record.byteLength,
          mime: record.mime,
          markers: inspection.markers
        })
      }
    } else {
      if (!this.initRecord) {
        this.logger.warn('chunk_before_init_ignored', {
          streamId: this.streamId,
          seq: record.seq,
          bytes: record.byteLength,
          message: 'Hypercore feed is invalid: media chunk arrived before init segment'
        })
        this.broadcast({
          type: 'error',
          message: 'Invalid ZapCast stream: gateway received media chunks before the init segment. Restart the broadcaster with the updated desktop app and create a new stream.'
        })
        return
      }
      this.cache.set(record.seq, record)
      this.latestSeq = Math.max(this.latestSeq, record.seq)
      this.latestReceivedAt = record.receivedAt
      this.trimCache()
    }

    this.logger.debug('chunk_received', {
      streamId: this.streamId,
      type: record.type,
      seq: record.seq,
      bytes: record.byteLength,
      clients: this.clients.size,
      peers: this.connectedPeers()
    })
    this.broadcast(recordToMessage(record))
  }

  sendWarmStart (ws) {
    if (this.initRecord) sendJson(ws, recordToMessage(this.initRecord))
    const records = [...this.cache.values()]
      .sort((a, b) => a.seq - b.seq)
      .slice(-Math.min(LIVE_BACKFILL_CHUNKS, this.cacheChunks))
    this.lastWarmStart = {
      initBytes: this.initRecord?.byteLength || 0,
      chunks: records.length,
      startSeq: records[0]?.seq || 0,
      endSeq: records[records.length - 1]?.seq || 0
    }
    this.logger.info('browser_warm_start', {
      streamId: this.streamId,
      ...this.lastWarmStart,
      latestSeq: this.latestSeq
    })
    for (const record of records) sendJson(ws, recordToMessage(record))
  }

  handlePeer (socket, info = {}) {
    const peerId = info.publicKey ? b4a.toString(info.publicKey, 'hex') : ''
    this.logger.info('peer_connected', {
      streamId: this.streamId,
      peerId,
      initiator: socket.isInitiator === true,
      topics: info.topics?.length || 0
    })
    socket.once('close', () => {
      this.logger.info('peer_disconnected', { streamId: this.streamId, peerId, peers: this.connectedPeers() })
    })
    socket.on('error', err => this.logError('peer_socket_error', err, { peerId }))
    const replication = this.store.replicate(socket)
    replication?.on?.('error', err => this.logError('replication_error', err, { peerId }))
  }

  trimCache () {
    while (this.cache.size > this.cacheChunks) {
      const oldest = Math.min(...this.cache.keys())
      this.cache.delete(oldest)
    }
  }

  broadcast (message) {
    const payload = JSON.stringify(message)
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload)
    }
  }

  broadcastStats () {
    this.broadcast(this.stats())
  }

  sendStats (ws) {
    sendJson(ws, this.stats())
  }

  stats () {
    return {
      type: 'stats',
      connectedPeers: this.connectedPeers(),
      browserClients: this.clients.size,
      latestSeq: this.latestSeq,
      gatewayLatencyMs: this.latestReceivedAt ? Date.now() - this.latestReceivedAt : 0,
      knownPeers: this.swarm?.peers?.size || 0,
      connectingPeers: this.swarm?.connecting || 0,
      connectionAttempts: this.swarm?.stats?.connects?.client?.attempted || 0,
      bannedPeers: this.swarm?.stats?.bannedPeers || 0,
      warmStart: this.lastWarmStart
    }
  }

  activeStorageDirectories () {
    return new Set([...this.sessions.values()].map(session => session.storageDirectory).filter(Boolean))
  }

  snapshot () {
    return {
      streamId: this.streamId,
      connectedPeers: this.connectedPeers(),
      knownPeers: this.swarm?.peers?.size || 0,
      connectionAttempts: this.swarm?.stats?.connects?.client?.attempted || 0,
      bannedPeers: this.swarm?.stats?.bannedPeers || 0,
      browserClients: this.clients.size,
      latestSeq: this.latestSeq,
      cacheStartSeq: this.cache.size ? Math.min(...this.cache.keys()) : 0,
      cacheEndSeq: this.cache.size ? Math.max(...this.cache.keys()) : 0,
      hasInit: Boolean(this.initRecord),
      errors: this.errors,
      topic: b4a.toString(this.topic, 'hex')
    }
  }

  connectedPeers () {
    return this.swarm?.connections?.size || 0
  }

  logError (event, err, fields = {}) {
    this.errors += 1
    this.logger.error(event, { streamId: this.streamId, message: err.message, ...fields })
    this.broadcast({ type: 'error', message: err.message })
  }

  async close () {
    if (this.closed) return
    this.closed = true
    clearInterval(this.statsTimer)
    this.downloadRange?.destroy?.()
    for (const ws of this.clients) ws.close(1001, 'stream session closing')
    await this.swarm?.destroy().catch(err => this.logError('swarm_close_error', err))
    await this.store?.close().catch(err => this.logError('store_close_error', err))
    await rm(this.storageDirectory, { recursive: true, force: true }).catch(err => this.logError('storage_cleanup_error', err))
    this.logger.info('stream_closed', { streamId: this.streamId })
  }
}

function hasVideoMarker (markers = []) {
  return markers.some(marker => ['avc1', 'avc3', 'hvc1', 'hev1', 'vp09'].includes(marker))
}

export class SessionRegistry {
  constructor ({ storageRoot, cacheChunks, maxClients, dhtPort, swarmServer, logger }) {
    this.storageRoot = storageRoot
    this.cacheChunks = cacheChunks
    this.maxClients = maxClients
    this.dhtPort = dhtPort
    this.swarmServer = swarmServer
    this.logger = logger
    this.sessions = new Map()
    this.cleanupTimers = new Map()
  }

  async get (streamId) {
    const parsed = parseStreamId(streamId)
    const existing = this.sessions.get(parsed.streamId)
    if (existing) {
      clearTimeout(this.cleanupTimers.get(parsed.streamId))
      this.cleanupTimers.delete(parsed.streamId)
      return existing
    }

    const session = new StreamSession({
      streamId: parsed.streamId,
      storageRoot: this.storageRoot,
      cacheChunks: this.cacheChunks,
      maxClients: this.maxClients,
      dhtPort: this.dhtPort,
      swarmServer: this.swarmServer,
      logger: this.logger
    })
    session.on('client-close', () => this.scheduleCleanup(session))
    this.sessions.set(parsed.streamId, session)
    await session.start()
    return session
  }

  scheduleCleanup (session) {
    if (session.clients.size > 0 || this.cleanupTimers.has(session.streamId)) return
    const timer = setTimeout(async () => {
      if (session.clients.size > 0) return
      this.sessions.delete(session.streamId)
      this.cleanupTimers.delete(session.streamId)
      await session.close()
    }, 60_000)
    this.cleanupTimers.set(session.streamId, timer)
  }

  stats () {
    return {
      streams: this.sessions.size,
      sessions: [...this.sessions.values()].map(session => session.snapshot())
    }
  }

  async close () {
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer)
    await Promise.all([...this.sessions.values()].map(session => session.close()))
  }
}

export async function cleanupStorageRoot ({ storageRoot, maxAgeMs = 24 * 60 * 60 * 1000, exclude = new Set(), logger }) {
  await mkdir(storageRoot, { recursive: true })
  const entries = await readdir(storageRoot, { withFileTypes: true }).catch(() => [])
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = path.join(storageRoot, entry.name)
    if (exclude.has(directory)) continue
    const info = await stat(directory).catch(() => null)
    if (!info || now - info.mtimeMs < maxAgeMs) continue
    await rm(directory, { recursive: true, force: true })
    logger?.info('storage_pruned', { directory })
  }
}

export async function clearStorageRoot ({ storageRoot, logger }) {
  await rm(storageRoot, { recursive: true, force: true })
  await mkdir(storageRoot, { recursive: true })
  logger?.info('storage_cleared', { storageRoot })
}

function sendJson (ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

function safePathSegment (value) {
  return value.replace(/[^a-f0-9]/gi, '')
}
