const Module = require('node:module')

const originalLoad = Module._load
let native = null
let nativeTried = false
let fallback = null

Module._load = function patchedLoad (request, parent, isMain) {
  if (request === 'sodium-native') {
    if (process.env.ZAPCAST_FORCE_SODIUM_JS !== 'true') {
      if (!nativeTried) {
        nativeTried = true
        try {
          native = originalLoad.call(this, request, parent, isMain)
        } catch (err) {
          native = null
        }
      }
      if (native) return native
    }
    if (!fallback) fallback = originalLoad.call(this, 'sodium-javascript', parent, false)
    return fallback
  }
  return originalLoad.call(this, request, parent, isMain)
}
