'use strict';
var _ = require('lodash');
var $ = require('preconditions').singleton();
var async = require('async');
var log = require('npmlog');
log.debug = log.verbose;
log.disableColor();
var EmailValidator = require('email-validator');

var WalletUtils = require('bitcore-wallet-utils');
var Bitcore = WalletUtils.Bitcore;
var PublicKey = Bitcore.PublicKey;
var HDPublicKey = Bitcore.HDPublicKey;
var Address = Bitcore.Address;

var ClientError = require('./errors/clienterror');
var Errors = require('./errors/errordefinitions');

var Utils = require('./utils');
var Lock = require('./lock');
var Storage = require('./storage');
var MessageBroker = require('./messagebroker');
var BlockchainExplorer = require('./blockchainexplorer');

var Model = require('./model');
var Wallet = Model.Wallet;

var initialized = false;

var lock;
var storage;
var blockchainExplorer;
var blockchainExplorerOpts;
var messageBroker;

var MAX_KEYS = 100;

/**
 * Creates an instance of the Bitcore Wallet Service.
 * @constructor
 */
function WalletService() {
  if (!initialized)
    throw new Error('Server not initialized');

  this.lock = lock;
  this.storage = storage;
  this.blockchainExplorer = blockchainExplorer;
  this.blockchainExplorerOpts = blockchainExplorerOpts;
  this.messageBroker = messageBroker;
  this.notifyTicker = 0;
};


// Time after which a Tx proposal can be erased by any copayer. in seconds
WalletService.DELETE_LOCKTIME = 24 * 3600;

// Allowed consecutive txp rejections before backoff is applied.
WalletService.BACKOFF_OFFSET = 3;

// Time a copayer need to wait to create a new TX after her tx previous proposal we rejected. (incremental). in Minutes.
WalletService.BACKOFF_TIME = 2;

// Fund scanning parameters
WalletService.SCAN_CONFIG = {
  scanWindow: 20,
  derivationDelay: 10, // in milliseconds
};

WalletService.FEE_LEVELS = [{
  name: 'priority',
  nbBlocks: 1,
  defaultValue: 50000
}, {
  name: 'normal',
  nbBlocks: 2,
  defaultValue: 20000
}, {
  name: 'economy',
  nbBlocks: 6,
  defaultValue: 10000
}];


/**
 * Initializes global settings for all instances.
 * @param {Object} opts
 * @param {Storage} [opts.storage] - The storage provider.
 * @param {Storage} [opts.blockchainExplorer] - The blockchainExporer provider.
 * @param {Callback} cb
 */
WalletService.initialize = function(opts, cb) {
  $.shouldBeFunction(cb);

  opts = opts || {};
  lock = opts.lock || new Lock(opts.lockOpts);
  blockchainExplorer = opts.blockchainExplorer;
  blockchainExplorerOpts = opts.blockchainExplorerOpts;

  function initStorage(cb) {
    if (opts.storage) {
      storage = opts.storage;
      return cb();
    } else {
      var newStorage = new Storage();
      newStorage.connect(opts.storageOpts, function(err) {
        if (err) return cb(err);
        storage = newStorage;
        return cb();
      });
    }
  };

  function initMessageBroker(cb) {
    if (opts.messageBroker) {
      messageBroker = opts.messageBroker;
    } else {
      messageBroker = new MessageBroker(opts.messageBrokerOpts);
    }
    return cb();
  };

  async.series([

    function(next) {
      initStorage(next);
    },
    function(next) {
      initMessageBroker(next);
    },
  ], function(err) {
    if (err) {
      log.error('Could not initialize', err);
      throw err;
    }
    initialized = true;
    return cb();
  });
};


WalletService.shutDown = function(cb) {
  if (!initialized) return cb();
  storage.disconnect(function(err) {
    if (err) return cb(err);
    initialized = false;
    return cb();
  });
};

/**
 * Gets an instance of the server without authentication.
 * @param {Object} opts
 * @param {string} opts.clientVersion - A string that identifies the client issuing the request
 */
WalletService.getInstance = function(opts) {
  opts = opts || {};
  var server = new WalletService();
  server.clientVersion = opts.clientVersion;
  return server;
};

/**
 * Gets an instance of the server after authenticating the copayer.
 * @param {Object} opts
 * @param {string} opts.copayerId - The copayer id making the request.
 * @param {string} opts.message - The contents of the request to be signed.
 * @param {string} opts.signature - Signature of message to be verified using one of the copayer's requestPubKeys
 * @param {string} opts.clientVersion - A string that identifies the client issuing the request
 */
WalletService.getInstanceWithAuth = function(opts, cb) {
  if (!Utils.checkRequired(opts, ['copayerId', 'message', 'signature']))
    return cb(new ClientError('Required argument missing'));

  var server = new WalletService();
  server.storage.fetchCopayerLookup(opts.copayerId, function(err, copayer) {
    if (err) return cb(err);
    if (!copayer) return cb(new ClientError(Errors.codes.NOT_AUTHORIZED, 'Copayer not found'));

    var isValid = !!server._getSigningKey(opts.message, opts.signature, copayer.requestPubKeys);
    if (!isValid)
      return cb(new ClientError(Errors.codes.NOT_AUTHORIZED, 'Invalid signature'));

    server.copayerId = opts.copayerId;
    server.walletId = copayer.walletId;
    server.clientVersion = opts.clientVersion;
    return cb(null, server);
  });
};

WalletService.prototype._runLocked = function(cb, task) {
  $.checkState(this.walletId);
  this.lock.runLocked(this.walletId, cb, task);
};


/**
 * Creates a new wallet.
 * @param {Object} opts
 * @param {string} opts.id - The wallet id.
 * @param {string} opts.name - The wallet name.
 * @param {number} opts.m - Required copayers.
 * @param {number} opts.n - Total copayers.
 * @param {string} opts.pubKey - Public key to verify copayers joining have access to the wallet secret.
 * @param {string} [opts.network = 'livenet'] - The Bitcoin network for this wallet.
 * @param {string} [opts.supportBIP44 = false] - Client supports BIP44 paths for 1-of-1 wallets.
 */
WalletService.prototype.createWallet = function(opts, cb) {
  var self = this,
    pubKey;

  if (!Utils.checkRequired(opts, ['name', 'm', 'n', 'pubKey']))
    return cb(new ClientError('Required argument missing'));

  if (_.isEmpty(opts.name)) return cb(new ClientError('Invalid wallet name'));
  if (!Wallet.verifyCopayerLimits(opts.m, opts.n))
    return cb(new ClientError('Invalid combination of required copayers / total copayers'));

  opts.network = opts.network || 'livenet';
  if (!_.contains(['livenet', 'testnet'], opts.network))
    return cb(new ClientError('Invalid network'));

  var derivationStrategy = (opts.n == 1 && opts.supportBIP44) ?
    WalletUtils.DERIVATION_STRATEGIES.BIP44 : WalletUtils.DERIVATION_STRATEGIES.BIP45;

  try {
    pubKey = new PublicKey.fromString(opts.pubKey);
  } catch (ex) {
    return cb(new ClientError('Invalid public key'));
  };

  var newWallet;
  async.series([

    function(acb) {
      if (!opts.id)
        return acb();

      self.storage.fetchWallet(opts.id, function(err, wallet) {
        if (wallet) return acb(Errors.WALLET_ALREADY_EXISTS);
        return acb(err);
      });
    },
    function(acb) {
      var wallet = Wallet.create({
        id: opts.id,
        name: opts.name,
        m: opts.m,
        n: opts.n,
        network: opts.network,
        pubKey: pubKey.toString(),
        derivationStrategy: derivationStrategy,
      });
      self.storage.storeWallet(wallet, function(err) {
        log.debug('Wallet created', wallet.id, opts.network);
        newWallet = wallet;
        return acb(err);
      });
    }
  ], function(err) {
    return cb(err, newWallet ? newWallet.id : null);
  });
};

/**
 * Retrieves a wallet from storage.
 * @param {Object} opts
 * @returns {Object} wallet
 */
WalletService.prototype.getWallet = function(opts, cb) {
  var self = this;

  self.storage.fetchWallet(self.walletId, function(err, wallet) {
    if (err) return cb(err);
    if (!wallet) return cb(Errors.WALLET_NOT_FOUND);
    return cb(null, wallet);
  });
};

/**
 * Retrieves wallet status.
 * @param {Object} opts
 * @param {Object} opts.includeExtendedInfo - Include PKR info & address managers for wallet & copayers
 * @returns {Object} status
 */
WalletService.prototype.getStatus = function(opts, cb) {
  var self = this;

  opts = opts || {};

  var status = {};
  async.parallel([

    function(next) {
      self.getWallet({}, function(err, wallet) {
        if (err) return next(err);

        var walletExtendedKeys = ['publicKeyRing', 'pubKey', 'addressManager'];
        var copayerExtendedKeys = ['xPubKey', 'requestPubKey', 'signature', 'addressManager', 'customData'];

        wallet.copayers = _.map(wallet.copayers, function(copayer) {
          if (copayer.id == self.copayerId) return copayer;
          return _.omit(copayer, 'customData');
        });
        if (!opts.includeExtendedInfo) {
          wallet = _.omit(wallet, walletExtendedKeys);
          wallet.copayers = _.map(wallet.copayers, function(copayer) {
            return _.omit(copayer, copayerExtendedKeys);
          });
        }
        status.wallet = wallet;
        next();
      });
    },
    function(next) {
      self.getBalance({}, function(err, balance) {
        if (err) return next(err);
        status.balance = balance;
        next();
      });
    },
    function(next) {
      self.getPendingTxs({}, function(err, pendingTxps) {
        if (err) return next(err);
        status.pendingTxps = pendingTxps;
        next();
      });
    },
    function(next) {
      self.getPreferences({}, function(err, preferences) {
        if (err) return next(err);
        status.preferences = preferences;
        next();
      });
    },
  ], function(err) {
    if (err) return cb(err);
    return cb(null, status);
  });
};

/*
 * Verifies a signature
 * @param text
 * @param signature
 * @param pubKeys
 */
WalletService.prototype._verifySignature = function(text, signature, pubkey) {
  return WalletUtils.verifyMessage(text, signature, pubkey);
};


/*
 * Verifies signature againt a collection of pubkeys
 * @param text
 * @param signature
 * @param pubKeys
 */
WalletService.prototype._getSigningKey = function(text, signature, pubKeys) {
  var self = this;
  return _.find(pubKeys, function(item) {
    return self._verifySignature(text, signature, item.key);
  });
};

/**
 * _notify
 *
 * @param {String} type
 * @param {Object} data
 * @param {Object} opts
 * @param {Boolean} opts.isGlobal - If true, the notification is not issued on behalf of any particular copayer (defaults to false)
 */
WalletService.prototype._notify = function(type, data, opts, cb) {
  var self = this;

  if (_.isFunction(opts)) {
    cb = opts;
    opts = {};
  }
  opts = opts || {};

  log.debug('Notification', type, data);

  cb = cb || function() {};

  var walletId = self.walletId || data.walletId;
  var copayerId = self.copayerId || data.copayerId;

  $.checkState(walletId);

  var notification = Model.Notification.create({
    type: type,
    data: data,
    ticker: this.notifyTicker++,
    creatorId: opts.isGlobal ? null : copayerId,
    walletId: walletId,
  });

  this.storage.storeNotification(walletId, notification, function() {
    self.messageBroker.send(notification);
    return cb();
  });
};


WalletService.prototype._addCopayerToWallet = function(wallet, opts, cb) {
  var self = this;

  if (wallet.copayers.length == wallet.n) return cb(Errors.WALLET_FULL);

  var copayer = Model.Copayer.create({
    name: opts.name,
    copayerIndex: wallet.copayers.length,
    xPubKey: opts.xPubKey,
    requestPubKey: opts.requestPubKey,
    signature: opts.copayerSignature,
    customData: opts.customData,
    derivationStrategy: wallet.derivationStrategy,
  });
  self.storage.fetchCopayerLookup(copayer.id, function(err, res) {
    if (err) return cb(err);
    if (res) return cb(Errors.COPAYER_REGISTERED);

    wallet.addCopayer(copayer);
    self.storage.storeWalletAndUpdateCopayersLookup(wallet, function(err) {
      if (err) return cb(err);

      async.series([

        function(next) {
          self._notify('NewCopayer', {
            walletId: opts.walletId,
            copayerId: copayer.id,
            copayerName: copayer.name,
          }, next);
        },
        function(next) {
          if (wallet.isComplete() && wallet.isShared()) {
            self._notify('WalletComplete', {
              walletId: opts.walletId,
            }, {
              isGlobal: true
            }, next);
          } else {
            next();
          }
        },
      ], function() {
        return cb(null, {
          copayerId: copayer.id,
          wallet: wallet
        });
      });
    });
  });
};


WalletService.prototype._addKeyToCopayer = function(wallet, copayer, opts, cb) {
  var self = this;
  wallet.addCopayerRequestKey(copayer.copayerId, opts.requestPubKey, opts.signature, opts.restrictions, opts.name);
  self.storage.storeWalletAndUpdateCopayersLookup(wallet, function(err) {
    if (err) return cb(err);

    return cb(null, {
      copayerId: copayer.id,
      wallet: wallet
    });
  });
};

/**
 * Adds access to a given copayer
 *
 * @param {Object} opts
 * @param {string} opts.copayerId - The copayer id
 * @param {string} opts.requestPubKey - Public Key used to check requests from this copayer.
 * @param {string} opts.copayerSignature - S(requestPubKey). Used by other copayers to verify the that the copayer is himself (signed with REQUEST_KEY_AUTH)
 * @param {string} opts.restrictions
 *    - cannotProposeTXs
 *    - cannotXXX TODO
 * @param {string} opts.name  (name for the new access)
 */
WalletService.prototype.addAccess = function(opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['copayerId', 'requestPubKey', 'signature']))
    return cb(new ClientError('Required argument missing'));

  self.storage.fetchCopayerLookup(opts.copayerId, function(err, copayer) {
    if (err) return cb(err);
    if (!copayer) return cb(Errors.NOT_AUTHORIZED);
    self.storage.fetchWallet(copayer.walletId, function(err, wallet) {
      if (err) return cb(err);
      if (!wallet) return cb(Errors.NOT_AUTHORIZED);

      var xPubKey = _.find(wallet.copayers, {
        id: opts.copayerId
      }).xPubKey;

      if (!WalletUtils.verifyRequestPubKey(opts.requestPubKey, opts.signature, xPubKey)) {
        return cb(Errors.NOT_AUTHORIZED);
      }

      if (copayer.requestPubKeys.length > MAX_KEYS)
        return cb(Errors.TOO_MANY_KEYS);

      self._addKeyToCopayer(wallet, copayer, opts, cb);
    });
  });
};

WalletService.prototype._parseClientVersion = function() {
  function parse(version) {
    var v = {};

    if (!version) return null;

    var x = version.split('-');
    if (x.length != 2) {
      v.agent = version;
      return v;
    }
    v.agent = _.contains(['bwc', 'bws'], x[0]) ? 'bwc' : x[0];
    x = x[1].split('.');
    v.major = parseInt(x[0]);
    v.minor = parseInt(x[1]);
    v.patch = parseInt(x[2]);

    return v;
  };

  if (_.isUndefined(this.parsedClientVersion)) {
    this.parsedClientVersion = parse(this.clientVersion);
  }
  return this.parsedClientVersion;
};

WalletService.prototype._clientSupportsBIP44 = function() {
  var version = this._parseClientVersion();
  if (!version) return false;
  if (version.agent != 'bwc') return true; // Asume 3rd party clients are up-to-date
  if (version.major == 0 && version.minor <= 1) return false;
  return true;
};

WalletService.prototype._clientSupportsTXPv2 = function() {
  var version = this._parseClientVersion();
  if (!version) return false;
  if (version.agent != 'bwc') return true; // Asume 3rd party clients are up-to-date
  if (version.major == 0 && version.minor == 0) return false;
  return true;
};

/**
 * Joins a wallet in creation.
 * @param {Object} opts
 * @param {string} opts.walletId - The wallet id.
 * @param {string} opts.name - The copayer name.
 * @param {string} opts.xPubKey - Extended Public Key for this copayer.
 * @param {string} opts.requestPubKey - Public Key used to check requests from this copayer.
 * @param {string} opts.copayerSignature - S(name|xPubKey|requestPubKey). Used by other copayers to verify that the copayer joining knows the wallet secret.
 * @param {string} opts.customData - (optional) Custom data for this copayer.
 */
WalletService.prototype.joinWallet = function(opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['walletId', 'name', 'xPubKey', 'requestPubKey', 'copayerSignature']))
    return cb(new ClientError('Required argument missing'));

  if (_.isEmpty(opts.name))
    return cb(new ClientError('Invalid copayer name'));

  self.walletId = opts.walletId;
  self._runLocked(cb, function(cb) {
    self.storage.fetchWallet(opts.walletId, function(err, wallet) {
      if (err) return cb(err);
      if (!wallet) return cb(Errors.WALLET_NOT_FOUND);

      var hash = WalletUtils.getCopayerHash(opts.name, opts.xPubKey, opts.requestPubKey);
      if (!self._verifySignature(hash, opts.copayerSignature, wallet.pubKey)) {
        return cb(new ClientError());
      }

      if (_.find(wallet.copayers, {
        xPubKey: opts.xPubKey
      })) return cb(Errors.COPAYER_IN_WALLET);

      self._addCopayerToWallet(wallet, opts, cb);
    });
  });
};

/**
 * Save copayer preferences for the current wallet/copayer pair.
 * @param {Object} opts
 * @param {string} opts.email - Email address for notifications.
 * @param {string} opts.language - Language used for notifications.
 * @param {string} opts.unit - Bitcoin unit used to format amounts in notifications.
 */
WalletService.prototype.savePreferences = function(opts, cb) {
  var self = this;

  opts = opts || {};

  var preferences = [{
    name: 'email',
    isValid: function(value) {
      return EmailValidator.validate(value);
    },
  }, {
    name: 'language',
    isValid: function(value) {
      return _.isString(value) && value.length == 2;
    },
  }, {
    name: 'unit',
    isValid: function(value) {
      return _.isString(value) && _.contains(['btc', 'bit'], value.toLowerCase());
    },
  }];

  opts = _.pick(opts, _.pluck(preferences, 'name'));
  try {
    _.each(preferences, function(preference) {
      var value = opts[preference.name];
      if (!value) return;
      if (!preference.isValid(value)) {
        throw 'Invalid ' + preference.name;
        return false;
      }
    });
  } catch (ex) {
    return cb(new ClientError(ex));
  }

  self._runLocked(cb, function(cb) {
    self.storage.fetchPreferences(self.walletId, self.copayerId, function(err, oldPref) {
      if (err) return cb(err);

      var newPref = Model.Preferences.create({
        walletId: self.walletId,
        copayerId: self.copayerId,
      });
      var preferences = Model.Preferences.fromObj(_.defaults(newPref, opts, oldPref));
      self.storage.storePreferences(preferences, function(err) {
        return cb(err);
      });
    });
  });
};

/**
 * Retrieves a preferences for the current wallet/copayer pair.
 * @param {Object} opts
 * @returns {Object} preferences
 */
WalletService.prototype.getPreferences = function(opts, cb) {
  var self = this;

  self.storage.fetchPreferences(self.walletId, self.copayerId, function(err, preferences) {
    if (err) return cb(err);
    return cb(null, preferences || {});
  });
};


/**
 * Creates a new address.
 * @param {Object} opts
 * @returns {Address} address
 */
WalletService.prototype.createAddress = function(opts, cb) {
  var self = this;

  self._runLocked(cb, function(cb) {
    self.getWallet({}, function(err, wallet) {
      if (err) return cb(err);
      if (!wallet.isComplete()) return cb(Errors.WALLET_NOT_COMPLETE);

      var address = wallet.createAddress(false);

      self.storage.storeAddressAndWallet(wallet, address, function(err) {
        if (err) return cb(err);

        self._notify('NewAddress', {
          address: address.address,
        }, function() {
          return cb(null, address);
        });
      });
    });
  });
};

/**
 * Get all addresses.
 * @param {Object} opts
 * @returns {Address[]}
 */
WalletService.prototype.getMainAddresses = function(opts, cb) {
  var self = this;

  self.storage.fetchAddresses(self.walletId, function(err, addresses) {
    if (err) return cb(err);

    var onlyMain = _.reject(addresses, {
      isChange: true
    });
    return cb(null, onlyMain);
  });
};

/**
 * Verifies that a given message was actually sent by an authorized copayer.
 * @param {Object} opts
 * @param {string} opts.message - The message to verify.
 * @param {string} opts.signature - The signature of message to verify.
 * @returns {truthy} The result of the verification.
 */
WalletService.prototype.verifyMessageSignature = function(opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['message', 'signature']))
    return cb(new ClientError('Required argument missing'));

  self.getWallet({}, function(err, wallet) {
    if (err) return cb(err);

    var copayer = wallet.getCopayer(self.copayerId);

    var isValid = !!self._getSigningKey(opts.message, opts.signature, copayer.requestPubKeys);
    return cb(null, isValid);
  });
};


WalletService.prototype._getBlockchainExplorer = function(network) {
  if (!this.blockchainExplorer) {
    var opts = {};
    if (this.blockchainExplorerOpts && this.blockchainExplorerOpts[network]) {
      opts = this.blockchainExplorerOpts[network];
    }
    // TODO: provider should be configurable
    opts.provider = 'insight';
    opts.network = network;
    this.blockchainExplorer = new BlockchainExplorer(opts);
  }

  return this.blockchainExplorer;
};

WalletService.prototype._getUtxosForAddresses = function(addresses, cb) {
  var self = this;

  if (addresses.length == 0) return cb(null, []);
  var networkName = Bitcore.Address(addresses[0]).toObject().network;

  var bc = self._getBlockchainExplorer(networkName);
  bc.getUnspentUtxos(addresses, function(err, utxos) {
    if (err) return cb(err);

    var utxos = _.map(utxos, function(utxo) {
      var u = _.pick(utxo, ['txid', 'vout', 'address', 'scriptPubKey', 'amount', 'satoshis', 'confirmations']);
      u.confirmations = u.confirmations || 0;
      u.locked = false;
      u.satoshis = u.satoshis ? +u.satoshis : Utils.strip(u.amount * 1e8);
      delete u.amount;
      return u;
    });

    return cb(null, utxos);
  });
};

WalletService.prototype._getUtxosForCurrentWallet = function(cb) {
  var self = this;

  function utxoKey(utxo) {
    return utxo.txid + '|' + utxo.vout
  };

  // Get addresses for this wallet
  self.storage.fetchAddresses(self.walletId, function(err, addresses) {
    if (err) return cb(err);

    var addressStrs = _.pluck(addresses, 'address');
    self._getUtxosForAddresses(addressStrs, function(err, utxos) {
      if (err) return cb(err);
      if (utxos.length == 0) return cb(null, []);

      self.getPendingTxs({}, function(err, txps) {
        if (err) return cb(err);

        var lockedInputs = _.map(_.flatten(_.pluck(txps, 'inputs')), utxoKey);
        var utxoIndex = _.indexBy(utxos, utxoKey);
        _.each(lockedInputs, function(input) {
          if (utxoIndex[input]) {
            utxoIndex[input].locked = true;
          }
        });

        // Needed for the clients to sign UTXOs
        var addressToPath = _.indexBy(addresses, 'address');
        _.each(utxos, function(utxo) {
          utxo.path = addressToPath[utxo.address].path;
          utxo.publicKeys = addressToPath[utxo.address].publicKeys;
        });

        return cb(null, utxos);
      });
    });
  });
};

/**
 * Returns list of UTXOs
 * @param {Object} opts
 * @param {Array} opts.addresses (optional) - List of addresses from where to fetch UTXOs.
 * @returns {Array} utxos - List of UTXOs.
 */
WalletService.prototype.getUtxos = function(opts, cb) {
  var self = this;

  opts = opts || {};

  if (_.isUndefined(opts.addresses)) {
    self._getUtxosForCurrentWallet(cb);
  } else {
    self._getUtxosForAddresses(opts.addresses, cb);
  }
};

WalletService.prototype._totalizeUtxos = function(utxos) {
  var balance = {
    totalAmount: _.sum(utxos, 'satoshis'),
    lockedAmount: _.sum(_.filter(utxos, 'locked'), 'satoshis'),
    totalConfirmedAmount: _.sum(_.filter(utxos, 'confirmations'), 'satoshis'),
    lockedConfirmedAmount: _.sum(_.filter(_.filter(utxos, 'locked'), 'confirmations'), 'satoshis'),
  };
  balance.availableAmount = balance.totalAmount - balance.lockedAmount;
  balance.availableConfirmedAmount = balance.totalConfirmedAmount - balance.lockedConfirmedAmount;

  return balance;
};


WalletService.prototype._computeBytesToSendMax = function(utxos, cb) {
  var self = this;

  var unlockedUtxos = _.reject(utxos, 'locked');
  if (_.isEmpty(unlockedUtxos)) return cb(null, 0);

  self.getWallet({}, function(err, wallet) {
    if (err) return cb(err);

    var txp = Model.TxProposal.create({
      walletId: self.walletId,
      requiredSignatures: wallet.m,
      walletN: wallet.n,
    });
    txp.inputs = unlockedUtxos;

    var size = txp.getEstimatedSize();

    return cb(null, size);
  });
};

/**
 * Creates a new transaction proposal.
 * @param {Object} opts
 * @returns {Object} balance - Total amount & locked amount.
 */
WalletService.prototype.getBalance = function(opts, cb) {
  var self = this;

  self.getUtxos({}, function(err, utxos) {
    if (err) return cb(err);
    var balance = self._totalizeUtxos(utxos);

    // Compute balance by address
    var byAddress = {};
    _.each(_.indexBy(utxos, 'address'), function(value, key) {
      byAddress[key] = {
        address: key,
        path: value.path,
        amount: 0,
      };
    });

    _.each(utxos, function(utxo) {
      byAddress[utxo.address].amount += utxo.satoshis;
    });

    balance.byAddress = _.values(byAddress);

    self._computeBytesToSendMax(utxos, function(err, size) {
      if (err) {
        log.error('Could not compute fees needed to transfer max amount', err);
      }
      balance.totalBytesToSendMax = size || 0;
      return cb(null, balance);
    });
  });
};

WalletService.prototype._sampleFeeLevels = function(network, points, cb) {
  var self = this;

  var bc = self._getBlockchainExplorer(network);
  bc.estimateFee(points, function(err, result) {
    if (err) {
      log.error('Error estimating fee', err);
      return cb(err);
    }

    var levels = _.zipObject(_.map(points, function(p) {
      var feePerKB = _.isObject(result) ? +result[p] : -1;
      if (feePerKB < 0) {
        log.warn('Could not compute fee estimation (nbBlocks=' + p + ')');
      }
      return [p, Utils.strip(feePerKB * 1e8)];
    }));

    return cb(null, levels);
  });
};

/**
 * Returns fee levels for the current state of the network.
 * @param {Object} opts
 * @param {string} [opts.network = 'livenet'] - The Bitcoin network to estimate fee levels from.
 * @returns {Object} feeLevels - A list of fee levels & associated amount per kB in satoshi.
 */
WalletService.prototype.getFeeLevels = function(opts, cb) {
  var self = this;

  opts = opts || {};

  var network = opts.network || 'livenet';
  if (network != 'livenet' && network != 'testnet')
    return cb(new ClientError('Invalid network'));

  var levels = WalletService.FEE_LEVELS;
  var samplePoints = _.uniq(_.pluck(levels, 'nbBlocks'));
  self._sampleFeeLevels(network, samplePoints, function(err, feeSamples) {
    var values = _.map(levels, function(level) {
      var result = {
        level: level.name,
      };
      if (err || feeSamples[level.nbBlocks] < 0) {
        result.feePerKB = level.defaultValue;
        result.nbBlocks = null;
      } else {
        result.feePerKB = feeSamples[level.nbBlocks];
        result.nbBlocks = level.nbBlocks;
      }
      return result;
    });

    return cb(null, values);
  });
};

WalletService.prototype._selectTxInputs = function(txp, utxosToExclude, cb) {
  var self = this;

  function sortUtxos(utxos) {
    var list = _.map(utxos, function(utxo) {
      var order;
      if (utxo.confirmations == 0) {
        order = 0;
      } else if (utxo.confirmations < 6) {
        order = -1;
      } else {
        order = -2;
      }
      return {
        order: order,
        utxo: utxo
      };
    });
    return _.pluck(_.sortBy(list, 'order'), 'utxo');
  };

  self.getUtxos({}, function(err, utxos) {
    if (err) return cb(err);

    var excludeIndex = _.reduce(utxosToExclude, function(res, val) {
      res[val] = val;
      return res;
    }, {});

    utxos = _.reject(utxos, function(utxo) {
      return excludeIndex[utxo.txid + ":" + utxo.vout];
    });

    var totalAmount;
    var availableAmount;

    var balance = self._totalizeUtxos(utxos);
    if (txp.excludeUnconfirmedUtxos) {
      totalAmount = balance.totalConfirmedAmount;
      availableAmount = balance.availableConfirmedAmount;
    } else {
      totalAmount = balance.totalAmount;
      availableAmount = balance.availableAmount;
    }

    if (totalAmount < txp.getTotalAmount()) return cb(Errors.INSUFFICIENT_FUNDS);
    if (availableAmount < txp.amount) return cb(Errors.LOCKED_FUNDS);

    // Prepare UTXOs list
    utxos = _.reject(utxos, 'locked');
    if (txp.excludeUnconfirmedUtxos) {
      utxos = _.filter(utxos, 'confirmations');
    }

    var i = 0;
    var total = 0;
    var selected = [];
    var inputs = sortUtxos(utxos);

    var bitcoreTx, bitcoreError;
    var serializationOpts = {
      disableIsFullySigned: true,
    };
    if (!_.startsWith(txp.version, '1.')) {
      serializationOpts.disableSmallFees = true;
      serializationOpts.disableLargeFees = true;
    }

    while (i < inputs.length) {
      selected.push(inputs[i]);
      total += inputs[i].satoshis;
      i++;

      if (total >= txp.getTotalAmount()) {
        try {
          txp.setInputs(selected);
          txp.estimateFee();
          bitcoreTx = txp.getBitcoreTx();
          bitcoreError = bitcoreTx.getSerializationError(serializationOpts);
          if (!bitcoreError) {
            txp.fee = bitcoreTx.getFee();
            return cb();
          }
        } catch (ex) {
          log.error('Error building Bitcore transaction', ex);
          return cb(ex);
        }
      }
    }

    if (bitcoreError instanceof Bitcore.errors.Transaction.FeeError)
      return cb(Errors.INSUFFICIENT_FUNDS_FOR_FEE);

    if (bitcoreError instanceof Bitcore.errors.Transaction.DustOutputs)
      return cb(Errors.DUST_AMOUNT);

    return cb(bitcoreError || new Error('Could not select tx inputs'));
  });
};

WalletService.prototype._canCreateTx = function(copayerId, cb) {
  var self = this;
  self.storage.fetchLastTxs(self.walletId, copayerId, 5 + WalletService.BACKOFF_OFFSET, function(err, txs) {
    if (err) return cb(err);

    if (!txs.length)
      return cb(null, true);

    var lastRejections = _.takeWhile(txs, {
      status: 'rejected'
    });

    var exceededRejections = lastRejections.length - WalletService.BACKOFF_OFFSET;
    if (exceededRejections <= 0)
      return cb(null, true);


    var lastTxTs = txs[0].createdOn;
    var now = Math.floor(Date.now() / 1000);
    var timeSinceLastRejection = now - lastTxTs;
    var backoffTime = 60 * Math.pow(WalletService.BACKOFF_TIME, exceededRejections);

    if (timeSinceLastRejection <= backoffTime)
      log.debug('Not allowing to create TX: timeSinceLastRejection/backoffTime', timeSinceLastRejection, backoffTime);

    return cb(null, timeSinceLastRejection > backoffTime);
  });
};


/**
 * Creates a new transaction proposal.
 * @param {Object} opts
 * @param {string} opts.type - Proposal type.
 * @param {string} opts.toAddress || opts.outputs[].toAddress - Destination address.
 * @param {number} opts.amount || opts.outputs[].amount - Amount to transfer in satoshi.
 * @param {string} opts.outputs[].message - A message to attach to this output.
 * @param {string} opts.message - A message to attach to this transaction.
 * @param {string} opts.proposalSignature - S(toAddress|amount|message|payProUrl). Used by other copayers to verify the proposal.
 * @param {string} opts.feePerKb - Optional: Use an alternative fee per KB for this TX
 * @param {string} opts.payProUrl - Optional: Paypro URL for peers to verify TX
 * @param {string} opts.excludeUnconfirmedUtxos - Optional: Do not use UTXOs of unconfirmed transactions as inputs
 * @returns {TxProposal} Transaction proposal.
 */
WalletService.prototype.createTx = function(opts, cb) {
  var self = this;

  if (!opts.outputs) {
    opts.outputs = _.pick(opts, ['amount', 'toAddress']);
  }
  opts.outputs = [].concat(opts.outputs);

  if (!Utils.checkRequired(opts, ['outputs', 'proposalSignature']))
    return cb(new ClientError('Required argument missing'));

  var type = opts.type || Model.TxProposal.Types.SIMPLE;
  if (!Model.TxProposal.isTypeSupported(type))
    return cb(new ClientError('Invalid proposal type'));

  _.each(opts.outputs, function(output) {
    if (!Utils.checkRequired(output, ['toAddress', 'amount'])) {
      output.valid = false;
      cb(new ClientError('Required outputs argument missing'));
      return false;
    }
  });
  if (_.any(opts.outputs, {
    valid: false
  })) return;

  var feePerKb = opts.feePerKb || WalletUtils.DEFAULT_FEE_PER_KB;
  if (feePerKb < WalletUtils.MIN_FEE_PER_KB || feePerKb > WalletUtils.MAX_FEE_PER_KB)
    return cb(new ClientError('Invalid fee per KB value'));

  self._runLocked(cb, function(cb) {
    self.getWallet({}, function(err, wallet) {
      if (err) return cb(err);
      if (!wallet.isComplete()) return cb(Errors.WALLET_NOT_COMPLETE);

      var copayer = wallet.getCopayer(self.copayerId);
      var hash;
      if (!opts.type || opts.type == Model.TxProposal.Types.SIMPLE) {
        hash = WalletUtils.getProposalHash(opts.toAddress, opts.amount, opts.message, opts.payProUrl);
      } else {
        // should match bwc api _computeProposalSignature
        var header = {
          outputs: _.map(opts.outputs, function(output) {
            return _.pick(output, ['toAddress', 'amount', 'message']);
          }),
          message: opts.message,
          payProUrl: opts.payProUrl
        };
        hash = WalletUtils.getProposalHash(header)
      }

      var signingKey = self._getSigningKey(hash, opts.proposalSignature, copayer.requestPubKeys)
      if (!signingKey)
        return cb(new ClientError('Invalid proposal signature'));

      self._canCreateTx(self.copayerId, function(err, canCreate) {
        if (err) return cb(err);
        if (!canCreate) return cb(Errors.TX_CANNOT_CREATE);

        _.each(opts.outputs, function(output) {
          output.valid = false;
          var toAddress = {};
          try {
            toAddress = new Bitcore.Address(output.toAddress);
          } catch (ex) {
            cb(Errors.INVALID_ADDRESS);
            return false;
          }
          if (toAddress.network != wallet.getNetworkName()) {
            cb(Errors.INCORRECT_ADDRESS_NETWORK);
            return false;
          }
          if (!_.isNumber(output.amount) || _.isNaN(output.amount) || output.amount <= 0) {
            cb(new ClientError('Invalid amount'));
            return false;
          }
          if (output.amount < Bitcore.Transaction.DUST_AMOUNT) {
            cb(Errors.DUST_AMOUNT);
            return false;
          }
          output.valid = true;
        });
        if (_.any(opts.outputs, {
          valid: false
        })) return;

        var txOpts = {
          type: type,
          walletId: self.walletId,
          creatorId: self.copayerId,
          outputs: opts.outputs,
          toAddress: opts.toAddress,
          amount: opts.amount,
          message: opts.message,
          proposalSignature: opts.proposalSignature,
          changeAddress: wallet.createAddress(true),
          feePerKb: feePerKb,
          payProUrl: opts.payProUrl,
          requiredSignatures: wallet.m,
          requiredRejections: Math.min(wallet.m, wallet.n - wallet.m + 1),
          walletN: wallet.n,
          excludeUnconfirmedUtxos: !!opts.excludeUnconfirmedUtxos,
          derivationStrategy: wallet.derivationStrategy,
          customData: opts.customData
        };

        if (signingKey.selfSigned) {
          txOpts.proposalSignaturePubKey = signingKey.key;
          txOpts.proposalSignaturePubKeySig = signingKey.signature;
        }

        var txp = Model.TxProposal.create(txOpts);

        if (!self._clientSupportsTXPv2()) {
          txp.version = '1.0.1';
        }

        self._selectTxInputs(txp, opts.utxosToExclude, function(err) {
          if (err) return cb(err);

          $.checkState(txp.inputs);

          self.storage.storeAddressAndWallet(wallet, txp.changeAddress, function(err) {
            if (err) return cb(err);

            self.storage.storeTx(wallet.id, txp, function(err) {
              if (err) return cb(err);

              self._notify('NewTxProposal', {
                amount: txp.getTotalAmount()
              }, function() {
                return cb(null, txp);
              });
            });
          });
        });
      });
    });
  });
};

/**
 * Retrieves a tx from storage.
 * @param {Object} opts
 * @param {string} opts.txProposalId - The tx id.
 * @returns {Object} txProposal
 */
WalletService.prototype.getTx = function(opts, cb) {
  var self = this;

  self.storage.fetchTx(self.walletId, opts.txProposalId, function(err, txp) {
    if (err) return cb(err);
    if (!txp) return cb(Errors.TX_NOT_FOUND);
    return cb(null, txp);
  });
};


/**
 * removeWallet
 *
 * @param opts
 * @param cb
 * @return {undefined}
 */
WalletService.prototype.removeWallet = function(opts, cb) {
  var self = this;

  self._runLocked(cb, function(cb) {
    self.storage.removeWallet(self.walletId, cb);
  });
};

WalletService.prototype.getRemainingDeleteLockTime = function(txp) {
  var now = Math.floor(Date.now() / 1000);

  var lockTimeRemaining = txp.createdOn + WalletService.DELETE_LOCKTIME - now;
  if (lockTimeRemaining < 0)
    return 0;

  // not the creator? need to wait
  if (txp.creatorId !== this.copayerId)
    return lockTimeRemaining;

  // has other approvers? need to wait
  var approvers = txp.getApprovers();
  if (approvers.length > 1 || (approvers.length == 1 && approvers[0] !== this.copayerId))
    return lockTimeRemaining;

  return 0;
};


/**
 * removePendingTx
 *
 * @param opts
 * @param {string} opts.txProposalId - The tx id.
 * @return {undefined}
 */
WalletService.prototype.removePendingTx = function(opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['txProposalId']))
    return cb(new ClientError('Required argument missing'));

  self._runLocked(cb, function(cb) {

    self.getTx({
      txProposalId: opts.txProposalId,
    }, function(err, txp) {
      if (err) return cb(err);

      if (!txp.isPending()) return cb(Errors.TX_NOT_PENDING);

      var deleteLockTime = self.getRemainingDeleteLockTime(txp);
      if (deleteLockTime > 0) return cb(Errors.TX_CANNOT_REMOVE);

      self.storage.removeTx(self.walletId, txp.id, function() {
        self._notify('TxProposalRemoved', {}, cb);
      });
    });
  });
};

WalletService.prototype._broadcastRawTx = function(network, raw, cb) {
  var bc = this._getBlockchainExplorer(network);
  bc.broadcast(raw, function(err, txid) {
    if (err) return cb(err);
    return cb(null, txid);
  })
};

/**
 * Broadcast a raw transaction.
 * @param {Object} opts
 * @param {string} [opts.network = 'livenet'] - The Bitcoin network for this transaction.
 * @param {string} opts.rawTx - Raw tx data.
 */
WalletService.prototype.broadcastRawTx = function(opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['network', 'rawTx']))
    return cb(new ClientError('Required argument missing'));

  var network = opts.network || 'livenet';
  if (network != 'livenet' && network != 'testnet')
    return cb(new ClientError('Invalid network'));

  self._broadcastRawTx(network, opts.rawTx, cb);
};


WalletService.prototype._checkTxInBlockchain = function(txp, cb) {
  var tx = txp.getBitcoreTx();
  var bc = this._getBlockchainExplorer(txp.getNetworkName());
  bc.getTransaction(tx.id, function(err, tx) {
    if (err) return cb(err);
    return cb(null, tx);
  })
};

/**
 * Sign a transaction proposal.
 * @param {Object} opts
 * @param {string} opts.txProposalId - The identifier of the transaction.
 * @param {string} opts.signatures - The signatures of the inputs of this tx for this copayer (in apperance order)
 */
WalletService.prototype.signTx = function(opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['txProposalId', 'signatures']))
    return cb(new ClientError('Required argument missing'));

  self.getWallet({}, function(err, wallet) {
    if (err) return cb(err);

    self.getTx({
      txProposalId: opts.txProposalId
    }, function(err, txp) {
      if (err) return cb(err);

      if (!self._clientSupportsTXPv2()) {
        if (!_.startsWith(txp.version, '1.')) {
          return cb(new ClientError(Errors.codes.UPGRADE_NEEDED, 'To sign this spend proposal you need to upgrade your client app.'));
        }
      }

      var action = _.find(txp.actions, {
        copayerId: self.copayerId
      });
      if (action) return cb(Errors.COPAYER_VOTED);
      if (!txp.isPending()) return cb(Errors.TX_NOT_PENDING);

      var copayer = wallet.getCopayer(self.copayerId);

      if (!txp.sign(self.copayerId, opts.signatures, copayer.xPubKey))
        return cb(Errors.BAD_SIGNATURES);

      self.storage.storeTx(self.walletId, txp, function(err) {
        if (err) return cb(err);

        async.series([

          function(next) {
            self._notify('TxProposalAcceptedBy', {
              txProposalId: opts.txProposalId,
              copayerId: self.copayerId,
            }, next);
          },
          function(next) {
            if (txp.isAccepted()) {
              self._notify('TxProposalFinallyAccepted', {
                txProposalId: opts.txProposalId,
              }, next);
            } else {
              next();
            }
          },
        ], function() {
          return cb(null, txp);
        });
      });
    });
  });
};


/**
 * Broadcast a transaction proposal.
 * @param {Object} opts
 * @param {string} opts.txProposalId - The identifier of the transaction.
 */
WalletService.prototype.broadcastTx = function(opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['txProposalId']))
    return cb(new ClientError('Required argument missing'));

  function setBroadcasted(txp, txid, cb) {
    txp.setBroadcasted(txid);
    self.storage.storeTx(self.walletId, txp, function(err) {
      if (err) return cb(err);

      self._notify('NewOutgoingTx', {
        txProposalId: opts.txProposalId,
        txid: txid,
        amount: txp.getTotalAmount(),
      }, function() {
        return cb(null, txp);
      });
    });
  };

  self.getWallet({}, function(err, wallet) {
    if (err) return cb(err);

    self.getTx({
      txProposalId: opts.txProposalId
    }, function(err, txp) {
      if (err) return cb(err);

      if (txp.status == 'broadcasted') return cb(Errors.TX_ALREADY_BROADCASTED);
      if (txp.status != 'accepted') return cb(Errors.TX_NOT_ACCEPTED);

      var raw;
      try {
        raw = txp.getRawTx();
      } catch (ex) {
        return cb(ex);
      }
      self._broadcastRawTx(txp.getNetworkName(), raw, function(err, txid) {
        if (err) {
          var broadcastErr = err;
          // Check if tx already in blockchain
          self._checkTxInBlockchain(txp, function(err, tx) {
            if (err) return cb(err);
            if (!tx) return cb(broadcastErr);

            setBroadcasted(txp, tx.id, cb);
          });
        } else {
          setBroadcasted(txp, txid, cb);
        }
      });
    });
  });
};

/**
 * Reject a transaction proposal.
 * @param {Object} opts
 * @param {string} opts.txProposalId - The identifier of the transaction.
 * @param {string} [opts.reason] - A message to other copayers explaining the rejection.
 */
WalletService.prototype.rejectTx = function(opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['txProposalId']))
    return cb(new ClientError('Required argument missing'));

  self.getTx({
    txProposalId: opts.txProposalId
  }, function(err, txp) {
    if (err) return cb(err);

    var action = _.find(txp.actions, {
      copayerId: self.copayerId
    });

    if (action) return cb(Errors.COPAYER_VOTED);
    if (txp.status != 'pending') return cb(Errors.TX_NOT_PENDING);

    txp.reject(self.copayerId, opts.reason);

    self.storage.storeTx(self.walletId, txp, function(err) {
      if (err) return cb(err);

      async.series([

        function(next) {
          self._notify('TxProposalRejectedBy', {
            txProposalId: opts.txProposalId,
            copayerId: self.copayerId,
          }, next);
        },
        function(next) {
          if (txp.status == 'rejected') {
            var rejectedBy = _.pluck(_.filter(txp.actions, {
              type: 'reject'
            }), 'copayerId');

            self._notify('TxProposalFinallyRejected', {
              txProposalId: opts.txProposalId,
              rejectedBy: rejectedBy,
            }, next);
          } else {
            next();
          }
        },
      ], function() {
        return cb(null, txp);
      });
    });
  });
};

/**
 * Retrieves pending transaction proposals.
 * @param {Object} opts
 * @returns {TxProposal[]} Transaction proposal.
 */
WalletService.prototype.getPendingTxs = function(opts, cb) {
  var self = this;

  self.storage.fetchPendingTxs(self.walletId, function(err, txps) {
    if (err) return cb(err);

    _.each(txps, function(txp) {
      txp.deleteLockTime = self.getRemainingDeleteLockTime(txp);
    });

    return cb(null, txps);
  });
};

/**
 * Retrieves all transaction proposals in the range (maxTs-minTs)
 * Times are in UNIX EPOCH
 *
 * @param {Object} opts.minTs (defaults to 0)
 * @param {Object} opts.maxTs (defaults to now)
 * @param {Object} opts.limit
 * @returns {TxProposal[]} Transaction proposals, newer first
 */
WalletService.prototype.getTxs = function(opts, cb) {
  var self = this;
  self.storage.fetchTxs(self.walletId, opts, function(err, txps) {
    if (err) return cb(err);
    return cb(null, txps);
  });
};


/**
 * Retrieves notifications in the range (maxTs-minTs).
 * Times are in UNIX EPOCH. Order is assured even for events with the same time
 *
 * @param {Object} opts.minTs (defaults to 0)
 * @param {Object} opts.maxTs (defaults to now)
 * @param {Object} opts.limit
 * @param {Object} opts.reverse (default false)
 * @returns {Notification[]} Notifications
 */
WalletService.prototype.getNotifications = function(opts, cb) {
  var self = this;
  self.storage.fetchNotifications(self.walletId, opts, function(err, notifications) {
    if (err) return cb(err);
    return cb(null, notifications);
  });
};


WalletService.prototype._normalizeTxHistory = function(txs) {
  var now = Math.floor(Date.now() / 1000);

  return _.map(txs, function(tx) {
    var inputs = _.map(tx.vin, function(item) {
      return {
        address: item.addr,
        amount: item.valueSat,
      }
    });

    var outputs = _.map(tx.vout, function(item) {
      var itemAddr;
      // If classic multisig, ignore
      if (item.scriptPubKey && _.isArray(item.scriptPubKey.addresses) && item.scriptPubKey.addresses.length == 1) {
        itemAddr = item.scriptPubKey.addresses[0];
      }

      return {
        address: itemAddr,
        amount: parseInt((item.value * 1e8).toFixed(0)),
      }
    });

    return {
      txid: tx.txid,
      confirmations: tx.confirmations,
      fees: parseInt((tx.fees * 1e8).toFixed(0)),
      time: tx.firstSeenTs || (!_.isNaN(tx.time) ? tx.time : now) || now,
      inputs: inputs,
      outputs: outputs,
    };
  });
};

/**
 * Retrieves all transactions (incoming & outgoing)
 * Times are in UNIX EPOCH
 *
 * @param {Object} opts
 * @param {Number} opts.skip (defaults to 0)
 * @param {Number} opts.limit
 * @returns {TxProposal[]} Transaction proposals, first newer
 */
WalletService.prototype.getTxHistory = function(opts, cb) {
  var self = this;

  function decorate(txs, addresses, proposals) {

    var indexedAddresses = _.indexBy(addresses, 'address');
    var indexedProposals = _.indexBy(proposals, 'txid');

    function sum(items, isMine, isChange) {
      var filter = {};
      if (_.isBoolean(isMine)) filter.isMine = isMine;
      if (_.isBoolean(isChange)) filter.isChange = isChange;
      return _.sum(_.filter(items, filter), 'amount');
    };

    function classify(items) {
      return _.map(items, function(item) {
        var address = indexedAddresses[item.address];
        return {
          address: item.address,
          amount: item.amount,
          isMine: !!address,
          isChange: address ? address.isChange : false,
        }
      });
    };

    return _.map(txs, function(tx) {

      var amountIn, amountOut, amountOutChange;
      var amount, action, addressTo;
      var inputs, outputs;

      if (tx.outputs.length || tx.inputs.length) {

        inputs = classify(tx.inputs);
        outputs = classify(tx.outputs);

        amountIn = sum(inputs, true);
        amountOut = sum(outputs, true, false);
        amountOutChange = sum(outputs, true, true);
        if (amountIn == (amountOut + amountOutChange + (amountIn > 0 ? tx.fees : 0))) {
          amount = amountOut;
          action = 'moved';
        } else {
          amount = amountIn - amountOut - amountOutChange - (amountIn > 0 ? tx.fees : 0);
          action = amount > 0 ? 'sent' : 'received';
        }

        amount = Math.abs(amount);
        if (action == 'sent' || action == 'moved') {
          var firstExternalOutput = _.find(outputs, {
            isMine: false
          });
          addressTo = firstExternalOutput ? firstExternalOutput.address : 'N/A';
        };
      } else {
        action = 'invalid';
        amount = 0;
      }

      function outputMap(o) {
        return {
          amount: o.amount,
          address: o.address
        }
      };
      var newTx = {
        txid: tx.txid,
        action: action,
        amount: amount,
        fees: tx.fees,
        time: tx.time,
        addressTo: addressTo,
        outputs: _.map(_.filter(outputs, {
          isChange: false
        }), outputMap),
        confirmations: tx.confirmations,
      };

      var proposal = indexedProposals[tx.txid];
      if (proposal) {
        newTx.proposalId = proposal.id;
        newTx.proposalType = proposal.type;
        newTx.creatorName = proposal.creatorName;
        newTx.message = proposal.message;
        newTx.actions = _.map(proposal.actions, function(action) {
          return _.pick(action, ['createdOn', 'type', 'copayerId', 'copayerName', 'comment']);
        });
        _.each(newTx.outputs, function(output) {
          var query = {
            toAddress: output.address,
            amount: output.amount
          };
          var txpOut = _.find(proposal.outputs, query);
          output.message = txpOut ? txpOut.message : null;
        });
        // newTx.sentTs = proposal.sentTs;
        // newTx.merchant = proposal.merchant;
        //newTx.paymentAckMemo = proposal.paymentAckMemo;
      }

      return newTx;
    });
  };

  // Get addresses for this wallet
  self.storage.fetchAddresses(self.walletId, function(err, addresses) {
    if (err) return cb(err);
    if (addresses.length == 0) return cb(null, []);

    var addressStrs = _.pluck(addresses, 'address');
    var networkName = Bitcore.Address(addressStrs[0]).toObject().network;

    var bc = self._getBlockchainExplorer(networkName);
    async.parallel([

      function(next) {
        self.storage.fetchTxs(self.walletId, {}, function(err, txps) {
          if (err) return next(err);
          next(null, txps);
        });
      },
      function(next) {
        var from = opts.skip || 0;
        var to = from + (_.isUndefined(opts.limit) ? 100 : opts.limit);
        bc.getTransactions(addressStrs, from, to, function(err, txs) {
          if (err) return cb(err);
          next(null, self._normalizeTxHistory(txs));
        });
      },
    ], function(err, res) {
      if (err) return cb(err);

      var proposals = res[0];
      var txs = res[1];

      txs = decorate(txs, addresses, proposals);

      return cb(null, txs);
    });
  });
};


/**
 * Scan the blockchain looking for addresses having some activity
 *
 * @param {Object} opts
 * @param {Boolean} opts.includeCopayerBranches (defaults to false)
 */
WalletService.prototype.scan = function(opts, cb) {
  var self = this;

  opts = opts || {};

  function deriveAddresses(size, derivator, cb) {
    async.mapSeries(_.range(size), function(i, next) {
      setTimeout(function() {
        next(null, derivator.derive());
      }, WalletService.SCAN_CONFIG.derivationDelay)
    }, cb);
  };

  function checkActivity(addresses, networkName, cb) {
    var bc = self._getBlockchainExplorer(networkName);
    bc.getAddressActivity(addresses, cb);
  };

  function scanBranch(derivator, cb) {
    var activity = true;
    var allAddresses = [];
    var networkName;
    async.whilst(function() {
      return activity;
    }, function(next) {
      deriveAddresses(WalletService.SCAN_CONFIG.scanWindow, derivator, function(err, addresses) {
        if (err) return next(err);
        networkName = networkName || Bitcore.Address(addresses[0].address).toObject().network;
        checkActivity(_.pluck(addresses, 'address'), networkName, function(err, thereIsActivity) {
          if (err) return next(err);

          activity = thereIsActivity;
          if (thereIsActivity) {
            allAddresses.push(addresses);
          } else {
            derivator.rewind(WalletService.SCAN_CONFIG.scanWindow);
          }
          next();
        });
      });
    }, function(err) {
      return cb(err, _.flatten(allAddresses));
    });
  };


  self._runLocked(cb, function(cb) {
    self.getWallet({}, function(err, wallet) {
      if (err) return cb(err);
      if (!wallet.isComplete()) return cb(Errors.WALLET_NOT_COMPLETE);

      wallet.scanStatus = 'running';
      self.storage.storeWallet(wallet, function(err) {
        if (err) return cb(err);

        var derivators = [];
        _.each([false, true], function(isChange) {
          derivators.push({
            derive: _.bind(wallet.createAddress, wallet, isChange),
            rewind: _.bind(wallet.addressManager.rewindIndex, wallet.addressManager, isChange),
          });
          if (opts.includeCopayerBranches) {
            _.each(wallet.copayers, function(copayer) {
              if (copayer.addressManager) {
                derivators.push({
                  derive: _.bind(copayer.createAddress, copayer, wallet, isChange),
                  rewind: _.bind(copayer.addressManager.rewindIndex, copayer.addressManager, isChange),
                });
              }
            });
          }
        });

        async.eachSeries(derivators, function(derivator, next) {
          scanBranch(derivator, function(err, addresses) {
            if (err) return next(err);
            self.storage.storeAddressAndWallet(wallet, addresses, next);
          });
        }, function(error) {
          self.storage.fetchWallet(wallet.id, function(err, wallet) {
            if (err) return cb(err);
            wallet.scanStatus = error ? 'error' : 'success';
            self.storage.storeWallet(wallet, function() {
              return cb(error);
            });
          })
        });
      });
    });
  });
};

/**
 * Start a scan process.
 *
 * @param {Object} opts
 * @param {Boolean} opts.includeCopayerBranches (defaults to false)
 */
WalletService.prototype.startScan = function(opts, cb) {
  var self = this;

  function scanFinished(err) {
    var data = {
      result: err ? 'error' : 'success',
    };
    if (err) data.error = err;
    self._notify('ScanFinished', data, {
      isGlobal: true
    });
  };

  self.getWallet({}, function(err, wallet) {
    if (err) return cb(err);
    if (!wallet.isComplete()) return cb(Errors.WALLET_NOT_COMPLETE);

    setTimeout(function() {
      self.scan(opts, scanFinished);
    }, 100);

    return cb(null, {
      started: true
    });
  });
};


module.exports = WalletService;
module.exports.ClientError = ClientError;
