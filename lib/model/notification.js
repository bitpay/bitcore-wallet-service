var _ = require('lodash');
var Uuid = require('uuid');
var bitcore = require('bitcore');
var Hash = bitcore.crypto.Hash;

/*
 * notifications examples
 *
 * NewCopayer -
 * NewAddress -
 * NewTxProposal - (amount)
 * TxProposalAcceptedBy - (txProposalId, copayerId)
 * TxProposalRejectedBy -  (txProposalId, copayerId)
 * txProposalFinallyRejected - txProposalId
 * txProposalFinallyAccepted - txProposalId
 *
 * NewIncomingTx (address, txid)
 * NewOutgoingTx - (txProposalId, txid)
 *
 * data Examples:
 * { amount: 'xxx', address: 'xxx'}
 * { txProposalId: 'xxx', copayerId: 'xxx' }
 *
 * Data is meant to provide only the needed information
 * to notify the user
 *
 */
function Notification() {};

Notification.create = function(opts) {
  opts = opts || {};

  var x = new Notification();

  x.version = '1.0.0';
  var now = Date.now();
  x.createdOn = Math.floor(now / 1000);
  x.id = _.padLeft(now, 14, '0') + _.padLeft(opts.ticker || 0, 4, '0');
  x.type = opts.type || 'general';
  x.data = opts.data;
  x.walletId = opts.walletId;
  x.creatorId = opts.creatorId;
  x.hash = Notification.getHash(x);

  return x;
};

Notification.getHash = function(x) {
  var dataToHash = new Buffer(x.version + x.type + JSON.stringify(x.data) + x.walletId, 'utf-8');
  return Hash.sha256sha256(dataToHash);
};

Notification.fromObj = function(obj) {
  var x = new Notification();

  x.version = obj.version;
  x.createdOn = obj.createdOn;
  x.id = obj.id;
  x.type = obj.type;
  x.data = obj.data;
  x.walletId = obj.walletId;
  x.creatorId = obj.creatorId;
  x.hash = obj.hash;

  return x;
};

module.exports = Notification;
