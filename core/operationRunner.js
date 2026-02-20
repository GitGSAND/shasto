const logger = require('./logger')

async function runOperation({ manifest, items, stream, runId, stopSignal, run }) {
  const results = []

  try {
    stream.send({ type: 'start', runId, total: items.length })
    logger.info('Operation run started', { runId, operation: manifest.id, total: items.length })

    for await (const result of manifest.scraper(items, stopSignal)) {
      results.push(result)
      run.results = results
      stream.send({ type: 'result', runId, ...result })

      if (stopSignal.stopped) break
    }

    if (stopSignal.stopped) {
      run.status = 'stopped'
      logger.info('Operation run stopped by user', { runId, processed: results.length })

      if (results.length > 0) {
        const outputPath = await manifest.exporter(results, runId)
        run.outputPath = outputPath
        logger.info('Partial export written', { runId, outputPath })
        stream.send({ type: 'stopped', runId, outputPath })
      } else {
        stream.send({ type: 'stopped', runId, outputPath: null })
      }
    } else {
      const outputPath = await manifest.exporter(results, runId)
      run.outputPath = outputPath
      run.status = 'done'
      logger.info('Operation run completed', { runId, total: results.length, outputPath })
      stream.send({ type: 'done', runId, outputPath })
    }
  } catch (err) {
    run.status = 'error'
    logger.error('Operation run failed with fatal error', { runId, error: err.message, stack: err.stack })
    stream.send({ type: 'error', runId, message: err.message })
  } finally {
    stream.close()
  }
}

module.exports = { runOperation }
