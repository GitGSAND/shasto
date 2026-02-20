const HEARTBEAT_INTERVAL_MS = 15_000

class SseStream {
  constructor(res) {
    this.res = res
    this.closed = false

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    this._heartbeat = setInterval(() => {
      if (!this.closed) res.write(': heartbeat\n\n')
    }, HEARTBEAT_INTERVAL_MS)

    res.on('close', () => this.close())
  }

  send(data) {
    if (this.closed) return
    this.res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this._heartbeat)
    this.res.end()
  }
}

module.exports = SseStream
