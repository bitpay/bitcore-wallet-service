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
  $.checkArgument(opts.blockchainExplorerOpts);
  $.checkArgument(opts.storageOpts);
  $.checkArgument(opts.messageBrokerOpts);
  $.checkArgument(opts.lockOpts);

  var self = this;

  async.parallel([

    function(done) {
      self.explorers = _.map(['livenet', 'testnet'], function(network) {
        var config = opts.blockchainExplorerOpts[network] || {};
        return self._initExplorer(config.provider, network, config.url);
      });
      done();
    },
    function(done) {
      self.storage = new Storage();
      self.storage.connect(opts.storageOpts, done);
    },
    function(done) {
      self.messageBroker = new MessageBroker(opts.messageBrokerOpts);
      done();
    },
    function(done) {
      self.lock = new Lock(opts.lockOpts);
      done();
    },
  ], function(err) {
    if (err) {
      log.error(err);
    }
    return cb(err);
  });
};

BlockchainMonitor.prototype._initExplorer = function(provider, network, url) {
  $.checkArgument(provider == 'insight', 'Blockchain monitor ' + provider + ' not supported');

  var self = this;

  var explorer = new BlockchainExplorer({
    provider: provider,
    network: network,
    url: url,
  });

  var socket = explorer.initSocket();

  var connectionInfo = provider + ' (' + network + ') @ ' + url;
  socket.on('connect', function() {
    log.info('Connected to ' + connectionInfo);
    socket.emit('subscribe', 'inv');
  });
  socket.on('connect_error', function() {
    log.error('Error connecting to ' + connectionInfo);
  });
  socket.on('tx', _.bind(self._handleIncommingTx, self));

  return explorer;
};

BlockchainMonitor.prototype._handleIncommingTx = function(data) {
  var self = this;

  if (!data || !data.vout) return;

  var outs = _.compact(_.map(data.vout, function(v) {
    var addr = _.keys(v)[0];
    var startingChar = addr.charAt(0);
    if (startingChar != '2' && startingChar != '3') return;

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
      self._createNotification(walletId, data.txid, out.address, out.amount, next);
    });
  }, function(err) {
    return;
  });
};

BlockchainMonitor.prototype._createNotification = function(walletId, txid, address, amount, cb) {
  var self = this;

  var notification = Notification.create({
    type: 'NewIncomingTx',
    data: {
      txid: txid,
      address: address,
      amount: amount,
    },
    walletId: walletId,
  });
  self.storage.storeNotification(walletId, notification, function() {
    self.messageBroker.send(notification)
    return cb();
  });
};

module.exports = BlockchainMonitor;
