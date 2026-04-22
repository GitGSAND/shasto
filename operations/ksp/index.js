module.exports = {
  id:          'ksp-brand-search',
  brand:       'KSP',
  label:       'Brand Search',
  description: 'Search by Hebrew brand/product names and extract barcode, name, description and price',
  inputType:   'name-list',
  outputType:  'excel',
  scraper:     require('./scraper'),
  exporter:    require('./exporter'),
}
