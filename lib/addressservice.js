'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var log = require('npmlog');
log.debug = log.verbose;
var requestList = require('./common/request-list');

function AddressService(opts) {
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
    log.warn('AddressService error: ', err);
    return "AddressService Error";
  }
  log.warn("AddressService " + res.request.href + " Returned Status: " + res.statusCode);
  return "Error querying the blockchain";
};

AddressService.prototype._doRequest = function(args, cb) {
  var opts = {
    hosts: this.hosts,
    headers: {
      'User-Agent': this.userAgent,
    }
  };
  requestList(_.defaults(args, opts), cb);
};

AddressService.prototype.getConnectionInfo = function() {
  return 'AddressService (' + this.network + ') @ ' + this.hosts;
};

AddressService.prototype.createGroup = function(cb) {
  var args = {
    method: 'POST',
    path: this.apiPrefix + '/wallets',
  };

  this._doRequest(args, function(err, res, body) {
    if (err || res.statusCode !== 200) return cb(_parseErr(err, res));
    if (!body || !body.walletId) return cb('No walletId returned from AddressService server');
    return cb(null, body.walletId);
  });
};

AddressService.prototype.addAddresses = function(groupId, addresses, cb) {
  var args = {
    method: 'POST',
    path: this.apiPrefix + '/wallets/' + groupId + '/addresses',
    formData: {
      addresses: addresses
    },
  };

  this._doRequest(args, function(err, res, body) {
    if (err || res.statusCode !== 200) return cb(_parseErr(err, res));
    return cb();
  });
};

AddressService.prototype.getUtxos = function(groupId, cb) {
  var args = {
    method: 'GET',
    path: this.apiPrefix + '/wallets/' + groupId + '/utxos',
  };

  this._doRequest(args, function(err, res, body) {
    if (err || res.statusCode !== 200) return cb(_parseErr(err, res));
    return cb(null, body.utxos);
  });
};

module.exports = AddressService;
