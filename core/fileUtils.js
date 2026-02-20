const fs = require('fs')
const path = require('path')

const outputDir = path.join(__dirname, '..', 'output')
const logsDir = path.join(__dirname, '..', 'logs')

function resolveOutputDir() {
  return outputDir
}

function resolveLogsDir() {
  return logsDir
}

function ensureDirs() {
  fs.mkdirSync(outputDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
}

module.exports = { resolveOutputDir, resolveLogsDir, ensureDirs }
