const levels = ['debug', 'info', 'warn', 'error']

export function createLogger (level = 'info') {
  const threshold = Math.max(0, levels.indexOf(level))

  function write (messageLevel, event, fields = {}) {
    if (levels.indexOf(messageLevel) < threshold) return
    const line = {
      ts: new Date().toISOString(),
      level: messageLevel,
      event,
      ...fields
    }
    const output = JSON.stringify(line)
    if (messageLevel === 'error') console.error(output)
    else if (messageLevel === 'warn') console.warn(output)
    else console.log(output)
  }

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields)
  }
}
