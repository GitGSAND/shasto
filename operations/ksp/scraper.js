const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const logger = require('../../core/logger')

puppeteer.use(StealthPlugin())

// ── Constants ────────────────────────────────────────────────────────────────

const SITE              = 'https://ksp.co.il'
const SSE_URL           = `${SITE}/m_action/sse/streams`
const CHROME_PATH       = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PAGE_SIZE         = 12
const MAX_PAGES         = 20
const MAX_PRODUCTS      = 500

const INTER_PRODUCT_DELAY_MS  = 350
const INTER_SEARCH_DELAY_MS   = 600
const DETAIL_BATCH_SIZE        = 8
const DETAIL_BATCH_PAUSE_MS    = 2_000
const NAV_TIMEOUT_MS           = 25_000

// ── Browser lifecycle ────────────────────────────────────────────────────────

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--lang=he-IL',
      '--window-size=1400,900',
    ],
  })
  return browser
}

async function createPage(browser) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 900 })
  // Block images, fonts, media — speeds up navigation without affecting API calls
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const type = req.resourceType()
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
      req.abort()
    } else {
      req.continue()
    }
  })
  return page
}

// ── In-browser SSE helpers ───────────────────────────────────────────────────

/**
 * Calls the KSP SSE streams endpoint from within the browser page context.
 * Returns an array of parsed SSE event objects with { key, ok, data }.
 */
async function callSse(page, components) {
  const raw = await page.evaluate(async (url, comps) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ components: comps, context: { tt: 0 } }),
      })
      return await res.text()
    } catch (e) {
      return '__ERROR__:' + e.message
    }
  }, SSE_URL, components)

  if (raw.startsWith('__ERROR__:')) {
    throw new Error('SSE fetch error: ' + raw.slice(10))
  }

  const events = []
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const ev = JSON.parse(line.slice(5).trim())
      if (ev.key !== undefined) events.push(ev)
    } catch {}
  }
  return events
}

// ── Search logic ─────────────────────────────────────────────────────────────

/**
 * Fetches one page of search results for `term`.
 * Returns { items, next, productsTotal } where next is the next page number (or null when done).
 */
async function fetchSearchPage(page, term, pageNum) {
  const events = await callSse(page, [{
    key: 'cat.categoryListing',
    params: {
      categoryPath:   '',
      withSuggestion: 1,
      sort:           5,
      number:         PAGE_SIZE,
      tags_size:      5,
      search:         term,
      page:           pageNum,
    },
  }])

  const ev = events.find((e) => e.key === 'cat.categoryListing')
  if (!ev?.ok) {
    logger.warn('KSP search returned error or no data', { term, page: pageNum, ev })
    return { items: [], next: null, productsTotal: null }
  }

  const result = ev.data?.result || {}
  const items  = (result.items || []).map((p) => ({
    uin:         p.uin,
    name:        p.name || '',
    description: p.description || '',
    price:       p.price ?? null,
    brandName:   p.brandName || '',
    outOfStock:  p.outOfStock ?? false,
  }))

  // next <= 0 means no further pages (KSP returns 0 instead of null on last page)
  const rawNext = result.next != null ? Number(result.next) : null
  const next    = rawNext != null && rawNext > 0 ? rawNext : null
  return { items, next, productsTotal: result.products_total ?? null }
}

/**
 * Collects all unique products across all search pages for `term`.
 */
async function collectAllProducts(page, term, stopSignal) {
  const seenUins    = new Set()
  const allProducts = []
  let pageNum       = 1
  let productsTotal = null

  while (!stopSignal.stopped && pageNum <= MAX_PAGES) {
    logger.debug('KSP: fetching search page', { term, page: pageNum })

    let result
    try {
      result = await fetchSearchPage(page, term, pageNum)
    } catch (err) {
      logger.error('KSP: search page fetch failed', { term, page: pageNum, error: err.message })
      break
    }

    const { items, next } = result
    if (productsTotal === null && result.productsTotal != null) {
      productsTotal = result.productsTotal
    }

    const newItems = items.filter((p) => !seenUins.has(p.uin))
    newItems.forEach((p) => { seenUins.add(p.uin); allProducts.push(p) })

    logger.debug('KSP: search page done', {
      term, page: pageNum, new: newItems.length,
      total: allProducts.length, productsTotal,
    })

    if (allProducts.length >= MAX_PRODUCTS) break
    if (next == null) break
    // Guard: stop once we've collected all known products (accounts for API overlap)
    if (productsTotal != null && allProducts.length >= productsTotal) break
    // Stop if entire page yielded no new items (overlap / end of results)
    if (newItems.length === 0) {
      logger.debug('KSP: no new items — search exhausted', { term, page: pageNum, total: allProducts.length })
      break
    }

    pageNum = next
    await sleep(INTER_SEARCH_DELAY_MS)
  }

  logger.info('KSP: search complete', { term, totalProducts: allProducts.length, productsTotal })
  return allProducts
}

// ── Product detail (barcode) logic ───────────────────────────────────────────

/**
 * Extracts all barcodes from `specification.items`.
 * KSP stores barcodes under head='ברקוד' or head="מק''ט" (catalog/SKU).
 * Some products have multiple EANs in a single field, separated by ' / '.
 * Returns { barcode: string|null, additionalBarcodes: string|null }
 *   - barcode: first valid EAN (8–14 digits)
 *   - additionalBarcodes: remaining EANs joined by ' / ', or null if none
 */
function parseBarcodesFromSpec(specItems) {
  if (!Array.isArray(specItems)) return { barcode: null, additionalBarcodes: null }

  const stripHtml = (s) => s.replace(/<[^>]+>/g, '').trim()
  const isEan     = (s) => /^\d{8,14}$/.test(s)

  for (const head of ['ברקוד', "מק''ט"]) {
    const item = specItems.find((s) => s.head === head)
    if (!item?.body) continue

    const raw    = stripHtml(item.body)
    // Split on common separators: ' / ', ', ', ';'
    const parts  = raw.split(/\s*[\/,;]\s*/).map(s => s.trim()).filter(s => isEan(s))
    if (parts.length === 0) continue

    return {
      barcode:           parts[0],
      additionalBarcodes: parts.length > 1 ? parts.slice(1).join(' / ') : null,
    }
  }

  return { barcode: null, additionalBarcodes: null }
}

/**
 * Navigates to the product page and looks for an EAN-like number (8–14 digits)
 * in the visible text. Used as a last-resort fallback when the API spec has no barcode.
 */
async function scrapeBarcodeFromPage(page, uin) {
  try {
    logger.debug('KSP: falling back to DOM barcode scrape', { uin })
    await page.goto(`${SITE}/web/item/${uin}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    await sleep(2500) // Allow React SPA to render product details
    const barcode = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const t = node.textContent.trim()
        if (/^\d{8,14}$/.test(t)) return t
      }
      return null
    })
    if (barcode) logger.debug('KSP: DOM barcode found', { uin, barcode })
    return barcode || null
  } catch (err) {
    logger.warn('KSP: DOM barcode scrape failed', { uin, error: err.message })
    return null
  }
}

/**
 * Fetches item.item detail for a single UIN: barcode, original price, and sale price.
 * Falls back to DOM scraping if the API spec does not contain a barcode.
 */
async function fetchItemDetail(page, uin) {
  const events = await callSse(page, [{
    key:    'item.item',
    params: { uin: String(uin) },
  }])

  const ev = events.find((e) => e.key === 'item.item')
  if (!ev?.ok) {
    logger.warn('KSP: item.item returned error', { uin, ev })
    return null
  }

  const result    = ev.data?.result || {}
  const specItems = result.specification?.items
  let { barcode, additionalBarcodes } = parseBarcodesFromSpec(specItems)

  // DOM fallback: navigate to product page if SSE spec has no barcode
  if (!barcode) {
    barcode = await scrapeBarcodeFromPage(page, uin)
  }

  const bms       = result.bms?.[String(uin)] || result.bms?.[uin] || {}
  const bmsPrice  = bms.price ?? null
  // Campaign/sale price from bms.discount.value (null when no active discount)
  const salePrice = bms.discount?.value ?? null

  return { barcode, additionalBarcodes, bmsPrice, salePrice }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Main generator ───────────────────────────────────────────────────────────

async function* run(items, stopSignal) {
  const browser = await launchBrowser()
  const page    = await createPage(browser)

  try {
    // Get Cloudflare clearance by navigating homepage once
    logger.info('KSP: getting Cloudflare clearance...')
    await page.goto(SITE + '/web/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    await sleep(2000)
    logger.info('KSP: browser ready', { title: await page.title() })

    let cumulativeIndex = 0

    for (const [termIdx, term] of items.entries()) {
      if (stopSignal.stopped) break

      logger.info('KSP: processing search term', { term, termIdx: termIdx + 1, total: items.length })

      // ── Phase 1: Collect all products from search ──────────────────────────
      let termProducts
      try {
        termProducts = await collectAllProducts(page, term, stopSignal)
      } catch (err) {
        logger.error('KSP: search failed for term', { term, error: err.message })
        yield {
          status:      'error',
          searchQuery: term,
          index:       cumulativeIndex,
          total:       cumulativeIndex,
          message:     `Search failed: ${err.message}`,
        }
        continue
      }

      if (termProducts.length === 0) {
        yield {
          status:      'not_found',
          searchQuery: term,
          barcode:     term,
          index:       cumulativeIndex,
          total:       cumulativeIndex,
          message:     'No products found',
        }
        continue
      }

      const termTotal = termProducts.length

      // ── Phase 2: Enrich each product with barcode ──────────────────────────
      for (let i = 0; i < termProducts.length; i++) {
        if (stopSignal.stopped) break

        const product = termProducts[i]
        cumulativeIndex++

        // Batch pause every DETAIL_BATCH_SIZE products
        if (i > 0 && i % DETAIL_BATCH_SIZE === 0) {
          logger.debug('KSP: detail batch pause', { term, i })
          await sleep(DETAIL_BATCH_PAUSE_MS)
        }

        let barcode            = null
        let additionalBarcodes = null
        let price              = product.price
        let salePrice          = null

        try {
          const detail = await fetchItemDetail(page, product.uin)
          if (detail) {
            barcode            = detail.barcode
            additionalBarcodes = detail.additionalBarcodes
            price              = detail.bmsPrice ?? price
            salePrice          = detail.salePrice
          }
        } catch (err) {
          logger.warn('KSP: item detail failed', { uin: product.uin, error: err.message })
        }

        yield {
          status:      'found',
          searchQuery: term,
          barcode:     barcode || String(product.uin),  // top-level for frontend table
          index:       cumulativeIndex,
          total:       cumulativeIndex + (termTotal - i - 1),
          product: {
            productId:          String(product.uin),
            sku:                barcode,           // primary EAN barcode
            additionalBarcodes,                    // extra EANs when product has multiple, or null
            shortTitle:         product.name,      // frontend table shows shortTitle
            brand:              product.brandName,
            name:               product.name,
            description:        product.description,
            price,
            salePrice,                             // campaign/discount price (null if no active discount)
            outOfStock:         product.outOfStock,
            productUrl:         `${SITE}/web/item/${product.uin}`,
          },
        }

        if (i < termProducts.length - 1) {
          await sleep(INTER_PRODUCT_DELAY_MS)
        }
      }
    }
  } finally {
    try { await browser.close() } catch {}
    logger.info('KSP: browser closed')
  }
}

module.exports = run
