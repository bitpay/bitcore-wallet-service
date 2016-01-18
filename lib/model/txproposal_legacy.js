'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var Uuid = require('uuid');
var log = require('npmlog');
log.debug = log.verbose;
log.disableColor();

var Bitcore = require('bitcore-lib');

var Common = require('../common');
var Constants = Common.Constants;
var Defaults = Common.Defaults;

var TxProposalAction = require('./txproposalaction');

function TxProposal() {};

TxProposal.Types = {
  SIMPLE: 'simple',
  MULTIPLEOUTPUTS: 'multiple_outputs',
  EXTERNAL: 'external'
};

TxProposal.isTypeSupported = function(type) {
  return _.contains(_.values(TxProposal.Types), type);
};

TxProposal._create = {};

TxProposal._create.simple = function(txp, opts) {
  txp.toAddress = opts.toAddress;
  txp.amount = opts.amount;
  txp.outputOrder = _.shuffle(_.range(2));
  try {
    txp.network = Bitcore.Address(txp.toAddress).toObject().network;
  } catch (ex) {}
};

TxProposal._create.undefined = TxProposal._create.simple;

TxProposal._create.multiple_outputs = function(txp, opts) {
  txp.outputs = _.map(opts.outputs, function(output) {
    return _.pick(output, ['amount', 'toAddress', 'message']);
  });
  txp.outputOrder = _.shuffle(_.range(txp.outputs.length + 1));
  txp.amount = txp.getTotalAmount();
  try {
    txp.network = Bitcore.Address(txp.outputs[0].toAddress).toObject().network;
  } catch (ex) {}
};

TxProposal._create.external = function(txp, opts) {
  txp.setInputs(opts.inputs || []);
  txp.outputs = opts.outputs;
  txp.outputOrder = _.range(txp.outputs.length + 1);
  txp.amount = txp.getTotalAmount();
  try {
    txp.network = Bitcore.Address(txp.outputs[0].toAddress).toObject().network;
  } catch (ex) {}
};

TxProposal.create = function(opts) {
  opts = opts || {};

  var x = new TxProposal();

  x.version = '2.0.0';
  x.type = opts.type || TxProposal.Types.SIMPLE;

  var now = Date.now();
  x.createdOn = Math.floor(now / 1000);
  x.id = _.padLeft(now, 14, '0') + Uuid.v4();
  x.walletId = opts.walletId;
  x.creatorId = opts.creatorId;
  x.message = opts.message;
  x.payProUrl = opts.payProUrl;
  x.proposalSignature = opts.proposalSignature;
  x.changeAddress = opts.changeAddress;
  x.inputs = [];
  x.inputPaths = [];
  x.requiredSignatures = opts.requiredSignatures;
  x.requiredRejections = opts.requiredRejections;
  x.walletN = opts.walletN;
  x.status = 'pending';
  x.actions = [];
  x.fee = null;
  x.feePerKb = opts.feePerKb;
  x.excludeUnconfirmedUtxos = opts.excludeUnconfirmedUtxos;
  x.proposalSignaturePubKey = opts.proposalSignaturePubKey;
  x.proposalSignaturePubKeySig = opts.proposalSignaturePubKeySig;
  x.addressType = opts.addressType || Constants.SCRIPT_TYPES.P2SH;
  x.derivationStrategy = opts.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP45;
  x.customData = opts.customData;

  if (_.isFunction(TxProposal._create[x.type])) {
    TxProposal._create[x.type](x, opts);
  }

  return x;
};

TxProposal.fromObj = function(obj) {
  var x = new TxProposal();

  x.version = obj.version;
  if (obj.version === '1.0.0') {
    x.type = TxProposal.Types.SIMPLE;
  } else {
    x.type = obj.type;
  }
  x.createdOn = obj.createdOn;
  x.id = obj.id;
  x.walletId = obj.walletId;
  x.creatorId = obj.creatorId;
  x.outputs = obj.outputs;
  x.toAddress = obj.toAddress;
  x.amount = obj.amount;
  x.message = obj.message;
  x.payProUrl = obj.payProUrl;
  x.proposalSignature = obj.proposalSignature;
  x.changeAddress = obj.changeAddress;
  x.inputs = obj.inputs;
  x.requiredSignatures = obj.requiredSignatures;
  x.requiredRejections = obj.requiredRejections;
  x.walletN = obj.walletN;
  x.status = obj.status;
  x.txid = obj.txid;
  x.broadcastedOn = obj.broadcastedOn;
  x.inputPaths = obj.inputPaths;
  x.actions = _.map(obj.actions, function(action) {
    return TxProposalAction.fromObj(action);
  });
  x.outputOrder = obj.outputOrder;
  x.fee = obj.fee;
  x.network = obj.network;
  x.feePerKb = obj.feePerKb;
  x.excludeUnconfirmedUtxos = obj.excludeUnconfirmedUtxos;
  x.proposalSignaturePubKey = obj.proposalSignaturePubKey;
  x.proposalSignaturePubKeySig = obj.proposalSignaturePubKeySig;
  x.addressType = obj.addressType || Constants.SCRIPT_TYPES.P2SH;
  x.derivationStrategy = obj.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP45;
  x.customData = obj.customData;

  return x;
};

TxProposal.prototype.toObject = function() {
  var x = _.cloneDeep(this);
  x.isPending = this.isPending();
  return x;
};

TxProposal.prototype.setInputs = function(inputs) {
  this.inputs = inputs;
  this.inputPaths = _.pluck(inputs, 'path');
};

TxProposal.prototype._updateStatus = function() {
  if (this.status != 'pending') return;

  if (this.isRejected()) {
    this.status = 'rejected';
  } else if (this.isAccepted()) {
    this.status = 'accepted';
  }
};

TxProposal.prototype._buildTx = function() {
  var self = this;

  var t = new Bitcore.Transaction();

  $.checkState(_.contains(_.values(Constants.SCRIPT_TYPES), self.addressType));

  switch (self.addressType) {
    case Constants.SCRIPT_TYPES.P2SH:
      _.each(self.inputs, function(i) {
        t.from(i, i.publicKeys, self.requiredSignatures);
      });
      break;
    case Constants.SCRIPT_TYPES.P2PKH:
      t.from(self.inputs);
      break;
  }

  if (self.toAddress && self.amount && !self.outputs) {
    t.to(self.toAddress, self.amount);
  } else if (self.outputs) {
    _.each(self.outputs, function(o) {
      $.checkState(o.script || o.toAddress, 'Output should have either toAddress or script specified');
      if (o.script) {
        t.addOutput(new Bitcore.Transaction.Output({
          script: o.script,
          satoshis: o.amount
        }));
      } else {
        t.to(o.toAddress, o.amount);
      }
    });
  }

  if (_.startsWith(self.version, '1.')) {
    Bitcore.Transaction.FEE_SECURITY_MARGIN = 1;
    t.feePerKb(self.feePerKb);
  } else {
    t.fee(self.fee);
  }

  t.change(self.changeAddress.address);

  // Shuffle outputs for improved privacy
  if (t.outputs.length > 1) {
    var outputOrder = _.reject(self.outputOrder, function(order) {
      return order >= t.outputs.length;
    });
    $.checkState(t.outputs.length == outputOrder.length);
    t.sortOutputs(function(outputs) {
      return _.map(outputOrder, function(i) {
        return outputs[i];
      });
    });
  }

  // Validate inputs vs outputs independently of Bitcore
  var totalInputs = _.reduce(self.inputs, function(memo, i) {
    return +i.satoshis + memo;
  }, 0);
  var totalOutputs = _.reduce(t.outputs, function(memo, o) {
    return +o.satoshis + memo;
  }, 0);

  $.checkState(totalInputs - totalOutputs <= Defaults.MAX_TX_FEE);

  return t;
};


TxProposal.prototype._getCurrentSignatures = function() {
  var acceptedActions = _.filter(this.actions, {
    type: 'accept'
  });

  return _.map(acceptedActions, function(x) {
    return {
      signatures: x.signatures,
      xpub: x.xpub,
    };
  });
};

TxProposal.prototype.getBitcoreTx = function() {
  var self = this;

  var t = this._buildTx();

  var sigs = this._getCurrentSignatures();
  _.each(sigs, function(x) {
    self._addSignaturesToBitcoreTx(t, x.signatures, x.xpub);
  });

  return t;
};

TxProposal.prototype.getNetworkName = function() {
  return Bitcore.Address(this.changeAddress.address).toObject().network;
};

TxProposal.prototype.getRawTx = function() {
  var t = this.getBitcoreTx();

  return t.uncheckedSerialize();
};

TxProposal.prototype.getEstimatedSize = function() {
  // Note: found empirically based on all multisig P2SH inputs and within m & n allowed limits.
  var safetyMargin = 0.05;
  var walletM = this.requiredSignatures;

  var overhead = 4 + 4 + 9 + 9;
  var inputSize = walletM * 72 + this.walletN * 36 + 44;
  var outputSize = 34;
  var nbInputs = this.inputs.length;
  var nbOutputs = (_.isArray(this.outputs) ? this.outputs.length : 1) + 1;

  var size = overhead + inputSize * nbInputs + outputSize * nbOutputs;

  return parseInt((size * (1 + safetyMargin)).toFixed(0));
};

TxProposal.prototype.estimateFee = function() {
  var fee = this.feePerKb * this.getEstimatedSize() / 1000;

  this.fee = parseInt(fee.toFixed(0));
};

/**
 * getTotalAmount
 *
 * @return {Number} total amount of all outputs excluding change output
 */
TxProposal.prototype.getTotalAmount = function() {
  if (this.type == TxProposal.Types.MULTIPLEOUTPUTS || this.type == TxProposal.Types.EXTERNAL) {
    return _.pluck(this.outputs, 'amount')
      .reduce(function(total, n) {
        return total + n;
      }, 0);
  } else {
    return this.amount;
  }
};

/**
 * getActors
 *
 * @return {String[]} copayerIds that performed actions in this proposal (accept / reject)
 */
TxProposal.prototype.getActors = function() {
  return _.pluck(this.actions, 'copayerId');
};


/**
 * getApprovers
 *
 * @return {String[]} copayerIds that approved the tx proposal (accept)
 */
TxProposal.prototype.getApprovers = function() {
  return _.pluck(
    _.filter(this.actions, {
      type: 'accept'
    }), 'copayerId');
};

/**
 * getActionBy
 *
 * @param {String} copayerId
 * @return {Object} type / createdOn
 */
TxProposal.prototype.getActionBy = function(copayerId) {
  return _.find(this.actions, {
    copayerId: copayerId
  });
};

TxProposal.prototype.addAction = function(copayerId, type, comment, signatures, xpub) {
  var action = TxProposalAction.create({
    copayerId: copayerId,
    type: type,
    signatures: signatures,
    xpub: xpub,
    comment: comment,
  });
  this.actions.push(action);
  this._updateStatus();
};

TxProposal.prototype._addSignaturesToBitcoreTx = function(tx, signatures, xpub) {
  var self = this;

  if (signatures.length != this.inputs.length)
    throw new Error('Number of signatures does not match number of inputs');

  var i = 0,
    x = new Bitcore.HDPublicKey(xpub);

  _.each(signatures, function(signatureHex) {
    var input = self.inputs[i];
    try {
      var signature = Bitcore.crypto.Signature.fromString(signatureHex);
      var pub = x.derive(self.inputPaths[i]).publicKey;
      var s = {
        inputIndex: i,
        signature: signature,
        sigtype: Bitcore.crypto.Signature.SIGHASH_ALL,
        publicKey: pub,
      };
      tx.inputs[i].addSignature(tx, s);
      i++;
    } catch (e) {};
  });

  if (i != tx.inputs.length)
    throw new Error('Wrong signatures');
};


TxProposal.prototype.sign = function(copayerId, signatures, xpub) {
  try {
    // Tests signatures are OK
    var tx = this.getBitcoreTx();
    this._addSignaturesToBitcoreTx(tx, signatures, xpub);

    this.addAction(copayerId, 'accept', null, signatures, xpub);

    if (this.status == 'accepted') {
      this.raw = tx.uncheckedSerialize();
      this.txid = tx.id;
    }

    return true;
  } catch (e) {
    log.debug(e);
    return false;
  }
};

TxProposal.prototype.reject = function(copayerId, reason) {
  this.addAction(copayerId, 'reject', reason);
};

TxProposal.prototype.isPending = function() {
  return !_.contains(['broadcasted', 'rejected'], this.status);
};

TxProposal.prototype.isAccepted = function() {
  var votes = _.countBy(this.actions, 'type');
  return votes['accept'] >= this.requiredSignatures;
};

TxProposal.prototype.isRejected = function() {
  var votes = _.countBy(this.actions, 'type');
  return votes['reject'] >= this.requiredRejections;
};

TxProposal.prototype.isBroadcasted = function() {
  return this.status == 'broadcasted';
};

TxProposal.prototype.setBroadcasted = function() {
  $.checkState(this.txid);
  this.status = 'broadcasted';
  this.broadcastedOn = Math.floor(Date.now() / 1000);
};

module.exports = TxProposal;
