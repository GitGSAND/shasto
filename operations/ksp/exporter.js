const path = require('path')
const ExcelJS = require('exceljs')
const { resolveOutputDir } = require('../../core/fileUtils')
const logger = require('../../core/logger')

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3D6E' } }
const HEADER_FONT = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }
const STATUS_COLORS = {
  found:     'FFC6EFCE',
  not_found: 'FFFFEB9C',
  error:     'FFFFCCCC',
}

const RTL_COLS = new Set(['searchQuery', 'name', 'description', 'brandName'])

const COLUMNS = [
  { key: 'searchQuery',        header: 'Search Query',        width: 22 },
  { key: 'name',               header: 'Name',                width: 50 },
  { key: 'description',        header: 'Description',         width: 55 },
  { key: 'brandName',          header: 'Brand',               width: 20 },
  { key: 'barcode',            header: 'Barcode (EAN)',       width: 18 },
  { key: 'additionalBarcodes', header: 'Additional Barcodes', width: 28 },
  { key: 'price',              header: 'Original Price (₪)',  width: 16 },
  { key: 'salePrice',          header: 'Sale Price (₪)',      width: 14 },
  { key: 'outOfStock',         header: 'Out of Stock',        width: 14 },
  { key: 'productUrl',         header: 'Product URL',         width: 55 },
  { key: 'status',             header: 'Status',              width: 14 },
  { key: 'scrapedAt',          header: 'Scraped At',          width: 20 },
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
  const filePath  = path.join(outputDir, `ksp-brand-search-${runId}.xlsx`)

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
      searchQuery: result.searchQuery  || null,
      name:        product.name        || product.shortTitle || null,
      description: product.description || null,
      brandName:   product.brand       || null,
      barcode:            product.sku                || null,
      additionalBarcodes: product.additionalBarcodes || null,
      price:              product.price    != null ? product.price     : null,
      salePrice:          product.salePrice != null ? product.salePrice : null,
      outOfStock:  product.outOfStock  === true ? 'Yes' : product.outOfStock === false ? 'No' : null,
      productUrl:  product.productUrl  || null,
      status:      result.status,
      scrapedAt,
    }

    const row = sheet.addRow(rowData)
    row.height = 18

    const statusColor = STATUS_COLORS[result.status]
    const statusIdx   = COLUMNS.findIndex((c) => c.key === 'status') + 1
    if (statusColor) {
      row.getCell(statusIdx).fill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: statusColor },
      }
    }

    // Highlight sale price in amber when it differs from the full price
    if (rowData.salePrice != null && rowData.salePrice !== rowData.price) {
      const spIdx = COLUMNS.findIndex((c) => c.key === 'salePrice') + 1
      row.getCell(spIdx).fill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' },
      }
    }

    if (rowData.outOfStock === 'Yes') {
      const ooIdx = COLUMNS.findIndex((c) => c.key === 'outOfStock') + 1
      row.getCell(ooIdx).fill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' },
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
  logger.info('KSP Excel file written', { filePath, rows: results.length })

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
  const terms    = [...new Set(results.map((r) => r.searchQuery).filter(Boolean))]
  const withBarcode = results.filter((r) => r.product?.sku).length

  const labelFont  = { bold: true, name: 'Arial', size: 11 }
  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3D6E' } }
  const headerFont = { ...labelFont, color: { argb: 'FFFFFFFF' } }

  sheet.columns = [
    { key: 'label', width: 24 },
    { key: 'value', width: 30 },
  ]

  const headerRow = sheet.addRow({ label: 'Field', value: 'Value' })
  headerRow.eachCell((cell) => {
    cell.fill   = headerFill
    cell.font   = headerFont
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })

  const rows = [
    { label: 'Operation',       value: 'KSP — Brand Search' },
    { label: 'Run ID',          value: runId },
    { label: 'Run At',          value: new Date().toLocaleString('he-IL') },
    { label: 'Search Terms',    value: terms.join(', ') },
    { label: 'Total Products',  value: results.length },
    { label: 'Found',           value: found },
    { label: 'Not Found',       value: notFound },
    { label: 'Errors',          value: errors },
    { label: 'With Barcode',    value: withBarcode },
    { label: 'Missing Barcode', value: found - withBarcode },
  ]

  rows.forEach(({ label, value }) => {
    const row = sheet.addRow({ label, value })
    row.getCell('label').font = labelFont
  })
}

module.exports = generate
