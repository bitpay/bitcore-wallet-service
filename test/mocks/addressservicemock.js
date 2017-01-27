var _ = require('lodash');
var Uuid = require('uuid');

function AddressServiceMock() {
  this.addresses = {};
  this.utxos = [];
};

AddressServiceMock.prototype.createGroup = function(cb) {
  var groupId = Uuid.v4();
  this.addresses[groupId] = [];
  return cb(null, groupId);
};

AddressServiceMock.prototype.addAddresses = function(groupId, addresses, cb) {
  $.checkArgument(this.groups[groupId]);
  this.addresses[groupId] = this.addresses[groupId].concat(addresses);
  return cb();
};

AddressServiceMock.prototype.getUtxos = function(groupId, cb) {
  var self = this;
  return cb(null, _.filter(self.utxos, function(utxo) {
    return _.contains(_.keys(self.addresses[groupId]), utxo.address);
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

module.exports = AddressServiceMock;
