'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var log = require('npmlog');
log.debug = log.verbose;
var requestList = require('./request-list');

function BWDB(opts) {
  $.checkArgument(opts);
  $.checkArgument(_.contains(['livenet', 'testnet'], opts.network));
  $.checkArgument(opts.url);

  this.apiPrefix = opts.apiPrefix || '/api';
  this.network = opts.network || 'livenet';
  this.hosts = opts.url;
  this.userAgent = opts.userAgent || 'bws';
};


var _parseErr = function(err, res) {
  if (err) {
    log.warn('BWDB error: ', err);
    return "BWDB Error";
  }
  log.warn("BWDB " + res.request.href + " Returned Status: " + res.statusCode);
  return "Error querying the blockchain";
};

BWDB.prototype._doRequest = function(args, cb) {
  var opts = {
    hosts: this.hosts,
    headers: {
      'User-Agent': this.userAgent,
    }
  };
  requestList(_.defaults(args, opts), cb);
};

BWDB.prototype.getConnectionInfo = function() {
  return 'BWDB (' + this.network + ') @ ' + this.hosts;
};

BWDB.prototype.createWallet = function(cb) {
  var args = {
    method: 'POST',
    path: this.apiPrefix + '/wallets',
  };

  this._doRequest(args, function(err, res, body) {
    if (err || res.statusCode !== 200) return cb(_parseErr(err, res));
    if (!body || !body.walletId) return cb('No walletId returned from BWDB server');
    return cb(null, body.walletId);
  });
};

BWDB.prototype.addAddresses = function(walletId, addresses, cb) {
  var args = {
    method: 'POST',
    path: this.apiPrefix + '/wallets/' + walletId + '/addresses',
    formData: {
      addresses: addresses
    },
  };

  this._doRequest(args, function(err, res, body) {
    if (err || res.statusCode !== 200) return cb(_parseErr(err, res));
    return cb();
  });
};

BWDB.prototype.getUtxos = function(walletId, cb) {
  var args = {
    method: 'GET',
    path: this.apiPrefix + '/wallets/' + walletId + '/utxos',
  };

  this._doRequest(args, function(err, res, body) {
    if (err || res.statusCode !== 200) return cb(_parseErr(err, res));
    return cb(null, body.utxos);
  });
};

module.exports = BWDB;
