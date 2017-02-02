var _ = require('lodash');
var $ = require('preconditions').singleton();
var Uuid = require('uuid');

function AddressServiceMock() {
  this.addresses = {};
  this.utxos = [];
  this.txs = [];
};

AddressServiceMock.prototype.createGroup = function(cb) {
  var groupId = Uuid.v4();
  this.addresses[groupId] = [];
  return cb(null, groupId);
};

AddressServiceMock.prototype.addAddresses = function(groupId, addresses, cb) {
  $.checkArgument(this.addresses[groupId]);
  this.addresses[groupId] = this.addresses[groupId].concat(addresses);

  return cb();
};

AddressServiceMock.prototype.getUtxos = function(groupId, cb) {
  var self = this;

  var index = _.indexBy(self.addresses[groupId]);
  return cb(null, _.filter(self.utxos, function(utxo) {
    return !!index[utxo.address];
  }));
};

AddressServiceMock.prototype.getBalance = function(groupId, cb) {
  var self = this;
  self.getUtxos(groupId, function(err, utxos) {
    if (err) return cb(err);
    var balance = {};
    balance.total = _.sum(utxos, 'satoshis');
    balance.byAddress = _.reduce(utxos, function(mem, utxo) {
      if (!mem[utxo.address]) mem[utxo.address] = 0;
      mem[utxo.address] += utxo.satoshis;
      return mem;
    }, {});
    return cb(null, balance);
  });
};

AddressServiceMock.prototype._setUtxos = function(utxos) {
  this.utxos = this.utxos.concat(utxos);
};

AddressServiceMock.prototype.getTransactions = function(groupId, from, to, cb) {
  var self = this;

  var index = _.indexBy(self.addresses[groupId]);
  var txs = _.filter(self.txs, function(tx) {
    var fromInputs = _.pluck(tx.vin, 'addr');
    var fromOutputs = _.pluck(tx.vout, 'scriptPubKey.addresses');
    var allAddresses = _.flatten(fromInputs.concat(fromOutputs));
    return !!_.find(allAddresses, function(addr) {
      return !!index[addr];
    });
  });

  var MAX_BATCH_SIZE = 100;
  var nbTxs = txs.length;

  if (_.isUndefined(from) && _.isUndefined(to)) {
    from = 0;
    to = MAX_BATCH_SIZE;
  }
  if (!_.isUndefined(from) && _.isUndefined(to))
    to = from + MAX_BATCH_SIZE;

  if (!_.isUndefined(from) && !_.isUndefined(to) && to - from > MAX_BATCH_SIZE)
    to = from + MAX_BATCH_SIZE;

  if (from < 0) from = 0;
  if (to < 0) to = 0;
  if (from > nbTxs) from = nbTxs;
  if (to > nbTxs) to = nbTxs;

  var page = txs.slice(from, to);
  return cb(null, page);
};

AddressServiceMock.prototype._setTransactions = function(txs) {
  this.txs = this.txs.concat(txs);
};

module.exports = AddressServiceMock;
