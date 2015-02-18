'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var util = require('util');
var async = require('async');
var log = require('npmlog');
var request = require('request')
log.debug = log.verbose;

var Bitcore = require('bitcore')
var WalletUtils = require('../walletutils');
var Verifier = require('./verifier');
var ServerCompromisedError = require('./servercompromisederror')

var BASE_URL = 'http://localhost:3001/copay/api';

var WALLET_CRITICAL_DATA = ['xPrivKey', 'm', 'publicKeyRing'];

function _createProposalOpts(opts, signingKey) {
  var hash = WalletUtils.getProposalHash(opts.toAddress, opts.amount, opts.message);
  opts.proposalSignature = WalletUtils.signMessage(hash, signingKey);
  return opts;
};

function _parseError(body) {
  if (_.isString(body)) {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {
        error: body
      };
    }
  }
  var code = body.code || 'ERROR';
  var message = body.error || 'There was an unknown error processing the request';
  log.error(code, message);
};

function _signRequest(method, url, args, privKey) {
  var message = method.toLowerCase() + '|' + url + '|' + JSON.stringify(args);
  return WalletUtils.signMessage(message, privKey);
};

function _createXPrivKey(network) {
  return new Bitcore.HDPrivateKey(network).toString();
};

function API(opts) {
  if (!opts.storage) {
    throw new Error('Must provide storage option');
  }
  this.storage = opts.storage;
  this.verbose = !!opts.verbose;
  this.request = request || opts.request;
  this.baseUrl = opts.baseUrl || BASE_URL;
  if (this.verbose) {
    log.level = 'debug';
  }
};


API.prototype._tryToComplete = function(data, cb) {
  var self = this;

  var url = '/v1/wallets/';
  self._doGetRequest(url, data, function(err, ret) {
    if (err) return cb(err);
    var wallet = ret.wallet;

    if (wallet.status != 'complete')
      return cb('Wallet Incomplete');

    if (!Verifier.checkCopayers(wallet.copayers, data.walletPrivKey, data.xPrivKey, data.n))
      return cb('Some copayers in the wallet could not be verified to have known the wallet secret');

    data.publicKeyRing = _.pluck(wallet.copayers, 'xPubKey')

    self.storage.save(data, function(err) {
      return cb(err, data);
    });
  });
};


API.prototype._loadAndCheck = function(cb) {
  var self = this;

  this.storage.load(function(err, data) {
    if (err || !data) {
      return cb(err || 'Wallet file not found.');
    }
    if (data.n > 1) {
      var pkrComplete = data.publicKeyRing && data.m && data.publicKeyRing.length === data.n;

      if (!pkrComplete) {
        return self._tryToComplete(data, cb);
      }
    }
    return cb(null, data);
  });
};

API.prototype._doRequest = function(method, url, args, data, cb) {
  var reqSignature;
  data = data || {};

  if (data.signingPrivKey)
    reqSignature = _signRequest(method, url, args, data.signingPrivKey);

  var absUrl = this.baseUrl + url;
  var args = {
    headers: {
      'x-identity': data.copayerId,
      'x-signature': reqSignature,
    },
    method: method,
    url: absUrl,
    body: args,
    json: true,
  };
  log.verbose('Request Args', util.inspect(args, {
    depth: 10
  }));
  this.request(args, function(err, res, body) {
    log.verbose(util.inspect(body, {
      depth: 10
    }));
    if (err) return cb(err);
    if (res.statusCode != 200) {
      _parseError(body);
      return cb('Request error');
    }

    return cb(null, body);
  });
};


API.prototype._doPostRequest = function(url, args, data, cb) {
  return this._doRequest('post', url, args, data, cb);
};

API.prototype._doGetRequest = function(url, data, cb) {
  return this._doRequest('get', url, {}, data, cb);
};

API.prototype.createWallet = function(walletName, copayerName, m, n, network, cb) {
  var self = this;
  network = network || 'livenet';
  if (!_.contains(['testnet', 'livenet'], network))
    return cb('Invalid network');

  this.storage.load(function(err, data) {
    if (data)
      return cb('Storage already contains a wallet');

    var walletPrivKey = new Bitcore.PrivateKey();
    var args = {
      name: walletName,
      m: m,
      n: n,
      pubKey: walletPrivKey.toPublicKey().toString(),
      network: network,
    };
    var url = '/v1/wallets/';
    self._doPostRequest(url, args, {}, function(err, body) {
      if (err) return cb(err);

      var walletId = body.walletId;
      var secret = walletId + ':' + walletPrivKey.toWIF() + ':' + (network == 'testnet' ? 'T' : 'L');
      var ret;

      if (n > 1)
        ret = secret;

      self._joinWallet(secret, copayerName, function(err) {
        return cb(err, ret);
      });
    });
  });
};

API.prototype._joinWallet = function(secret, copayerName, cb) {
  var self = this;

  var secretSplit = secret.split(':');
  var walletId = secretSplit[0];

  var walletPrivKey = Bitcore.PrivateKey.fromString(secretSplit[1]);
  var network = secretSplit[2] == 'T' ? 'testnet' : 'livenet';
  var xPrivKey = _createXPrivKey(network);

  var xPubKey = new Bitcore.HDPublicKey(xPrivKey);
  var xPubKeySignature = WalletUtils.signMessage(xPubKey.toString(), walletPrivKey);

  var signingPrivKey = (new Bitcore.HDPrivateKey(xPrivKey)).derive('m/1/0').privateKey;
  var args = {
    walletId: walletId,
    name: copayerName,
    xPubKey: xPubKey.toString(),
    xPubKeySignature: xPubKeySignature,
  };
  var url = '/v1/wallets/' + walletId + '/copayers';

  this._doPostRequest(url, args, {}, function(err, body) {
    var wallet = body.wallet;
    var data = {
      copayerId: body.copayerId,

      publicKeyRing: wallet.publicKeyRing,
      network: wallet.network,
      m: wallet.m,
      n: wallet.n,

      xPrivKey: xPrivKey,
      walletPrivKey: walletPrivKey.toWIF(),
      signingPrivKey: signingPrivKey.toWIF(),
    };
    self.storage.save(data, cb);
  });
};

API.prototype.joinWallet = function(secret, copayerName, cb) {
  var self = this;

  this.storage.load(function(err, data) {
    if (data)
      return cb('Storage already contains a wallet');

    self._joinWallet(secret, copayerName, cb);
  });
};

API.prototype.getStatus = function(cb) {
  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);

    var url = '/v1/wallets/';
    self._doGetRequest(url, data, function(err, body) {
      return cb(err, body, data.copayerId);
    });
  });
};

/**
 * send
 *
 * @param inArgs
 * @param inArgs.toAddress
 * @param inArgs.amount
 * @param inArgs.message
 */
API.prototype.sendTxProposal = function(inArgs, cb) {
  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);

    var args = _createProposalOpts(inArgs, data.signingPrivKey);

    var url = '/v1/txproposals/';
    self._doPostRequest(url, args, data, cb);
  });
};

API.prototype.createAddress = function(cb) {
  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);

    var url = '/v1/addresses/';
    self._doPostRequest(url, {}, data, function(err, address) {
      if (err) return cb(err);
      if (!Verifier.checkAddress(data, address)) {
        return cb(new ServerCompromisedError('Server sent fake address'));
      }

      return cb(null, address);
    });
  });
};

API.prototype.history = function(limit, cb) {

};

API.prototype.getBalance = function(cb) {
  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);
    var url = '/v1/balance/';
    self._doGetRequest(url, data, cb);
  });
};

API.prototype.export = function(cb) {
  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);
    var v = [];

    var myXPubKey = (new Bitcore.HDPublicKey(data.xPrivKey)).toString();

    _.each(WALLET_CRITICAL_DATA, function(k) {
      var d;
      if (k === 'publicKeyRing') {
        d = _.without(data[k], myXPubKey);
      } else {
        d = data[k];
      }
      v.push(d);
    });
    return cb(null, JSON.stringify(v));
  });
}


API.prototype.import = function(str, cb) {
  var self = this;

  this.storage.load(function(err, data) {
    if (data)
      return cb('Storage already contains a wallet');

    data = {};

    var inData = JSON.parse(str);
    var i = 0;

    _.each(WALLET_CRITICAL_DATA, function(k) {
      data[k] = inData[i++];
      if (!data[k])
        return cb('Invalid wallet data');
    });

    var xPubKey = (new Bitcore.HDPublicKey(data.xPrivKey)).toString();

    data.publicKeyRing.push(xPubKey);
    data.copayerId = WalletUtils.xPubToCopayerId(xPubKey);
    data.m = data.publicKeyRing.length;
    data.signingPrivKey = (new Bitcore.HDPrivateKey(data.xPrivKey)).derive('m/1/0').privateKey.toWIF();
    data.network = data.xPrivKey.substr(0, 4) === 'tprv' ? 'testnet' : 'livenet';
    self.storage.save(data, cb);
  });
};


API.prototype.getTxProposals = function(opts, cb) {
  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);
    var url = '/v1/txproposals/';
    self._doGetRequest(url, data, cb);
  });
};

API.prototype.signTxProposal = function(txp, cb) {
  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);

    if (!Verifier.checkTxProposal(data, txp)) {
      return cb(new ServerCompromisedError('Server sent fake transaction proposal'));
    }


    //Derive proper key to sign, for each input
    var privs = [],
      derived = {};

    var network = new Bitcore.Address(txp.toAddress).network.name;
    var xpriv = new Bitcore.HDPrivateKey(data.xPrivKey, network);

    _.each(txp.inputs, function(i) {
      if (!derived[i.path]) {
        derived[i.path] = xpriv.derive(i.path).privateKey;
      }
      privs.push(derived[i.path]);
    });

    var t = new Bitcore.Transaction();
    _.each(txp.inputs, function(i) {
      t.from(i, i.publicKeys, txp.requiredSignatures);
    });

    t.to(txp.toAddress, txp.amount)
      .change(txp.changeAddress)
      .sign(privs);

    var signatures = [];
    _.each(privs, function(p) {
      var s = t.getSignatures(p)[0].signature.toDER().toString('hex');
      signatures.push(s);
    });

    var url = '/v1/txproposals/' + txp.id + '/signatures/';
    var args = {
      signatures: signatures
    };

    self._doPostRequest(url, args, data, cb);
  });
};

API.prototype.rejectTxProposal = function(txp, reason, cb) {
  var self = this;

  this._loadAndCheck(
    function(err, data) {
      if (err) return cb(err);

      var url = '/v1/txproposals/' + txp.id + '/rejections/';
      var args = {
        reason: reason || '',
      };
      self._doPostRequest(url, args, data, cb);
    });
};

API.prototype.broadcastTxProposal = function(txp, cb) {
  var self = this;

  this._loadAndCheck(
    function(err, data) {
      if (err) return cb(err);

      var url = '/v1/txproposals/' + txp.id + '/broadcast/';
      self._doPostRequest(url, {}, data, cb);
    });
};



API.prototype.removeTxProposal = function(txp, cb) {
  var self = this;
  this._loadAndCheck(
    function(err, data) {
      if (err) return cb(err);
      var url = '/v1/txproposals/' + txp.id;
      self._doRequest('delete', url, {}, data, cb);
    });
};

module.exports = API;
