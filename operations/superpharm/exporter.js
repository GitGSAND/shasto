const path = require('path')
const ExcelJS = require('exceljs')
const { resolveOutputDir } = require('../../core/fileUtils')
const logger = require('../../core/logger')

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2B4A' } }
const HEADER_FONT = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }
const STATUS_COLORS = {
  found: 'FFC6EFCE',
  not_found: 'FFFFCCCC',
  error: 'FFFFCCCC',
}

const RTL_COLS = new Set(['name', 'brand', 'description', 'category'])

const COLUMNS = [
  { key: 'barcode',       header: 'Barcode',        width: 18 },
  { key: 'name',          header: 'Name',            width: 40 },
  { key: 'brand',         header: 'Brand',           width: 22 },
  { key: 'currentPrice',  header: 'Price',           width: 12 },
  { key: 'originalPrice', header: 'Original Price',  width: 16 },
  { key: 'sku',           header: 'SKU',             width: 18 },
  { key: 'category',      header: 'Category',        width: 24 },
  { key: 'description',   header: 'Description',     width: 50 },
  { key: 'imageUrl',      header: 'Image URL',       width: 50 },
  { key: 'productUrl',    header: 'Product URL',     width: 50 },
  { key: 'status',        header: 'Status',          width: 14 },
  { key: 'scrapedAt',     header: 'Scraped At',      width: 20 },
]

function applyHeaderStyle(row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL
    cell.font = HEADER_FONT
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF4A6B9A' } },
    }
  })
}

async function generate(results, runId) {
  const outputDir = resolveOutputDir()
  const filePath = path.join(outputDir, `superpharm-barcode-${runId}.xlsx`)

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Retail Ops Tool'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('Results', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  sheet.columns = COLUMNS

  applyHeaderStyle(sheet.getRow(1))

  const scrapedAt = new Date().toISOString()

  for (const result of results) {
    const product = result.product || {}
    const rowData = {
      barcode:       result.barcode,
      name:          product.name          || null,
      brand:         product.brand         || null,
      currentPrice:  product.currentPrice  || null,
      originalPrice: product.originalPrice || null,
      sku:           product.sku           || null,
      category:      product.category      || null,
      description:   product.description   || null,
      imageUrl:      product.imageUrl      || null,
      productUrl:    product.productUrl    || null,
      status:        result.status,
      scrapedAt,
    }

    const row = sheet.addRow(rowData)
    row.height = 18

    const statusColor = STATUS_COLORS[result.status]
    const statusCellIndex = COLUMNS.findIndex((c) => c.key === 'status') + 1
    if (statusColor) {
      row.getCell(statusCellIndex).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: statusColor },
      }
    }

    COLUMNS.forEach((col, i) => {
      const cell = row.getCell(i + 1)
      if (RTL_COLS.has(col.key)) {
        cell.alignment = { readingOrder: 'rtl', wrapText: true, vertical: 'top' }
      } else {
        cell.alignment = { vertical: 'top' }
      }
    })
  }

  autoFitColumns(sheet)

  const summarySheet = workbook.addWorksheet('Summary')
  buildSummarySheet(summarySheet, results, runId)

  await workbook.xlsx.writeFile(filePath)
  logger.info('Excel file written', { filePath, rows: results.length })

  return filePath
}

function autoFitColumns(sheet) {
  sheet.columns.forEach((col) => {
    let maxLen = col.header?.length || 10
    col.eachCell({ includeEmpty: false }, (cell) => {
      const cellLen = cell.value ? cell.value.toString().length : 0
      if (cellLen > maxLen) maxLen = cellLen
    })
    col.width = Math.min(Math.max(maxLen + 2, col.width || 10), 80)
  })
}

function buildSummarySheet(sheet, results, runId) {
  const found    = results.filter((r) => r.status === 'found').length
  const notFound = results.filter((r) => r.status === 'not_found').length
  const errors   = results.filter((r) => r.status === 'error').length

  const labelFont  = { bold: true, name: 'Arial', size: 11 }
  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2B4A' } }
  const headerFont = { ...labelFont, color: { argb: 'FFFFFFFF' } }

  sheet.columns = [
    { key: 'label', width: 24 },
    { key: 'value', width: 30 },
  ]

  const headerRow = sheet.addRow({ label: 'Field', value: 'Value' })
  headerRow.eachCell((cell) => {
    cell.fill = headerFill
    cell.font = headerFont
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })

  const rows = [
    { label: 'Operation',    value: 'Super Pharm — Barcode Lookup' },
    { label: 'Run ID',       value: runId },
    { label: 'Run At',       value: new Date().toLocaleString('he-IL') },
    { label: 'Total',        value: results.length },
    { label: 'Found',        value: found },
    { label: 'Not Found',    value: notFound },
    { label: 'Errors',       value: errors },
  ]

  rows.forEach(({ label, value }) => {
    const row = sheet.addRow({ label, value })
    row.getCell('label').font = labelFont
  })
}

module.exports = generate
