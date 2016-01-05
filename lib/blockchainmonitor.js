'use strict';

var $ = require('preconditions').singleton();
var _ = require('lodash');
var async = require('async');
var log = require('npmlog');
log.debug = log.verbose;

var BlockchainExplorer = require('./blockchainexplorer');
var Storage = require('./storage');
var MessageBroker = require('./messagebroker');
var Lock = require('./lock');

var Notification = require('./model/notification');

function BlockchainMonitor() {};

BlockchainMonitor.prototype.start = function(opts, cb) {
  opts = opts || {};

  var self = this;

  async.parallel([

    function(done) {
      self.explorers = _.zipObject(_.map(['livenet', 'testnet'], function(network) {
        var explorer;
        if (opts.blockchainExplorers) {
          explorer = opts.blockchainExplorers[network];
        } else {
          var config = {}
          if (opts.blockchainExplorerOpts && opts.blockchainExplorerOpts[network]) {
            config = opts.blockchainExplorerOpts[network];
          }
          var explorer = new BlockchainExplorer({
            provider: config.provider,
            network: network,
            url: config.url,
          });
        }
        $.checkState(explorer);
        self._initExplorer(explorer);
        return [network, explorer];
      }));
      done();
    },
    function(done) {
      if (opts.storage) {
        self.storage = opts.storage;
        done();
      } else {
        self.storage = new Storage();
        self.storage.connect(opts.storageOpts, done);
      }
    },
    function(done) {
      self.messageBroker = opts.messageBroker || new MessageBroker(opts.messageBrokerOpts);
      done();
    },
    function(done) {
      self.lock = opts.lock || new Lock(opts.lockOpts);
      done();
    },
  ], function(err) {
    if (err) {
      log.error(err);
    }
    return cb(err);
  });
};

BlockchainMonitor.prototype._initExplorer = function(explorer) {
  var self = this;

  var socket = explorer.initSocket();

  socket.on('connect', function() {
    log.info('Connected to ' + explorer.getConnectionInfo());
    socket.emit('subscribe', 'inv');
  });
  socket.on('connect_error', function() {
    log.error('Error connecting to ' + explorer.getConnectionInfo());
  });
  socket.on('tx', _.bind(self._handleIncomingTx, self));
  socket.on('block', _.bind(self._handleNewBlock, self, explorer.network));
};

BlockchainMonitor.prototype._handleTxId = function(data, processIt) {
  var self = this;
  if (!data || !data.txid) return;

  self.storage.fetchTxByHash(data.txid, function(err, txp) {
    if (err) {
      log.error('Could not fetch tx from the db');
      return;
    }
    if (!txp || txp.status != 'accepted') return;

    var walletId = txp.walletId;

    if (!processIt) {
      log.info('Detected broadcast ' + data.txid + ' of an accepted txp [' + txp.id + '] for wallet ' + walletId + ' [' + txp.amount + 'sat ]');
      return setTimeout(self._handleTxId.bind(self, data, true), 20 * 1000);
    }

    log.info('Processing accepted txp [' + txp.id + '] for wallet ' + walletId + ' [' + txp.amount + 'sat ]');

    txp.setBroadcasted();
    self.storage.storeTx(self.walletId, txp, function(err) {
      if (err)
        log.error('Could not save TX');

      var args = {
        txProposalId: txp.id,
        txid: data.txid,
        amount: txp.getTotalAmount(),
      };

      var notification = Notification.create({
        type: 'NewOutgoingTxByThirdParty',
        data: args,
        walletId: walletId,
      });
      self._storeAndBroadcastNotification(notification);
    });
  });
};

var _incomingTxQueue = [];

BlockchainMonitor.prototype._notify = function(data, cb) {
  var self = this;

  var notification = Notification.create({
    type: 'NewIncomingTx',
    data: {
      txid: data.txid,
      address: data.address,
      amount: data.amount,
    },
    walletId: data.walletId,
  });
  self._updateActiveAddresses(data.walletId, data.address, function() {
    self._storeAndBroadcastNotification(notification, cb);
  });
};

BlockchainMonitor.prototype._processIncomingTxQueue = function(cb) {
  var self = this;

  var processed = [];

  function notify(tx, cb) {
    self._notify(tx, function(err) {
      if (err) return cb(err);
      processed.push(tx);
      return cb();
    });
  };

  async.each(_incomingTxQueue, function(tx, next) {
    if (tx.isRBF) {
      self.explorers[tx.network].getTransaction(tx.txid, function(err, transaction) {
        if (err) return next(err);
        if (transaction && transaction.confirmations > 0) return notify(tx, next);
      });
    } else {
      return notify(tx, next);
    }
  }, function(err) {
    _incomingTxQueue = _.difference(_incomingTxQueue, processed);
    return cb(err);
  });
};

BlockchainMonitor.prototype._handleTxOuts = function(data, cb) {
  var self = this;

  if (!data || !data.vout) return;
  cb = cb || function() {};

  var outs = _.compact(_.map(data.vout, function(v) {
    var addr = _.keys(v)[0];

    return {
      address: addr,
      amount: +v[addr]
    };
  }));
  if (_.isEmpty(outs)) return;

  async.each(outs, function(out, next) {
    self.storage.fetchAddress(out.address, function(err, address) {
      if (err) {
        log.error('Could not fetch addresses from the db');
        return next(err);
      }
      if (!address || address.isChange) return next();

      var walletId = address.walletId;
      log.info('Incoming tx for wallet ' + walletId + ' [' + out.amount + 'sat -> ' + out.address + ']');

      var tx = {
        walletId: walletId,
        txid: data.txid,
        address: out.address,
        amount: out.amount,
        network: address.network,
        isRBF: data.isRBF,
      };

      if (tx.isRBF) {
        _incomingTxQueue.push(tx);
        next();
      } else {
        self._notify(tx, next);
      }
    });
  }, cb);
};

BlockchainMonitor.prototype._updateActiveAddresses = function(walletId, address, cb) {
  var self = this;

  self.storage.storeActiveAddresses(walletId, address, function(err) {
    if (err) {
      log.warn('Could not update wallet cache', err);
    }
    return cb(err);
  });
};

BlockchainMonitor.prototype._handleIncomingTx = function(data) {
  this._handleTxId(data);
  this._handleTxOuts(data);
};

BlockchainMonitor.prototype._handleNewBlock = function(network, hash, cb) {
  var self = this;

  cb = cb || function() {};

  log.info('New ' + network + ' block: ', hash);
  var notification = Notification.create({
    type: 'NewBlock',
    walletId: network, // use network name as wallet id for global notifications
    data: {
      hash: hash,
    },
  });
  self._storeAndBroadcastNotification(notification, function(err) {
    return self._processIncomingTxQueue(cb);
  });
};

BlockchainMonitor.prototype._storeAndBroadcastNotification = function(notification, cb) {
  var self = this;

  self.storage.storeNotification(notification.walletId, notification, function() {
    self.messageBroker.send(notification)
    if (cb) return cb();
  });
};

module.exports = BlockchainMonitor;
