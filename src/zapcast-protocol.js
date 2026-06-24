import crypto from 'hypercore-crypto'
import b4a from 'b4a'

export const DEFAULT_MIME = 'video/mp4; codecs="avc1.42c01e,mp4a.40.2"'

export function normalizeStreamId (input) {
  if (!input || typeof input !== 'string') throw new Error('Missing streamId')
  const trimmed = input.trim()
  return trimmed.startsWith('zapcast:') ? trimmed.slice('zapcast:'.length) : trimmed
}

export function parseStreamId (input) {
  const streamId = normalizeStreamId(input)
  const parts = streamId.split(':')
  if (parts.length === 3 && parts[0] === 'zc1' && isHexKey(parts[1]) && isHexKey(parts[2])) {
    return { streamId, publicKeyHex: parts[1].toLowerCase(), feedKeyHex: parts[2].toLowerCase() }
  }
  if (isHexKey(streamId)) {
    return { streamId: streamId.toLowerCase(), publicKeyHex: streamId.toLowerCase(), feedKeyHex: streamId.toLowerCase() }
  }
  throw new Error('Invalid ZapCast stream ID')
}

export function deriveTopic (streamPublicKeyHex) {
  return crypto.hash(b4a.from(`zapcast-live:${streamPublicKeyHex}`))
}

export function decodeRecord (record) {
  if (!record || typeof record !== 'object') throw new Error('Invalid stream record')
  const meta = record.meta && typeof record.meta === 'object' ? record.meta : {}
  const data = decodeData(record.data)
  const type = record.type === 'init' || meta.isInitSegment ? 'init' : 'chunk'
  const seq = Number.isFinite(Number(meta.seq)) ? Number(meta.seq) : 0

  return {
    type,
    seq,
    timestamp: timestampMs(meta.appendedAt || meta.createdAt),
    durationMs: Number.isFinite(Number(meta.durationMs)) ? Number(meta.durationMs) : 0,
    mime: typeof meta.mime === 'string' && meta.mime ? meta.mime : DEFAULT_MIME,
    byteLength: Number.isFinite(Number(meta.byteLength)) ? Number(meta.byteLength) : data.byteLength,
    payment: meta.payment && typeof meta.payment === 'object' ? meta.payment : null,
    data,
    receivedAt: Date.now()
  }
}

export function recordToMessage (record) {
  const base = {
    type: record.type,
    seq: record.seq,
    mime: record.mime,
    payment: record.payment || null,
    dataBase64: b4a.toString(record.data, 'base64')
  }
  if (record.type === 'chunk') {
    base.timestamp = record.timestamp
    base.durationMs = record.durationMs
  }
  return base
}

export function inspectMp4 (data) {
  const bytes = data instanceof Uint8Array ? data : b4a.from(data || [])
  return {
    firstBox: firstBox(bytes),
    markers: ['ftyp', 'moov', 'trak', 'avc1', 'avc3', 'avcC', 'mp4a', 'esds']
      .filter(marker => findAscii(bytes, marker) >= 0),
    avcCodec: avcCodec(bytes)
  }
}

function decodeData (data) {
  if (b4a.isBuffer(data)) return data
  if (data instanceof Uint8Array) return b4a.from(data)
  if (typeof data === 'string') return b4a.from(data, 'base64')
  throw new Error('Invalid stream record media payload')
}

function isHexKey (value) {
  return /^[a-f0-9]{64}$/i.test(value)
}

function timestampMs (value) {
  if (!value) return Date.now()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function firstBox (bytes) {
  if (bytes.byteLength < 8) return ''
  const size = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]
  const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])
  return `${type}:${size}`
}

function avcCodec (bytes) {
  const offset = findAscii(bytes, 'avcC')
  if (offset < 0 || offset + 7 >= bytes.byteLength) return ''
  return `avc1.${hexByte(bytes[offset + 5])}${hexByte(bytes[offset + 6])}${hexByte(bytes[offset + 7])}`
}

function findAscii (bytes, text) {
  const needle = [...text].map(char => char.charCodeAt(0))
  for (let index = 0; index <= bytes.byteLength - needle.length; index++) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset++) {
      if (bytes[index + offset] !== needle[offset]) {
        matched = false
        break
      }
    }
    if (matched) return index
  }
  return -1
}

function hexByte (value) {
  return value.toString(16).padStart(2, '0').toUpperCase()
}
