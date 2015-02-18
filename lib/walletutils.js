var _ = require('lodash');
var Bitcore = require('bitcore');
var Address = Bitcore.Address;
var PrivateKey = Bitcore.PrivateKey;
var PublicKey = Bitcore.PublicKey;
var crypto = Bitcore.crypto;
var HDPath = require('./hdpath');

function WalletUtils() {};

/* TODO: It would be nice to be compatible with bitcoind signmessage. How
 * the hash is calculated there? */
WalletUtils.hashMessage = function(text) {
  var buf = new Buffer(text);
  var ret = crypto.Hash.sha256sha256(buf);
  ret = new Bitcore.encoding.BufferReader(ret).readReverse();
  return ret;
};


WalletUtils.signMessage = function(text, privKey) {
  var priv = new PrivateKey(privKey);
  var hash = WalletUtils.hashMessage(text);
  return crypto.ECDSA.sign(hash, priv, 'little').toString();
};


WalletUtils.verifyMessage = function(text, signature, pubKey) {
  var pub = new PublicKey(pubKey);
  var hash = WalletUtils.hashMessage(text);

  try {
    var sig = new crypto.Signature.fromString(signature);
    return crypto.ECDSA.verify(hash, sig, pub, 'little');
  } catch (e) {
    return false;
  }
};

WalletUtils.deriveAddress = function(publicKeyRing, path, m, network) {

  var publicKeys = _.map(publicKeyRing, function(xPubKey) {
    var xpub = new Bitcore.HDPublicKey(xPubKey);
    return xpub.derive(path).publicKey;
  });

  var bitcoreAddress = Address.createMultisig(publicKeys, m, network);

  return {
    address: bitcoreAddress.toString(),
    path: path,
    publicKeys: _.invoke(publicKeys, 'toString'),
  };
};

WalletUtils.getProposalHash = function(toAddress, amount, message) {
  return toAddress + '|' + amount + '|' + (message || '');
};

WalletUtils.xPubToCopayerId = function(xpub) {
  return (new Bitcore.HDPublicKey(xpub)).derive(HDPath.IdBranch).publicKey.toString();
};

WalletUtils.toSecret = function(walletId, walletPrivKey, network) {
  return  walletId + ':' + walletPrivKey.toWIF() + ':' + (network == 'testnet' ? 'T' : 'L');
};

WalletUtils.fromSecret = function(secret) {
  var secretSplit = secret.split(':');
  var walletId = secretSplit[0];
  var walletPrivKey = Bitcore.PrivateKey.fromString(secretSplit[1]);
  var networkChar = secretSplit[2];


  return  { 
    walletId: walletId,
    walletPrivKey: walletPrivKey,
    network: networkChar == 'T' ? 'testnet' : 'livenet',
  };
};




module.exports = WalletUtils;
