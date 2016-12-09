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
var Bitcore = require('bitcore-lib');

var Notification = require('./model/notification');

var WalletService = require('./server');

function BlockchainMonitor() {};

BlockchainMonitor.prototype.start = function(opts, cb) {
  opts = opts || {};

  var self = this;

  async.parallel([

    function(done) {
      self.explorers = _.object(_.map(['livenet', 'testnet'], function(network) {
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
            userAgent: WalletService.getServiceVersion(),
          });
        }
        $.checkState(explorer);
        self._initExplorer(explorer, network);
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

BlockchainMonitor.prototype._initExplorer = function(explorer, network) {
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
  socket.on('block', _.bind(self._handleNewBlock, self, network));
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

    self.storage.softResetTxHistoryCache(walletId, function() {
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
  });
};



BlockchainMonitor.prototype._handleTxOuts = function(data) {
  var self = this;

  if (!data || !data.vout) return;

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

      var notification = Notification.create({
        type: 'NewIncomingTx',
        data: {
          txid: data.txid,
          address: out.address,
          amount: out.amount,
        },
        walletId: walletId,
      });
      self.storage.softResetTxHistoryCache(walletId, function() {
        self.storage.updateLastUsedOn(out.address, function() {
          self._storeAndBroadcastNotification(notification, next);
        });
      });
    });
  }, function(err) {
    return;
  });
};


BlockchainMonitor.prototype._processBlockData = function(network, data, cb) {
  var self = this;

  var block = new Bitcore.Block(new Buffer(data.rawblock, 'hex'));
  log.debug('Processing block ' + network + ' ' + block.hash);

  var txs = block.toObject().transactions;

  var allAddresses = {};
  _.each(txs, function(tx) {
    _.each(tx.outputs, function(o) {
      if (o.script) {
        var s = new Bitcore.Script(new Buffer(o.script, 'hex'));
        var a = s.toAddress(network);
        if (a) {
          allAddresses[a] = true;
        }
      }
    });
  });
  allAddresses = _.keys(allAddresses);

  async.eachLimit(allAddresses, 10, function(address, i_cb) {
    self.storage.updateLastUsedOn(address, i_cb);
  }, function(err) {
    if (err) return cb(err);

    return cb(null, block);
  });
};




BlockchainMonitor.prototype._fetchAndProcessBlock = function(network, hash, cb) {
  var self = this;

  this.explorers[network].getBlock(hash, function(err, data) {
    if (err) return cb(err);
    self._processBlockData(network, data, cb);
  });
};


BlockchainMonitor.prototype._processBlockchainSince = function(network, hash, cb) {
  var self = this;

  self.storage.getTip(network, function(err, data) {
    if (err) return cb(err);

    if (!data) {
      log.error('No Tip recorded for ' + network);
      return cb('No Tip recorded');
    }

    var tip = data.hash;

    log.debug('', 'Last processed tip for %s was: %s on ', network, tip, (new Date(1000*data.updateOn)).toString() );

    self._fetchAndProcessBlock(network, hash, function(err, block){
      if (err) return cb(err);

      // TODO CRITICAL
      if (!block) {
        log.error('', 'Block from notification no found! %s %s', network, hash);
        return cb('Block not found!');
      };

      var header = block.header.toObject();

      if (header.prevHash != tip) {
        log.info ('', 'Notified block\'s prevhash does not match stored hash... Processing');
      } else {
        self.storage.updateTip(network, hash, cb);
      }
    });
  });

};

BlockchainMonitor.prototype._handleIncomingTx = function(data) {
  this._handleTxId(data);
  this._handleTxOuts(data);
};

BlockchainMonitor.prototype._handleNewBlock = function(network, hash) {
  var self = this;

  log.info('New ' + network + ' block: ', hash);
  var notification = Notification.create({
    type: 'NewBlock',
    walletId: network, // use network name as wallet id for global notifications
    data: {
      hash: hash,
      network: network,
    },
  });

  self._processBlockchainSince(network, hash, function() {
    self.storage.softResetAllTxHistoryCache(function() {
      self._storeAndBroadcastNotification(notification, function(err) {
        return;
      });
    });
  })
};

BlockchainMonitor.prototype._storeAndBroadcastNotification = function(notification, cb) {
  var self = this;

  self.storage.storeNotification(notification.walletId, notification, function() {
    self.messageBroker.send(notification)
    if (cb) return cb();
  });
};

module.exports = BlockchainMonitor;
