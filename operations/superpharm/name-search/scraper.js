const {
  queryNixaleApi,
  scrapeProductPage,
  createPage,
  launchBrowser,
  sleep,
  jitteredDelay,
  IMAGE_BASE,
  SITE_ORIGIN,
  NAV_TIMEOUT_MS,
  RESULT_WAIT_TIMEOUT_MS,
  SEL,
} = require('../scraper')
const logger = require('../../../core/logger')

// Maximum products to collect per search term. 0 = unlimited (all pages).
const MAX_RESULTS_PER_QUERY = 0

// Max pagination pages as a safety cap (30 cards/page → 1500 products max)
const MAX_PAGES = 50

// ── Nixale name-search query ──────────────────────────────────────────────────
// Unlike queryNixaleApi (used for barcode/ID lookups), this function returns
// ALL products from the response rather than just the first match.

async function queryNixaleByName(term) {
  const url =
    'https://n2.nixale.com/q?customer=superpharm' +
    '&key=DF2b1e3de0ca43dE892a84478Fcc1926' +
    '&autocomplete=true&getExpanded=true' +
    `&q=${encodeURIComponent(term)}`

  logger.debug('Nixale name query', { term, url })

  const [data] = await Promise.all([
    fetchJsonSimple(url),
    sleep(150),
  ])

  if (!data.products?.length) return []

  return data.products.map((p) => ({
    shortTitle:   p.shortTitle || null,
    brand:        p.brand      || null,
    price:        p.price      != null ? String(p.price)  : null,
    salePrice:    p.sPrice     != null ? String(p.sPrice) : null,
    category:     p.category   || null,
    mainCategory: p.cat        || null,
    promoEndDate: p.eD         || null,
    productId:    p.id         || null,
    imageUrl:     p.image ? `${IMAGE_BASE}${p.image}` : null,
    productUrl:   p.url   ? `${SITE_ORIGIN}/${p.url}` : null,
    sku:          p.image ? p.image.replace('.jpg', '') : null,
  }))
}

function fetchJsonSimple(url) {
  const https = require('https')
  const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)) }
      })
    }).on('error', reject)
  })
}

// ── Puppeteer: collect all product cards via cursor-based URL pagination ───────
//
// Super Pharm uses cursor-based pagination: each page request includes
// `lastProductCode=LAST_ID` (the data-id of the last card on the previous page)
// and an incrementing `page=N`. Each page response is a fresh render showing
// only that page's items. We stop when a page returns no new IDs.

async function extractCardsFromPage(page) {
  return page.$$eval(SEL.productCard, (els) =>
    els.map((el) => ({
      productId:       el.getAttribute('data-id'),
      shortTitle:      el.getAttribute('data-name')          || null,
      brand:           el.getAttribute('data-brand')         || null,
      price:           el.getAttribute('data-price')         || null,
      salePrice:       el.getAttribute('data-discountprice') || null,
      inStockFromCard: el.getAttribute('data-oos') === 'false',
      href:            el.querySelector('a.item-box-link')
        ? el.querySelector('a.item-box-link').getAttribute('href')
        : null,
    }))
  )
}

async function collectAllCards(page, term, stopSignal) {
  const encodedTerm = encodeURIComponent(term)
  const seenIds = new Set()
  const allCards = []
  let pageNum = 0
  let lastProductCode = null

  while (!stopSignal.stopped && pageNum <= MAX_PAGES) {
    const url = lastProductCode
      ? `${SITE_ORIGIN}/search?q=${encodedTerm}&page=${pageNum}&lastProductCode=${lastProductCode}`
      : `${SITE_ORIGIN}/search?q=${encodedTerm}`

    logger.debug('Navigating to search page', { term, page: pageNum, url })

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })

    const gotCards = await page.waitForSelector(SEL.productCard, { timeout: RESULT_WAIT_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false)

    if (!gotCards) {
      logger.debug('No product cards on page — done', { term, page: pageNum })
      break
    }

    const cards = await extractCardsFromPage(page)
    const newCards = cards.filter((c) => c.productId && !seenIds.has(c.productId))

    if (newCards.length === 0) {
      logger.debug('No new cards — all pages collected', { term, total: allCards.length })
      break
    }

    newCards.forEach((c) => { seenIds.add(c.productId); allCards.push(c) })
    lastProductCode = cards[cards.length - 1].productId
    logger.debug('Page collected', { term, page: pageNum, newCards: newCards.length, total: allCards.length })

    if (MAX_RESULTS_PER_QUERY > 0 && allCards.length >= MAX_RESULTS_PER_QUERY) break

    pageNum++
    await sleep(400)
  }

  logger.info('Total cards collected from search pages', { term, count: allCards.length })
  return allCards
}

// ── Main async generator ──────────────────────────────────────────────────────

async function* run(searchTerms, stopSignal) {
  let browser = null
  let cumulativeIndex = 0

  try {
    for (let termIdx = 0; termIdx < searchTerms.length; termIdx++) {
      if (stopSignal.stopped) break

      const term = searchTerms[termIdx].toString().trim()
      logger.info('Name search: processing term', { term, termIdx: termIdx + 1, totalTerms: searchTerms.length })

      // ── Phase 1: Nixale name query (fast, no browser) ────────────────────
      let nixaleProducts = []
      try {
        nixaleProducts = await queryNixaleByName(term)
        logger.debug('Nixale name results', { term, count: nixaleProducts.length })
      } catch (err) {
        logger.warn('Nixale name query failed, will rely on Puppeteer', { term, error: err.message })
      }

      // ── Phase 2: Puppeteer — collect all product cards for this term ─────
      if (!browser) {
        browser = await launchBrowser()
        logger.info('Puppeteer browser launched (name search)')
      }

      let allCards = []
      const searchPage = await createPage(browser)
      try {
        allCards = await collectAllCards(searchPage, term, stopSignal)
        logger.info('Search page cards collected', { term, count: allCards.length })
      } catch (err) {
        logger.warn('Search page collection failed', { term, error: err.message })
      } finally {
        if (!searchPage.isClosed()) await searchPage.close().catch(() => {})
      }

      // Index ALL Phase 2 cards by productId so we can look up hrefs for
      // nixale-sourced items whose API response didn't include a product URL.
      const cardById = new Map(
        allCards.filter((c) => c.productId).map((c) => [c.productId, c])
      )

      // Merge: Nixale-enriched products first, then Puppeteer-only IDs
      const nixaleIdSet = new Set(nixaleProducts.map((p) => p.productId).filter(Boolean))
      const puppeteerOnlyCards = allCards.filter((c) => c.productId && !nixaleIdSet.has(c.productId))

      // Build unified work list: [ { source, productId, cardData?, apiData? } ]
      const workItems = [
        ...nixaleProducts.map((p) => ({ source: 'nixale', productId: p.productId, apiData: p })),
        ...puppeteerOnlyCards.map((c) => ({ source: 'card', productId: c.productId, cardData: c })),
      ]

      // If Nixale returned nothing AND Puppeteer found nothing → not found
      if (workItems.length === 0) {
        cumulativeIndex++
        yield {
          status: 'not_found',
          barcode: term,
          searchQuery: term,
          index: cumulativeIndex,
          total: cumulativeIndex,
        }
        continue
      }

      const termTotal = workItems.length

      // ── Phase 3: Enrich each product and scrape its product page ─────────
      for (let itemIdx = 0; itemIdx < workItems.length; itemIdx++) {
        if (stopSignal.stopped) break

        const item = workItems[itemIdx]
        cumulativeIndex++

        let page = null
        try {
          // Resolve API data: either from Nixale name query or by product ID lookup.
          // For puppeteer-only cards we call queryNixaleApi by product ID; if it
          // returns null (rate-limited or transient failure) we retry once after a
          // short back-off so we don't silently lose description/EAN/inStock.
          let apiResult = item.apiData || null
          if (!apiResult && item.productId) {
            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                apiResult = await queryNixaleApi(item.productId)
                if (apiResult) break
                if (attempt === 1) {
                  logger.warn('Nixale ID lookup returned null, retrying after back-off', { productId: item.productId })
                  await sleep(2000)
                }
              } catch (err) {
                logger.warn('Nixale ID lookup error', { productId: item.productId, attempt, error: err.message })
                if (attempt === 1) await sleep(2000)
              }
            }
            if (!apiResult) {
              logger.error('Nixale ID lookup failed after retry — skipping product', { productId: item.productId })
              yield {
                status:      'error',
                barcode:     item.productId || term,
                searchQuery: term,
                index:       cumulativeIndex,
                total:       cumulativeIndex + (termTotal - itemIdx - 1),
                message:     `Nixale API returned no data for product ID ${item.productId} after retries`,
              }
              continue
            }
          }

          // For nixale-sourced items, cardData is null — fall back to the
          // Phase 2 card (if any) so we always have an href to scrape from.
          const card = item.cardData || cardById.get(item.productId) || {}
          const productUrl = apiResult?.productUrl
            || (card.href ? `${SITE_ORIGIN}${card.href}` : null)

          // Visit product page for description, ingredients, inStock
          let extraDetails = {}
          if (productUrl) {
            page = await createPage(browser)
            try {
              extraDetails = await scrapeProductPage(page, productUrl)
            } catch (err) {
              logger.warn('Product page scrape failed', {
                term,
                productId: item.productId,
                error: err.message,
              })
            }
          }

          const product = {
            shortTitle:   extraDetails.shortTitle   || apiResult?.shortTitle   || card.shortTitle   || null,
            brand:        extraDetails.brand         || apiResult?.brand         || card.brand        || null,
            price:        apiResult?.price           || card.price              || null,
            salePrice:    apiResult?.salePrice       || card.salePrice          || null,
            promoEndDate: apiResult?.promoEndDate    || null,
            productId:    apiResult?.productId       || item.productId          || null,
            category:     extraDetails.category      || apiResult?.category     || null,
            mainCategory: apiResult?.mainCategory    || null,
            imageUrl:     apiResult?.imageUrl        || null,
            productUrl:   apiResult?.productUrl      || productUrl              || null,
            description:  extraDetails.description   || null,
            sku:          extraDetails.sku           || apiResult?.sku          || null,
            ingredients:  extraDetails.ingredients   || null,
            // inStock from product page scrape; fall back to data-oos card attribute
            inStock:      extraDetails.inStock ?? (card.inStockFromCard ?? null),
          }

          // Use the product's EAN/SKU as the "barcode" identifier in the UI
          const displayId = product.sku || product.productId || term

          yield {
            status:       'found',
            barcode:      displayId,
            searchQuery:  term,
            index:        cumulativeIndex,
            total:        cumulativeIndex + (termTotal - itemIdx - 1),
            product,
          }

        } catch (err) {
          logger.error('Unexpected error processing product', {
            term,
            productId: item.productId,
            error: err.message,
          })

          const isBrowserCrash = err.message?.includes('crashed') ||
            err.message?.includes('Protocol error') ||
            err.message?.includes('Target closed')

          if (isBrowserCrash && browser) {
            logger.warn('Browser crash during name search — restarting', { term })
            try { await browser.close() } catch {}
            browser = null
            try {
              browser = await launchBrowser()
              logger.info('Browser restarted')
            } catch (restartErr) {
              logger.error('Browser restart failed', { error: restartErr.message })
              throw new Error('Browser crashed and could not be restarted')
            }
          }

          yield {
            status:      'error',
            barcode:     item.productId || term,
            searchQuery: term,
            index:       cumulativeIndex,
            total:       cumulativeIndex + (termTotal - itemIdx - 1),
            message:     err.message,
          }

        } finally {
          if (page && !page.isClosed()) {
            try { await page.close() } catch {}
          }
        }

        if (!stopSignal.stopped) await jitteredDelay()
      }

      // Pause between terms to avoid hammering the site
      if (termIdx < searchTerms.length - 1 && !stopSignal.stopped) {
        logger.debug('Pausing between search terms')
        await sleep(1500)
      }
    }

  } finally {
    if (browser) {
      try {
        await browser.close()
        logger.info('Puppeteer browser closed (name search)')
      } catch (err) {
        logger.warn('Error closing browser', { error: err.message })
      }
    }
  }
}

module.exports = run
