'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var log = require('npmlog');
log.debug = log.verbose;
var request = require('request');
var io = require('socket.io-client');
var async = require('async');
var bitcore = require('bitcore');
var EventEmitter = require('events').EventEmitter;

function BitcoreNode(opts) {
  $.checkArgument(opts);
  $.checkArgument(_.contains(['livenet', 'testnet'], opts.network));
  $.checkArgument(opts.url);

  this.network = opts.network || 'livenet';
  this.url = opts.url;
};

BitcoreNode.prototype.getConnectionInfo = function() {
  return 'BitcoreNode (' + this.network + ') @ ' + this.url;
};

/**
 * Retrieve a list of unspent outputs associated with an address or set of addresses
 */
BitcoreNode.prototype.getUnspentUtxos = function(addresses, cb) {
  var self = this;

  this.connect(function() {
    self.socket.send({
      method: 'getUnspentOutputs',
      params: [addresses, true]
    }, function(response) {
      if(response.error) {
        if(response.error.message.match(/^NoOutputs/)) {
          return cb(null, []);
        }
        return cb(new Error(response.error.message));
      }

      var transformed = response.result.map(function(utxo) {
        return {
          address: utxo.address,
          txid: utxo.txid,
          vout: utxo.outputIndex,
          ts: utxo.timestamp ? Math.round(utxo.timestamp / 1000) : Math.round(Date.now() / 1000),
          scriptPubKey: utxo.script,
          amount: utxo.satoshis / 1e8,
          confirmations: utxo.confirmations
        };
      });

      return cb(null, transformed);
    });
  });
};

/**
 * Broadcast a transaction to the bitcoin network
 */
BitcoreNode.prototype.broadcast = function(rawTx, cb) {
  var self = this;

  this.connect(function() {
    self.socket.send({
      method: 'sendTransaction',
      params: [rawTx]
    }, function(response) {
      if(response.error) {
        return cb(new Error(response.error.message));
      }

      return cb(null, response.result);
    });
  });
};

BitcoreNode.prototype.getTransaction = function(txid, cb) {
  var self = this;

  this.connect(function() {
    self.socket.send({
      method: 'getTransaction',
      params: [txid, true]
    }, function(response) {
      if(response.error && response.error.message.match(/^NotFound/)) {
        return cb();
      } else if(response.error) {
        return cb(new Error(response.error.message));
      }

      // BWS only checks the txid on the result. Doesn't use anything else
      response.result.txid = response.result.hash;

      return cb(null, response.result);
    });
  });
};

BitcoreNode.prototype.getTransactions = function(addresses, from, to, cb) {
  var self = this;

  this.connect(function() {
  // TODO support from and to
    self.socket.send({
      method: 'getAddressHistory',
      params: [addresses, true]
    }, function(response) {
      if(response.error) {
        return cb(new Error(response.error.message));
      }

      return cb(null, response.result.map(self.transformAddressHistoryItem.bind(self)));
    });
  });
};

BitcoreNode.prototype.getAddressActivity = function(addresses, cb) {
  this.getTransactions(addresses, null, null, function(err, result) {
    if (err) return cb(err);
    return cb(null, result && result.length > 0);
  });
};

BitcoreNode.prototype.estimateFee = function(nbBlocks, cb) {
  var self = this;

  this.connect(function() {
    self.socket.send({
      method: 'estimateFee',
      params: [nbBlocks]
    }, function(response) {
      if(response.error) {
        return cb(new Error(response.error.message));
      }

      var obj = {
        feePerKB: response.result / 1e8
      };

      return cb(null, obj);
    });
  });
};

BitcoreNode.prototype.initSocket = function() {
  var self = this;

  // return a proxy EventEmitter

  var proxy = new EventEmitter();

  this.socket = io.connect(this.url, {
    'reconnection': true,
  });

  this.socket.on('connect', function() {
    var params = ['connect'].concat(Array.prototype.slice.call(arguments));
    proxy.emit.apply(proxy, params);
  });

  this.socket.on('connect_error', function() {
    var params = ['connect_error'].concat(Array.prototype.slice.call(arguments));
    proxy.emit.apply(proxy, params);
  });

  proxy.on('subscribe', function(data) {
    if(data === 'inv') {
      // Subscribe to all transactions
      self.socket.emit('subscribe', 'transaction');
      // Subscribe to block hashes
      self.socket.emit('subscribe', 'block');
    }
  });

  this.socket.on('transaction', function(obj) {
    proxy.emit('tx', self.transformTransaction(obj));
  });

  this.socket.on('block', function(hash) {
    proxy.emit('block', hash);
  });

  return proxy;
};

BitcoreNode.prototype.connect = function(callback) {
  var self = this;

  if(!this.socket) {
    this.socket = io.connect(this.url, {
      'reconnection': true
    });
  }

  async.until(
    function() {
      return self.socket.connected;
    },
    function(next) {
      setTimeout(next, 10);
    },
    callback
  );
};

BitcoreNode.prototype.transformAddressHistoryItem = function(item) {
  var transformed = {
    txid: item.tx.hash,
    version: item.tx.version,
    locktime: item.tx.nLockTime,
    vin: item.tx.inputs.map(this.transformInput.bind(this)),
    vout: [],
    confirmations: item.confirmations
  };

  for(var i = 0; i < item.tx.outputs.length; i++) {
    transformed.vout.push(this.transformOutput(item.tx.outputs[i], i));
  }

  return transformed;
};

BitcoreNode.prototype.transformTransaction = function(obj) {
  if(obj.rejected) {
    // Ignore transactions bitcoind rejected
    return null;
  }

  var transformed = {
    txid: obj.tx.hash,
    vout: []
  };

  var satoshis = 0;
  var addresses = {};

  for(var i = 0; i < obj.tx.outputs.length; i++) {
    var output = obj.tx.outputs[i];
    satoshis += output.satoshis;

    var address = bitcore.Script(output.script).toAddress(this.network).toString();
    if(address) {
      if(!addresses[address]) {
        addresses[address] = 0;
      }

      addresses[address] += output.satoshis;
    }
  }

  for(var key in addresses) {
    var vout = {};
    vout[key] = addresses[key];
    transformed.vout.push(vout);
  }

  transformed.valueOut = satoshis / 1e8;

  return transformed;
};

BitcoreNode.prototype.transformInput = function(input) {
  var transformed = {
    txid: input.prevTxId,
    vout: input.outputIndex,
    scriptSig: {
      hex: input.script
    },
    sequence: input.sequenceNumber
  };

  if(input.output) {
    transformed.addr = bitcore.Script(input.output.script).toAddress(this.network).toString();
    transformed.valueSat = input.output.satoshis;
    transformed.value = input.output.satoshis / 1e8;
    transformed.doubleSpentTxID = null;
  }

  return transformed;
};

BitcoreNode.prototype.transformOutput = function(output, index) {
  var address = bitcore.Script(output.script).toAddress(this.network).toString();
  return {
    value: output.satoshis / 1e8,
    n: index,
    scriptPubKey: {
      hex: output.script,
      addresses: [address]
    },
    address: address
  };
};

module.exports = BitcoreNode;
