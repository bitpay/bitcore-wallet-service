'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var config = require('../config');
var log = require('npmlog');
log.debug = log.verbose;

var Constants = require('./common/constants');
var Insight = require('./blockchainexplorers/insight');
var providers = config.blockchainExplorerOpts;

function BlockChainExplorer(opts) {
  $.checkArgument(opts);

  var network = opts.network || Constants.LIVENET;
  var provider = opts.provider || config.blockchainExplorerOpts.defaultProvider;

  $.checkState(providers[provider], 'Provider ' + provider + ' not supported');
  $.checkState(_.contains(_.keys(providers[provider]), network), 'Network ' + network + ' not supported by this provider');

  var url = opts.url || providers[provider][network];

  switch (provider) {
    case 'insight':
      return new Insight({
        network: network,
        url: url,
        apiPrefix: opts.apiPrefix,
        userAgent: opts.userAgent,
      });
    default:
      throw new Error('Provider ' + provider + ' not supported.');
  };
};

module.exports = BlockChainExplorer;
