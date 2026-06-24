const Module = require('node:module')

const originalLoad = Module._load
let fallback = null

Module._load = function patchedLoad (request, parent, isMain) {
  if (request === 'sodium-native') {
    if (!fallback) fallback = originalLoad.call(this, 'sodium-javascript', parent, false)
    return fallback
  }
  return originalLoad.call(this, request, parent, isMain)
}
