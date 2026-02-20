const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { parse } = require('csv-parse/sync')

const { ensureDirs } = require('./core/fileUtils')
const SseStream = require('./core/sseStream')
const { runOperation } = require('./core/operationRunner')
const logger = require('./core/logger')

ensureDirs()

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const upload = multer({ storage: multer.memoryStorage() })

// ── Operation discovery ──────────────────────────────────────────────────────

const operations = new Map()

function discoverOperations() {
  const opsDir = path.join(__dirname, 'operations')
  if (!fs.existsSync(opsDir)) return

  const brands = fs.readdirSync(opsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())

  for (const brand of brands) {
    const brandPath = path.join(opsDir, brand.name)
    const entries = fs.readdirSync(brandPath, { withFileTypes: true })

    for (const entry of entries) {
      const manifestPath = entry.isDirectory()
        ? path.join(brandPath, entry.name, 'index.js')
        : entry.name === 'index.js'
          ? path.join(brandPath, 'index.js')
          : null

      if (!manifestPath || !fs.existsSync(manifestPath)) continue

      try {
        const manifest = require(manifestPath)
        if (!manifest.id || !manifest.scraper || !manifest.exporter) continue
        operations.set(manifest.id, manifest)
        logger.info('Operation registered', { id: manifest.id, brand: manifest.brand })
      } catch (err) {
        logger.error('Failed to load operation manifest', { path: manifestPath, error: err.message })
      }
    }
  }
}

discoverOperations()

// ── Run session store ────────────────────────────────────────────────────────

const runs = new Map()

function createRunId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ── Barcode parsing helpers ──────────────────────────────────────────────────

function parseBarcodesFromText(text) {
  return text
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
}

function parseBarcodesFromCsv(buffer) {
  const records = parse(buffer, { skip_empty_lines: true, trim: true })
  const barcodes = records.flat().map((v) => v.toString().trim()).filter(Boolean)
  return [...new Set(barcodes)]
}

function extractBarcodes(req) {
  if (req.file) {
    const mime = req.file.mimetype
    const name = req.file.originalname.toLowerCase()
    if (name.endsWith('.csv') || mime === 'text/csv') {
      return parseBarcodesFromCsv(req.file.buffer)
    }
    return parseBarcodesFromText(req.file.buffer.toString('utf-8'))
  }
  if (Array.isArray(req.body?.barcodes)) {
    return [...new Set(req.body.barcodes.map((b) => b.toString().trim()).filter(Boolean))]
  }
  if (typeof req.body?.barcodes === 'string') {
    return parseBarcodesFromText(req.body.barcodes)
  }
  return []
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.get('/api/operations', (req, res) => {
  const list = Array.from(operations.values()).map(({ id, brand, label, description, inputType, outputType }) => ({
    id, brand, label, description, inputType, outputType,
  }))
  res.json(list)
})

app.post('/api/run/:operationId', upload.single('file'), (req, res) => {
  const manifest = operations.get(req.params.operationId)
  if (!manifest) {
    return res.status(404).json({ error: 'Operation not found' })
  }

  const barcodes = extractBarcodes(req)
  if (barcodes.length === 0) {
    return res.status(400).json({ error: 'No barcodes provided' })
  }

  const runId = createRunId()
  const stopSignal = { stopped: false }
  const run = {
    runId,
    operationId: manifest.id,
    status: 'running',
    results: [],
    outputPath: null,
    stopSignal,
  }
  runs.set(runId, run)

  const stream = new SseStream(res)
  logger.info('Run started', { runId, operationId: manifest.id, barcodeCount: barcodes.length })

  runOperation({ manifest, items: barcodes, stream, runId, stopSignal, run }).catch((err) => {
    logger.error('Unhandled error in runOperation', { runId, error: err.message })
  })
})

app.post('/api/stop/:runId', (req, res) => {
  const run = runs.get(req.params.runId)
  if (!run) return res.status(404).json({ error: 'Run not found' })
  if (run.status !== 'running') return res.status(409).json({ error: 'Run is not active' })

  run.stopSignal.stopped = true
  logger.info('Stop signal set', { runId: req.params.runId })
  res.json({ ok: true })
})

app.get('/api/download/:runId', (req, res) => {
  const run = runs.get(req.params.runId)
  if (!run) return res.status(404).json({ error: 'Run not found' })
  if (!run.outputPath) return res.status(404).json({ error: 'Output file not ready' })
  if (!fs.existsSync(run.outputPath)) return res.status(410).json({ error: 'Output file no longer exists' })

  logger.info('File download', { runId: req.params.runId, file: run.outputPath })
  res.download(run.outputPath)
})

// ── Global error guard ───────────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) })
})

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack })
})

app.listen(PORT, () => {
  logger.info(`Server running at http://localhost:${PORT}`)
})
