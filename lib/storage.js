'use strict';

var _ = require('lodash');
var async = require('async');
var $ = require('preconditions').singleton();
var log = require('npmlog');
log.debug = log.verbose;
log.disableColor();
var util = require('util');

var mongodb = require('mongodb');

var Model = require('./model');

var collections = {
  WALLETS: 'wallets',
  TXS: 'txs',
  ADDRESSES: 'addresses',
  NOTIFICATIONS: 'notifications',
  COPAYERS_LOOKUP: 'copayers_lookup',
  PREFERENCES: 'preferences',
  EMAIL_QUEUE: 'email_queue',
  CACHE: 'cache',
  FIAT_RATES: 'fiat_rates',
  TX_NOTES: 'tx_notes',
  SESSIONS: 'sessions',
  PUSH_NOTIFICATION_SUBS: 'push_notification_subs',
};

var Storage = function(opts) {
  opts = opts || {};
  this.db = opts.db;
};

Storage.prototype._createIndexes = function() {
  this.db.collection(collections.WALLETS).createIndex({
    id: 1
  });
  this.db.collection(collections.COPAYERS_LOOKUP).createIndex({
    copayerId: 1
  });
  this.db.collection(collections.TXS).createIndex({
    walletId: 1,
    id: 1,
  });
  this.db.collection(collections.TXS).createIndex({
    walletId: 1,
    isPending: 1,
    txid: 1,
  });
  this.db.collection(collections.TXS).createIndex({
    walletId: 1,
    createdOn: -1,
  });
  this.db.collection(collections.NOTIFICATIONS).createIndex({
    walletId: 1,
    id: 1,
  });
  this.db.collection(collections.ADDRESSES).createIndex({
    walletId: 1,
    createdOn: 1,
  });
  this.db.collection(collections.ADDRESSES).createIndex({
    address: 1,
  });
  this.db.collection(collections.EMAIL_QUEUE).createIndex({
    notificationId: 1,
  });
  this.db.collection(collections.CACHE).createIndex({
    walletId: 1,
    type: 1,
    key: 1,
  });
  this.db.collection(collections.TX_NOTES).createIndex({
    walletId: 1,
    txid: 1,
  });
  this.db.collection(collections.PUSH_NOTIFICATION_SUBS).createIndex({
    copayerId: 1,
  });
};

Storage.prototype.connect = function(opts, cb) {
  var self = this;

  opts = opts || {};

  if (this.db) return cb();

  var config = opts.mongoDb || {};
  mongodb.MongoClient.connect(config.uri, function(err, db) {
    if (err) {
      log.error('Unable to connect to the mongoDB. Check the credentials.');
      return cb(err);
    }
    self.db = db;
    self._createIndexes();
    console.log('Connection established to mongoDB');
    return cb();
  });
};


Storage.prototype.disconnect = function(cb) {
  var self = this;
  this.db.close(true, function(err) {
    if (err) return cb(err);
    self.db = null;
    return cb();
  });
};

Storage.prototype.fetchWallet = function(id, cb) {
  this.db.collection(collections.WALLETS).findOne({
    id: id
  }, function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();
    return cb(null, Model.Wallet.fromObj(result));
  });
};

Storage.prototype.storeWallet = function(wallet, cb) {
  this.db.collection(collections.WALLETS).update({
    id: wallet.id
  }, wallet.toObject(), {
    w: 1,
    upsert: true,
  }, cb);
};

Storage.prototype.storeWalletAndUpdateCopayersLookup = function(wallet, cb) {
  var self = this;

  var copayerLookups = _.map(wallet.copayers, function(copayer) {
    $.checkState(copayer.requestPubKeys);
    return {
      copayerId: copayer.id,
      walletId: wallet.id,
      requestPubKeys: copayer.requestPubKeys,
    };
  });

  this.db.collection(collections.COPAYERS_LOOKUP).remove({
    walletId: wallet.id
  }, {
    w: 1
  }, function(err) {
    if (err) return cb(err);
    self.db.collection(collections.COPAYERS_LOOKUP).insert(copayerLookups, {
      w: 1
    }, function(err) {
      if (err) return cb(err);
      return self.storeWallet(wallet, cb);
    });
  });
};

Storage.prototype.fetchCopayerLookup = function(copayerId, cb) {

  this.db.collection(collections.COPAYERS_LOOKUP).findOne({
    copayerId: copayerId
  }, function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();

    if (!result.requestPubKeys) {
      result.requestPubKeys = [{
        key: result.requestPubKey,
        signature: result.signature,
      }];
    }

    return cb(null, result);
  });
};

// TODO: should be done client-side
Storage.prototype._completeTxData = function(walletId, txs, cb) {
  var self = this;

  self.fetchWallet(walletId, function(err, wallet) {
    if (err) return cb(err);
    _.each([].concat(txs), function(tx) {
      tx.derivationStrategy = wallet.derivationStrategy || 'BIP45';
      tx.creatorName = wallet.getCopayer(tx.creatorId).name;
      _.each(tx.actions, function(action) {
        action.copayerName = wallet.getCopayer(action.copayerId).name;
      });

      if (tx.status == 'accepted')
        tx.raw = tx.getRawTx();

    });
    return cb(null, txs);
  });
};

// TODO: remove walletId from signature
Storage.prototype.fetchTx = function(walletId, txProposalId, cb) {
  var self = this;

  this.db.collection(collections.TXS).findOne({
    id: txProposalId,
    walletId: walletId
  }, function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();
    return self._completeTxData(walletId, Model.TxProposal.fromObj(result), cb);
  });
};

Storage.prototype.fetchTxByHash = function(hash, cb) {
  var self = this;

  this.db.collection(collections.TXS).findOne({
    txid: hash,
  }, function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();

    return self._completeTxData(result.walletId, Model.TxProposal.fromObj(result), cb);
  });
};

Storage.prototype.fetchLastTxs = function(walletId, creatorId, limit, cb) {
  var self = this;

  this.db.collection(collections.TXS).find({
    walletId: walletId,
    creatorId: creatorId,
  }, {
    limit: limit || 5
  }).sort({
    createdOn: -1
  }).toArray(function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();
    var txs = _.map(result, function(tx) {
      return Model.TxProposal.fromObj(tx);
    });
    return cb(null, txs);
  });
};



Storage.prototype.fetchPendingTxs = function(walletId, cb) {
  var self = this;

  self.db.collection(collections.TXS).find({
    walletId: walletId,
    isPending: true,
  }).sort({
    createdOn: -1
  }).toArray(function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();
    var txs = _.map(result, function(tx) {
      return Model.TxProposal.fromObj(tx);
    });
    return self._completeTxData(walletId, txs, cb);
  });
};

/**
 * fetchTxs. Times are in UNIX EPOCH (seconds)
 *
 * @param walletId
 * @param opts.minTs
 * @param opts.maxTs
 * @param opts.limit
 */
Storage.prototype.fetchTxs = function(walletId, opts, cb) {
  var self = this;

  opts = opts || {};

  var tsFilter = {};
  if (_.isNumber(opts.minTs)) tsFilter.$gte = opts.minTs;
  if (_.isNumber(opts.maxTs)) tsFilter.$lte = opts.maxTs;

  var filter = {
    walletId: walletId
  };
  if (!_.isEmpty(tsFilter)) filter.createdOn = tsFilter;

  var mods = {};
  if (_.isNumber(opts.limit)) mods.limit = opts.limit;

  this.db.collection(collections.TXS).find(filter, mods).sort({
    createdOn: -1
  }).toArray(function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();
    var txs = _.map(result, function(tx) {
      return Model.TxProposal.fromObj(tx);
    });
    return self._completeTxData(walletId, txs, cb);
  });
};

/**
 * fetchBroadcastedTxs. Times are in UNIX EPOCH (seconds)
 *
 * @param walletId
 * @param opts.minTs
 * @param opts.maxTs
 * @param opts.limit
 */
Storage.prototype.fetchBroadcastedTxs = function(walletId, opts, cb) {
  var self = this;

  opts = opts || {};

  var tsFilter = {};
  if (_.isNumber(opts.minTs)) tsFilter.$gte = opts.minTs;
  if (_.isNumber(opts.maxTs)) tsFilter.$lte = opts.maxTs;

  var filter = {
    walletId: walletId,
    status: 'broadcasted',
  };
  if (!_.isEmpty(tsFilter)) filter.broadcastedOn = tsFilter;

  var mods = {};
  if (_.isNumber(opts.limit)) mods.limit = opts.limit;

  this.db.collection(collections.TXS).find(filter, mods).sort({
    createdOn: -1
  }).toArray(function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();
    var txs = _.map(result, function(tx) {
      return Model.TxProposal.fromObj(tx);
    });
    return self._completeTxData(walletId, txs, cb);
  });
};

/**
 * fetchTxs. Times are in UNIX EPOCH (seconds)
 *
 * @param walletId
 * @param txids
 */
Storage.prototype.fetchTxsByTxid = function(walletId, txids, cb) {
  var self = this;

  txids = [].concat(txids);

  this.db.collection(collections.TXS).find({
    walletId: walletId,
    txid: {
      $in: txids
    }
  }).toArray(function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();
    var txs = _.map(result, function(tx) {
      return Model.TxProposal.fromObj(tx);
    });
    return self._completeTxData(walletId, txs, cb);
  });
};


/**
 * Retrieves notifications after a specific id or from a given ts (whichever is more recent).
 *
 * @param {String} notificationId
 * @param {Number} minTs
 * @returns {Notification[]} Notifications
 */
Storage.prototype.fetchNotifications = function(walletId, notificationId, minTs, cb) {
  function makeId(timestamp) {
    return _.padLeft(timestamp, 14, '0') + _.repeat('0', 4);
  };

  var self = this;

  var minId = makeId(minTs);
  if (notificationId) {
    minId = notificationId > minId ? notificationId : minId;
  }

  this.db.collection(collections.NOTIFICATIONS)
    .find({
      walletId: walletId,
      id: {
        $gt: minId,
      },
    })
    .sort({
      id: 1
    })
    .toArray(function(err, result) {
      if (err) return cb(err);
      if (!result) return cb();
      var notifications = _.map(result, function(notification) {
        return Model.Notification.fromObj(notification);
      });
      return cb(null, notifications);
    });
};

// TODO: remove walletId from signature
Storage.prototype.storeNotification = function(walletId, notification, cb) {
  this.db.collection(collections.NOTIFICATIONS).insert(notification, {
    w: 1
  }, cb);
};

// TODO: remove walletId from signature
Storage.prototype.storeTx = function(walletId, txp, cb) {
  this.db.collection(collections.TXS).update({
    id: txp.id,
    walletId: walletId
  }, txp.toObject(), {
    w: 1,
    upsert: true,
  }, cb);
};

Storage.prototype.removeTx = function(walletId, txProposalId, cb) {
  this.db.collection(collections.TXS).findAndRemove({
    id: txProposalId,
    walletId: walletId
  }, {
    w: 1
  }, cb);
};

Storage.prototype.removeWallet = function(walletId, cb) {
  var self = this;

  async.parallel([

    function(next) {
      self.db.collection(collections.WALLETS).findAndRemove({
        id: walletId
      }, next);
    },
    function(next) {
      var otherCollections = _.without(_.values(collections), collections.WALLETS);
      async.each(otherCollections, function(col, next) {
        self.db.collection(col).remove({
          walletId: walletId
        }, next);
      }, next);
    },
  ], cb);
};


Storage.prototype.fetchAddresses = function(walletId, addressStrs, cb) {
  var self = this;

  if (_.isFunction(addressStrs)) {
    cb = addressStrs;
    addressStrs = null;
  }

  var filter = {
    walletId: walletId,
  };
  if (!_.isEmpty(addressStrs)) {
    filter.address = {
      $in: [].concat(addressStrs)
    };
  }

  this.db.collection(collections.ADDRESSES).find(filter).sort({
    createdOn: 1
  }).toArray(function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();
    var addresses = _.map(result, function(address) {
      return Model.Address.fromObj(address);
    });
    return cb(null, addresses);
  });
};

Storage.prototype.fetchAddressStrs = function(walletId, cb) {
  var self = this;

  this.db.collection(collections.ADDRESSES).find({
    walletId: walletId,
  }, {
    address: true
  }).toArray(function(err, res) {
    if (err) return cb(err);
    return cb(null, _.pluck(res, 'address'));
  });
};

Storage.prototype.fetchUnregisteredAddressStrs = function(walletId, cb) {
  var self = this;

  this.db.collection(collections.ADDRESSES).find({
    walletId: walletId,
    registeredAtAddressServiceOn: null,
  }, {
    address: true
  }).toArray(function(err, res) {
    if (err) return cb(err);
    return cb(null, _.pluck(res, 'address'));
  });
};

Storage.prototype.countAddresses = function(walletId, cb) {
  this.db.collection(collections.ADDRESSES).find({
    walletId: walletId,
  }).count(cb);
};

Storage.prototype.storeAddress = function(address, cb) {
  var self = this;

  self.db.collection(collections.ADDRESSES).update({
    address: address.address
  }, address, {
    w: 1,
    upsert: false,
  }, cb);
};

Storage.prototype.storeAddressAndWallet = function(wallet, addresses, cb) {
  var self = this;

  var addresses = [].concat(addresses);
  if (addresses.length == 0) return cb();

  async.filter(addresses, function(address, next) {
    self.db.collection(collections.ADDRESSES).findOne({
      address: address.address,
    }, {
      walletId: true,
    }, function(err, result) {
      if (err || !result) return next(true);
      if (result.walletId != wallet.id) {
        log.warn('Address ' + address.address + ' exists in more than one wallet.');
        return next(true);
      }
      // Ignore if address was already in wallet
      return next(false);
    });
  }, function(newAddresses) {
    if (newAddresses.length == 0) return cb();
    self.db.collection(collections.ADDRESSES).insert(newAddresses, {
      w: 1
    }, function(err) {
      if (err) return cb(err);
      self.storeWallet(wallet, cb);
    });
  });
};

Storage.prototype.updateWalletAddressServiceId = function(walletId, groupId, cb) {
  var self = this;

  self.db.collection(collections.WALLETS).update({
    id: walletId,
  }, {
    $set: {
      addressServiceId: groupId
    },
  }, {
    w: 1,
    upsert: false,
  }, cb);
};

Storage.prototype.updateAddressesAddressServiceId = function(walletId, addressStrs, cb) {
  var self = this;

  var now = Math.floor(Date.now() / 1000);

  var addresses = _.compact([].concat(addressStrs));

  async.eachLimit(addresses, 10, function(address, next) {
    self.db.collection(collections.ADDRESSES).update({
      walletId: walletId,
      address: address,
    }, {
      $set: {
        registeredAtAddressServiceOn: now
      },
    }, {
      w: 1,
      upsert: false,
    }, next);
  }, cb);
};

Storage.prototype.fetchAddress = function(address, cb) {
  var self = this;

  this.db.collection(collections.ADDRESSES).findOne({
    address: address,
  }, function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();

    return cb(null, Model.Address.fromObj(result));
  });
};

Storage.prototype.fetchPreferences = function(walletId, copayerId, cb) {
  this.db.collection(collections.PREFERENCES).find({
    walletId: walletId,
  }).toArray(function(err, result) {
    if (err) return cb(err);

    if (copayerId) {
      result = _.find(result, {
        copayerId: copayerId
      });
    }
    if (!result) return cb();

    var preferences = _.map([].concat(result), function(r) {
      return Model.Preferences.fromObj(r);
    });
    if (copayerId) {
      preferences = preferences[0];
    }
    return cb(null, preferences);
  });
};

Storage.prototype.storePreferences = function(preferences, cb) {
  this.db.collection(collections.PREFERENCES).update({
    walletId: preferences.walletId,
    copayerId: preferences.copayerId,
  }, preferences, {
    w: 1,
    upsert: true,
  }, cb);
};

Storage.prototype.storeEmail = function(email, cb) {
  this.db.collection(collections.EMAIL_QUEUE).update({
    id: email.id,
  }, email, {
    w: 1,
    upsert: true,
  }, cb);
};

Storage.prototype.fetchUnsentEmails = function(cb) {
  this.db.collection(collections.EMAIL_QUEUE).find({
    status: 'pending',
  }).toArray(function(err, result) {
    if (err) return cb(err);
    if (!result || _.isEmpty(result)) return cb(null, []);
    return cb(null, Model.Email.fromObj(result));
  });
};

Storage.prototype.fetchEmailByNotification = function(notificationId, cb) {
  this.db.collection(collections.EMAIL_QUEUE).findOne({
    notificationId: notificationId,
  }, function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();

    return cb(null, Model.Email.fromObj(result));
  });
};

Storage.prototype.storeFiatRate = function(providerName, rates, cb) {
  var self = this;

  var now = Date.now();
  async.each(rates, function(rate, next) {
    self.db.collection(collections.FIAT_RATES).insert({
      provider: providerName,
      ts: now,
      code: rate.code,
      value: rate.value,
    }, {
      w: 1
    }, next);
  }, cb);
};

Storage.prototype.fetchFiatRate = function(providerName, code, ts, cb) {
  var self = this;
  self.db.collection(collections.FIAT_RATES).find({
    provider: providerName,
    code: code,
    ts: {
      $lte: ts
    },
  }).sort({
    ts: -1
  }).limit(1).toArray(function(err, result) {
    if (err || _.isEmpty(result)) return cb(err);
    return cb(null, result[0]);
  });
};

Storage.prototype.fetchTxNote = function(walletId, txid, cb) {
  var self = this;

  self.db.collection(collections.TX_NOTES).findOne({
    walletId: walletId,
    txid: txid,
  }, function(err, result) {
    if (err) return cb(err);
    if (!result) return cb();
    return self._completeTxNotesData(walletId, Model.TxNote.fromObj(result), cb);
  });
};

// TODO: should be done client-side
Storage.prototype._completeTxNotesData = function(walletId, notes, cb) {
  var self = this;

  self.fetchWallet(walletId, function(err, wallet) {
    if (err) return cb(err);
    _.each([].concat(notes), function(note) {
      note.editedByName = wallet.getCopayer(note.editedBy).name;
    });
    return cb(null, notes);
  });
};

/**
 * fetchTxNotes. Times are in UNIX EPOCH (seconds)
 *
 * @param walletId
 * @param opts.minTs
 */
Storage.prototype.fetchTxNotes = function(walletId, opts, cb) {
  var self = this;

  var filter = {
    walletId: walletId,
  };
  if (_.isNumber(opts.minTs)) filter.editedOn = {
    $gte: opts.minTs
  };
  this.db.collection(collections.TX_NOTES).find(filter).toArray(function(err, result) {
    if (err) return cb(err);
    var notes = _.compact(_.map(result, function(note) {
      return Model.TxNote.fromObj(note);
    }));
    return self._completeTxNotesData(walletId, notes, cb);
  });
};

Storage.prototype.storeTxNote = function(txNote, cb) {
  this.db.collection(collections.TX_NOTES).update({
    txid: txNote.txid,
    walletId: txNote.walletId
  }, txNote.toObject(), {
    w: 1,
    upsert: true,
  }, cb);
};

Storage.prototype.getSession = function(copayerId, cb) {
  var self = this;

  self.db.collection(collections.SESSIONS).findOne({
      copayerId: copayerId,
    },
    function(err, result) {
      if (err || !result) return cb(err);
      return cb(null, Model.Session.fromObj(result));
    });
};

Storage.prototype.storeSession = function(session, cb) {
  this.db.collection(collections.SESSIONS).update({
    copayerId: session.copayerId,
  }, session.toObject(), {
    w: 1,
    upsert: true,
  }, cb);
};

Storage.prototype.fetchPushNotificationSubs = function(copayerId, cb) {
  this.db.collection(collections.PUSH_NOTIFICATION_SUBS).find({
    copayerId: copayerId,
  }).toArray(function(err, result) {
    if (err) return cb(err);

    if (!result) return cb();

    var tokens = _.map([].concat(result), function(r) {
      return Model.PushNotificationSub.fromObj(r);
    });
    return cb(null, tokens);
  });
};

Storage.prototype.storePushNotificationSub = function(pushNotificationSub, cb) {
  this.db.collection(collections.PUSH_NOTIFICATION_SUBS).update({
    copayerId: pushNotificationSub.copayerId,
    token: pushNotificationSub.token,
  }, pushNotificationSub, {
    w: 1,
    upsert: true,
  }, cb);
};

Storage.prototype.removePushNotificationSub = function(copayerId, token, cb) {
  this.db.collection(collections.PUSH_NOTIFICATION_SUBS).remove({
    copayerId: copayerId,
    token: token,
  }, {
    w: 1
  }, cb);
};

Storage.prototype._dump = function(cb, fn) {
  fn = fn || console.log;
  cb = cb || function() {};

  var self = this;
  this.db.collections(function(err, collections) {
    if (err) return cb(err);
    async.eachSeries(collections, function(col, next) {
      col.find().toArray(function(err, items) {
        fn('--------', col.s.name);
        fn(items);
        fn('------------------------------------------------------------------\n\n');
        next(err);
      });
    }, cb);
  });
};

Storage.collections = collections;
module.exports = Storage;
