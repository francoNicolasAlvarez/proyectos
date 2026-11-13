const path = require('path');
const { pathToFileURL } = require('url');

const proto = (name) =>
  pathToFileURL(path.resolve(__dirname, '../../../docs/ux/prototype', name, 'index.html')).href;

module.exports = {
  customerUrl: proto('customer-app'),
  panelUrl: proto('venue-panel'),
};
