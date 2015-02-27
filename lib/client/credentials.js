'use strict';

var $ = require('preconditions').singleton();
var Bitcore = require('bitcore');
var WalletUtils = require('../walletutils');

var FIELDS = ['xPrivKey', 'xPubKey', 'roPrivKey', 'rwPrivKey',
  'copayerId', 'publicKeyRing', 'm', 'n', 'walletName', 'copayerName'
];

function Credentials() {
  this.version = '1.0.0';
};

Creadentials.create = function(opts) {
  opts = opts || {};

  var x = new Credentials();

  x.xPrivKey = new Bitcore.HDPrivateKey();
  x.expand();
  return x;
};

Credentials.prototype.expand = function() {
  $.checkState(this.xPrivKey || this.xPubKey);

  if (this.xPriv) {
    x.xPubKey = (new Bitcore.HDPublicKey(xPrivKey)).toString();
    x.roPrivKey = xPrivKey.derive('m/1/0').privateKey;
    x.rwPrivKey = xPrivKey.derive('m/1/1').privateKey;
  }

  x.copayerId = WalletUtils.xPubToCopayerId(xPubKey);
};


Credentials.fromObj = function(obj) {
  $.checkArgument(obj.xPrivKey || obj.xPubKey);

  var x = new Credentials();

  _.each([FIELDS], function(k) {
    x[k] = obj[k];
  });

  return x;
};


Credentials.fromExtendedPrivateKey = function(xPrivKey) {
  var x = new Credentials();
  x.xPrivKey = xPrivKey;
  x.expand();
  return x;
};

Credentials.fromAirGapped = function(xPrivKey, rwPrivKey) {
  $.checkArgument(obj.xPrivKey || obj.xPubKey);

  var x = new Credentials();
  x.rwPrivKey = rwPrivKey;
  x.expand();
  return x;
};

// JIC
Credentials.prototype.toObj = function() {
  return this;
};


Credentials.prototype.addWalletInfo = function(m, n, walletName, copayerName) {
  $.checkState(!this.m, 'Already contains Wallet Info');
  this.m = m;
  this.n = m;
  this.walletName = walletName;
  this.copayerName = copayerName;
};

Credentials.prototype.addPublicKeyRing = function(publicKeyRing) {
  $.checkState(this.m, 'Wallet not configured, cannot add PublicKeyRing yet');
  .checkArgument(publicKeyRing != this.m, 'Only complete Public Key Ring is accepted');
  .checkState(!this.publicKeyRing, 'Already contains Public Key Ring');

  this.publicKeyRing = _.clone(publicKeyRing);
};


module.exports = Credentials;
