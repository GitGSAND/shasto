const https = require('https')
const puppeteer = require('puppeteer')
const logger = require('../../core/logger')

const NIXALE_API = 'https://n2.nixale.com/q?customer=superpharm&key=DF2b1e3de0ca43dE892a84478Fcc1926&autocomplete=true&getExpanded=true&q='
const SITE_ORIGIN = 'https://shop.super-pharm.co.il'
const IMAGE_BASE   = 'https://superpharmstorage.blob.core.windows.net/hybris/products/desktop/medium/'

// ── Rate limiting ────────────────────────────────────────────────────────────
// All delays are in milliseconds. Jitter adds randomness so requests don't
// arrive at perfectly even intervals (a common bot detection signal).

const INTER_BARCODE_DELAY_MS  = 2000  // base pause between barcodes
const INTER_BARCODE_JITTER_MS = 1000  // random 0–1000ms added on top
const API_MIN_DELAY_MS        = 300   // minimum gap after a Nixale API call
const BATCH_SIZE               = 20   // take a longer pause every N barcodes
const BATCH_PAUSE_MS           = 15_000 // how long to pause between batches

const NAV_TIMEOUT_MS          = 35_000
const RESULT_WAIT_TIMEOUT_MS  = 15_000

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Selectors derived from live DOM inspection of shop.super-pharm.co.il
const SEL = {
  // Search results page (Puppeteer fallback)
  productCard: 'div.item-box.initialized',
  noResults:   '.no-results:not(.hide)',
  cardLink:    'a.item-box-link',
  cardImage:   'div.item-box.initialized .item-image img',

  // Product page (for description + ingredients)
  productName:  'h1 .product-name, h1',
  productBrand: '.product-title',
  priceEl:      '.price-container .item-price',
  oldPrice:     '.old-price.price-row',
  productImage: '.product-image.single .swiper-slide img, .gallery-top .swiper-slide img',
  description:  '#product-info .content-side',
  ean:          '.description-ean',
  category:     '.breadcrumb li:nth-last-child(3)',
  ingredients:  '.product-properties .property-name',
}

// ── Nixale API ───────────────────────────────────────────────────────────────

function fetchJson(url) {
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

async function queryNixaleApi(barcode) {
  const url = `${NIXALE_API}${encodeURIComponent(barcode)}`
  logger.debug('Calling Nixale API', { barcode, url })

  const [data] = await Promise.all([
    fetchJson(url),
    sleep(API_MIN_DELAY_MS), // ensure we never fire API calls back-to-back with no gap
  ])

  if (!data.products?.length) return null

  const p = data.products[0]

  // When sPrice exists it's the discounted/current price; price is then the original
  const currentPrice  = p.sPrice ? String(p.sPrice) : String(p.price)
  const originalPrice = p.sPrice ? String(p.price)  : null

  return {
    name:          p.shortTitle   || null,
    brand:         p.brand        || null,
    currentPrice,
    originalPrice,
    category:      p.category     || p.cat || null,
    imageUrl:      p.image ? `${IMAGE_BASE}${p.image}` : null,
    productUrl:    p.url   ? `${SITE_ORIGIN}/${p.url}` : null,
    sku:           p.image ? p.image.replace('.jpg', '') : null,
    internalId:    p.id           || null,
  }
}

// ── Puppeteer helpers ────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jitteredDelay() {
  const ms = INTER_BARCODE_DELAY_MS + Math.floor(Math.random() * INTER_BARCODE_JITTER_MS)
  return sleep(ms)
}

async function batchPauseIfNeeded(index, total, stopSignal) {
  const isLastItem   = index === total - 1
  const isBatchBound = (index + 1) % BATCH_SIZE === 0
  if (isLastItem || !isBatchBound || stopSignal.stopped) return

  logger.info(`Batch pause — processed ${index + 1} barcodes, pausing ${BATCH_PAUSE_MS / 1000}s to avoid rate limiting`)
  await sleep(BATCH_PAUSE_MS)
}

async function extract(page, selector) {
  try {
    return await page.$eval(selector, (el) => el.textContent?.trim() || null)
  } catch { return null }
}

async function extractAttr(page, selector, attr) {
  try {
    return await page.$eval(selector, (el, a) => el.getAttribute(a), attr) || null
  } catch { return null }
}

async function extractPrice(page, containerSel) {
  try {
    return await page.$eval(containerSel, (el) => {
      const shekel = el.querySelector('.shekels')?.textContent?.trim()
      const cents  = el.querySelector('.cents')?.textContent?.trim()
      if (shekel && cents) return `${shekel}.${cents}`
      return el.dataset?.price || el.textContent?.replace(/\s+/g, ' ').trim() || null
    })
  } catch { return null }
}

async function isRateLimited(page) {
  try {
    const title = (await page.title()).toLowerCase()
    return (
      title.includes('access denied') ||
      title.includes('captcha') ||
      title.includes('blocked') ||
      title.includes('robot')
    )
  } catch { return false }
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--lang=he-IL',
      '--disable-blink-features=AutomationControlled',
    ],
  })
}

// ── Product page scrape (description + ingredients) ─────────────────────────

async function scrapeProductPage(page, productUrl) {
  logger.debug('Scraping product page for extra details', { url: productUrl })
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
  await sleep(1500)

  const description = await extract(page, SEL.description)

  const rawEan = await extract(page, SEL.ean)
  const ean    = rawEan ? rawEan.replace(/[^0-9]/g, '') || null : null

  const ingredientsList = await page.$$eval(SEL.ingredients,
    (els) => els.map((el) => el.textContent?.trim()).filter(Boolean)
  ).catch(() => [])
  const ingredients = ingredientsList.length ? ingredientsList.join(', ') : null

  // Also pick up fields that the API might have missed
  const name         = await extract(page, SEL.productName)
  const brand        = await extract(page, SEL.productBrand)
  const priceAttr    = await page.$eval(SEL.priceEl, (el) => el.dataset?.price || null).catch(() => null)
  const currentPrice = priceAttr || await extractPrice(page, SEL.priceEl)
  const originalPrice = await extractPrice(page, SEL.oldPrice)
  const imageUrl     = await extractAttr(page, SEL.productImage, 'src')
  const category     = await extract(page, SEL.category)

  return { name, brand, currentPrice, originalPrice, imageUrl, description, sku: ean, category, ingredients }
}

// ── Puppeteer search page fallback ───────────────────────────────────────────

async function searchWithPuppeteer(page, barcode) {
  const searchUrl = `${SITE_ORIGIN}/search?q=${encodeURIComponent(barcode)}`
  logger.debug('Puppeteer fallback search', { barcode, url: searchUrl })

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })

  try {
    await page.waitForSelector(`${SEL.productCard}, ${SEL.noResults}`, {
      timeout: RESULT_WAIT_TIMEOUT_MS,
    })
  } catch {}

  const noResultsEl = await page.$(SEL.noResults)
  if (noResultsEl) return null

  const card = await page.$(SEL.productCard)
  if (!card) return null

  const cardData = await page.$eval(SEL.productCard, (el) => ({
    name:  el.dataset.name  || null,
    brand: el.dataset.brand || null,
    price: el.dataset.price || null,
    sku:   el.dataset.id    || null,
  }))

  const relHref  = await extractAttr(page, SEL.cardLink, 'href')
  const productUrl = relHref ? `${SITE_ORIGIN}${relHref}` : null
  const imageUrl   = await extractAttr(page, SEL.cardImage, 'src')

  return {
    name:          cardData.name,
    brand:         cardData.brand,
    currentPrice:  cardData.price,
    originalPrice: null,
    category:      null,
    imageUrl,
    productUrl,
    sku:           cardData.sku,
    internalId:    cardData.sku,
  }
}

// ── Main async generator ─────────────────────────────────────────────────────

async function* run(barcodes, stopSignal) {
  const total = barcodes.length
  let browser = null
  let browserNeeded = false

  try {
    for (let index = 0; index < barcodes.length; index++) {
      if (stopSignal.stopped) {
        logger.info('Stop signal received, halting scraper')
        break
      }

      const barcode = barcodes[index].toString().trim()
      let page = null

      try {
        // ── Step 1: Try Nixale API (fast, no browser) ──────────────────────
        let apiResult = null
        try {
          apiResult = await queryNixaleApi(barcode)
        } catch (apiErr) {
          logger.warn('Nixale API error, will fall back to Puppeteer', { barcode, error: apiErr.message })
        }

        if (apiResult) {
          logger.debug('API hit — product found', { barcode, name: apiResult.name })

          // ── Step 2a: Visit product page for description + ingredients ──────
          let extraDetails = {}
          if (apiResult.productUrl) {
            if (!browser) {
              browser = await launchBrowser()
              logger.info('Puppeteer browser launched (for product page details)')
            }
            page = await browser.newPage()
            await page.setUserAgent(USER_AGENT)
            await page.setViewport({ width: 1400, height: 900 })

            try {
              extraDetails = await scrapeProductPage(page, apiResult.productUrl)
            } catch (err) {
              logger.warn('Product page scrape failed', { barcode, error: err.message })
            }
          }

          const product = {
            name:          extraDetails.name          || apiResult.name,
            brand:         extraDetails.brand         || apiResult.brand,
            currentPrice:  extraDetails.currentPrice  || apiResult.currentPrice,
            originalPrice: extraDetails.originalPrice || apiResult.originalPrice,
            imageUrl:      extraDetails.imageUrl      || apiResult.imageUrl,
            productUrl:    apiResult.productUrl,
            description:   extraDetails.description   || null,
            sku:           extraDetails.sku           || apiResult.sku,
            category:      extraDetails.category      || apiResult.category,
            ingredients:   extraDetails.ingredients   || null,
          }

          yield { status: 'found', barcode, index: index + 1, total, product }

        } else {
          // ── Step 2b: Puppeteer fallback for search page ───────────────────
          logger.debug('API returned no results, falling back to Puppeteer search', { barcode })

          if (!browser) {
            browser = await launchBrowser()
            logger.info('Puppeteer browser launched (for search fallback)')
          }
          page = await browser.newPage()
          await page.setUserAgent(USER_AGENT)
          await page.setViewport({ width: 1400, height: 900 })

          let searchResult = await searchWithPuppeteer(page, barcode)

          if (await isRateLimited(page)) {
            logger.warn('Rate limit detected, backing off 5s', { barcode })
            await sleep(5000)
            searchResult = await searchWithPuppeteer(page, barcode)

            if (await isRateLimited(page)) {
              yield { status: 'error', barcode, index: index + 1, total, message: 'Bot detection — blocked after retry' }
              continue
            }
          }

          if (!searchResult) {
            yield { status: 'not_found', barcode, index: index + 1, total }
            continue
          }

          // Optionally enrich with product page details
          let extraDetails = {}
          if (searchResult.productUrl) {
            try {
              if (page && !page.isClosed()) await page.close()
              page = await browser.newPage()
              await page.setUserAgent(USER_AGENT)
              await page.setViewport({ width: 1400, height: 900 })
              extraDetails = await scrapeProductPage(page, searchResult.productUrl)
            } catch (err) {
              logger.warn('Product page scrape failed after search fallback', { barcode, error: err.message })
            }
          }

          const product = {
            name:          extraDetails.name          || searchResult.name,
            brand:         extraDetails.brand         || searchResult.brand,
            currentPrice:  extraDetails.currentPrice  || searchResult.currentPrice,
            originalPrice: extraDetails.originalPrice || null,
            imageUrl:      extraDetails.imageUrl      || searchResult.imageUrl,
            productUrl:    searchResult.productUrl,
            description:   extraDetails.description   || null,
            sku:           extraDetails.sku           || searchResult.sku,
            category:      extraDetails.category      || null,
            ingredients:   extraDetails.ingredients   || null,
          }

          yield { status: 'found', barcode, index: index + 1, total, product }
        }

      } catch (err) {
        logger.error('Unexpected error processing barcode', { barcode, error: err.message })

        const isBrowserCrash = err.message?.includes('crashed') ||
          err.message?.includes('Protocol error') ||
          err.message?.includes('Target closed')

        if (isBrowserCrash && browser) {
          logger.warn('Browser crash — restarting', { barcode })
          try { await browser.close() } catch {}
          browser = null
          try {
            browser = await launchBrowser()
            logger.info('Browser restarted successfully')
          } catch (restartErr) {
            logger.error('Browser restart failed — aborting run', { error: restartErr.message })
            throw new Error('Browser crashed and could not be restarted')
          }
        }

        yield { status: 'error', barcode, index: index + 1, total, message: err.message }

      } finally {
        if (page && !page.isClosed()) {
          try { await page.close() } catch {}
        }
      }

      if (!stopSignal.stopped) {
        await batchPauseIfNeeded(index, total, stopSignal)
        if (index < total - 1) await jitteredDelay()
      }
    }

  } finally {
    if (browser) {
      try {
        await browser.close()
        logger.info('Puppeteer browser closed')
      } catch (err) {
        logger.warn('Error closing browser', { error: err.message })
      }
    }
  }
}

module.exports = run
