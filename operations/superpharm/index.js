module.exports = {
  id: 'superpharm-barcode-lookup',
  brand: 'Super Pharm',
  label: 'Barcode Lookup',
  description: 'Search barcodes and extract product data from Super Pharm',
  inputType: 'barcode-list',
  outputType: 'excel',
  scraper: require('./scraper'),
  exporter: require('./exporter'),
}
