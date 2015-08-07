'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var log = require('npmlog');
log.debug = log.verbose;

var Insight = require('./blockchainexplorers/insight');
var BitcoreNode = require('./blockchainexplorers/bitcorenode');

var PROVIDERS = {
  'insight': {
    'livenet': 'https://insight.bitpay.com:443',
    'testnet': 'https://test-insight.bitpay.com:443',
  },
  'bitcorenode': {
    'livenet': 'http://localhost:3000',
    'testnet': 'http://localhost:3001'
  }
};

function BlockChainExplorer(opts) {
  $.checkArgument(opts);

  var provider = opts.provider || 'insight';
  var network = opts.network || 'livenet';

  $.checkState(PROVIDERS[provider], 'Provider ' + provider + ' not supported');
  $.checkState(_.contains(_.keys(PROVIDERS[provider]), network), 'Network ' + network + ' not supported by this provider');

  var url = opts.url || PROVIDERS[provider][network];

  switch (provider) {
    case 'insight':
      return new Insight({
        network: network,
        url: url
      });
    case 'bitcorenode':
      return new BitcoreNode({
        network: network,
        url: url
      });
    default:
      throw new Error('Provider ' + provider + ' not supperted.');
  };
};

module.exports = BlockChainExplorer;
