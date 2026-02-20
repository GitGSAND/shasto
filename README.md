# Retail Ops Tool

An internal Node.js web application for scraping and processing product data from Israeli pharmacy and retail brands. Currently supports Super Pharm barcode lookup, with an architecture designed to add new brands and operation types without modifying existing code.

---

## Prerequisites

- **Node.js v18+** — [nodejs.org](https://nodejs.org)
- **Windows 10 or 11**
- ~300MB free disk space (Puppeteer downloads its own Chromium ~150MB, plus dependencies)

---

## Setup

```bash
npm install
```

Puppeteer will automatically download a compatible Chromium binary during install. This is a one-time download of approximately 150MB and requires an internet connection.

---

## Running

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

For development with auto-restart on file changes:

```bash
npm run dev
```

---

## Usage

1. **Select an operation** from the dropdown (e.g. "Super Pharm · Barcode Lookup")
2. **Load barcodes** by dragging a CSV/TXT file onto the drop zone, or paste them directly into the text area (one per line)
3. Click **Start** — results stream in live as each barcode is scraped
4. When complete, click **Download Excel** to save the `.xlsx` output file
5. Click any result row to expand its full product details

You can click **Stop** at any time to halt the run after the current barcode finishes. A partial Excel file will still be generated.

---

## Logging

Logs are written to the `logs/` directory:

| File | Contents |
|---|---|
| `logs/combined.log` | All messages at `info` level and above (JSON) |
| `logs/error.log` | Error-level messages only (JSON) |

Colorized output also appears in the terminal console.

To enable verbose debug logging (per-barcode navigation details, selector hits):

```bash
LOG_LEVEL=debug npm start
```

---

## How to Add a New Operation (Same Brand)

Create a new folder inside the brand's directory and add three files:

```
operations/superpharm/price-monitor/
├── index.js     ← manifest
├── scraper.js   ← async generator
└── exporter.js  ← output generator
```

**`index.js`** must export this shape:

```js
module.exports = {
  id: 'superpharm-price-monitor',   // unique across all operations
  brand: 'Super Pharm',
  label: 'Price Monitor',
  description: 'Track price changes over time',
  inputType: 'url-list',            // drives the frontend input component
  outputType: 'excel',
  scraper: require('./scraper'),
  exporter: require('./exporter'),
}
```

**`scraper.js`** must export an async generator:

```js
async function* run(items, stopSignal) {
  for (const item of items) {
    if (stopSignal.stopped) break
    // ... scrape logic ...
    yield { status: 'found', barcode: item, index, total, product: { ... } }
  }
}
module.exports = run
```

**`exporter.js`** must export an async function returning the output file path:

```js
async function generate(results, runId) {
  // ... write file to output/ ...
  return filePath
}
module.exports = generate
```

The server auto-discovers all operations at startup — no changes to `server.js` are needed.

---

## How to Add a New Brand

Create a new directory under `operations/`:

```
operations/new-brand/
└── index.js     ← single-operation flat structure, or
operations/new-brand/
└── some-operation/
    ├── index.js
    ├── scraper.js
    └── exporter.js
```

Both flat (`operations/new-brand/index.js`) and nested (`operations/new-brand/operation/index.js`) structures are auto-discovered. The manifest `id` field must be globally unique.

---

## Adding a New Frontend Input Type

The frontend renders different input components based on `selectedOperation.inputType`. To add a new input type (e.g. `url-list`):

In `public/index.html`, add a new `<template>` block alongside the existing `barcode-list` one:

```html
<template x-if="selectedOperation && selectedOperation.inputType === 'url-list'">
  <div class="card mt-16">
    <!-- your URL list input UI here -->
  </div>
</template>
```

No other files need to change. The action bar, progress panel, and results table are all input-type agnostic.

---

## Troubleshooting

### Puppeteer / Chromium won't launch

Run with a visible browser window to watch what's happening:

In `operations/superpharm/scraper.js`, temporarily change:
```js
headless: true
```
to:
```js
headless: false
```

### Windows Firewall prompt

Node.js may request network access the first time it runs. Allow it when prompted.

### Rate limiting / CAPTCHA

Super Pharm may temporarily block headless requests. Symptoms: pages load but show no product results, or results are consistently empty.

Mitigations:
- Increase `INTER_BARCODE_DELAY_MS` in `scraper.js` (default 2000ms) to 4000–6000ms
- Run with `headless: false` and watch the browser — the site may show a CAPTCHA that can be solved once to set a session cookie (not automatable)
- Run smaller batches

### Excel file not downloading

Check that the `output/` directory exists and that the run completed with status `done` or `stopped`. The download button only appears when an output file is confirmed.

### `npm install` fails on Puppeteer

Puppeteer requires internet access during install to download Chromium. If behind a proxy, set `HTTPS_PROXY` before running `npm install`.
