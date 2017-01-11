'use strict';

var $ = require('preconditions').singleton();
var _ = require('lodash');

var Bitcore = require('bitcore-lib');
var Constants = require('../common/constants');

function Address() {};

Address.create = function(opts) {
  opts = opts || {};

  var now = Math.floor(Date.now() / 1000);
  var x = new Address();

  x.version = '1.0.0';
  x.createdOn = now;
  x.address = opts.address;
  x.walletId = opts.walletId;
  x.isChange = opts.isChange;
  x.path = opts.path;
  x.publicKeys = opts.publicKeys;
  x.network = Bitcore.Address(x.address).toObject().network;
  x.type = opts.type || Constants.SCRIPT_TYPES.P2SH;
  x.hasActivity = undefined;
  x.lastUsedOn = now;
  return x;
};

Address.fromObj = function(obj) {
  var x = new Address();

  x.version = obj.version;
  x.createdOn = obj.createdOn;
  x.address = obj.address;
  x.walletId = obj.walletId;
  x.network = obj.network;
  x.isChange = obj.isChange;
  x.path = obj.path;
  x.publicKeys = obj.publicKeys;
  x.type = obj.type || Constants.SCRIPT_TYPES.P2SH;
  x.hasActivity = obj.hasActivity;
  x.lastUsedOn = obj.lastUsedOn;
  return x;
};

Address._deriveAddress = function(scriptType, publicKeyRing, path, m, network) {
  $.checkArgument(_.contains(_.values(Constants.SCRIPT_TYPES), scriptType));

  var publicKeys = _.map(publicKeyRing, function(item) {
    var xpub = new Bitcore.HDPublicKey(item.xPubKey);
    return xpub.derive(path).publicKey;
  });

  var bitcoreAddress;
  switch (scriptType) {
    case Constants.SCRIPT_TYPES.P2SH:
      bitcoreAddress = Bitcore.Address.createMultisig(publicKeys, m, network);
      break;
    case Constants.SCRIPT_TYPES.P2PKH:
      $.checkState(_.isArray(publicKeys) && publicKeys.length == 1);
      bitcoreAddress = Bitcore.Address.fromPublicKey(publicKeys[0], network);
      break;
  }

  return {
    address: bitcoreAddress.toString(),
    path: path,
    publicKeys: _.invoke(publicKeys, 'toString'),
  };
};

Address.derive = function(walletId, scriptType, publicKeyRing, path, m, network, isChange) {
  var raw = Address._deriveAddress(scriptType, publicKeyRing, path, m, network);
  return Address.create(_.extend(raw, {
    walletId: walletId,
    type: scriptType,
    isChange: isChange,
  }));
};


module.exports = Address;
