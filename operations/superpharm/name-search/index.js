module.exports = {
  id:          'superpharm-name-search',
  brand:       'Super Pharm',
  label:       'Name Search',
  description: 'Search by Hebrew product/brand names and extract product data',
  inputType:   'name-list',
  outputType:  'excel',
  scraper:     require('./scraper'),
  exporter:    require('./exporter'),
}
