'use strict';

var chai = require('chai');
var sinon = require('sinon');
var should = chai.should();
var EventEmitter = require('events').EventEmitter;
var proxyquire = require('proxyquire');

var socket;

var FakeSocketIO = {
  connect: function() {
    return socket;
  }
}
var BitcoreNode = proxyquire('../../lib/blockchainexplorers/bitcorenode', {'socket.io-client': FakeSocketIO});

describe('BitcoreNode', function() {
  var opts = {
    network: 'testnet',
    url: 'http://localhost:3000'
  };

  before(function() {
    sinon.stub(BitcoreNode.prototype, 'connect', function(callback) {
      callback();
    });
  });

  after(function() {
    BitcoreNode.prototype.connect.restore();
  });

  describe('@constructor', function() {
    it('should set network and url', function() {
      var explorer = new BitcoreNode(opts);

      explorer.network.should.equal('testnet');
      explorer.url.should.equal('http://localhost:3000');
    });
  });

  describe('#getConnectionInfo', function() {
    it('should return the right info string', function() {
      var explorer = new BitcoreNode(opts);
      var result = explorer.getConnectionInfo();
      result.should.equal('BitcoreNode (testnet) @ http://localhost:3000');
    });
  });

  describe('#getUnspentUtxos', function() {
    it('should give the correct utxo data', function(done) {
      var explorer = new BitcoreNode(opts);
      var response = {
        result: [
          {
            address: 'n4RjVsaEJjEJSYxqQurCrF5QhG1nHG2Cga',
            txid: 'ca823f388f5234dc83ff3d94c9e302b324eca3aaf6fef0765f819e18a11925c7',
            outputIndex: 1,
            timestamp: '1380334964000',
            satoshis: 1499800000,
            script: '76a914fb4e21a7a4281668ff6fc91818f972495b5eb43b88ac',
            blockHeight: 109892,
            confirmations: 420230 
          }
        ]
      };

      explorer.socket = {
        send: function(data, callback) {
          callback(response);
        }
      };

      explorer.getUnspentUtxos(['n4RjVsaEJjEJSYxqQurCrF5QhG1nHG2Cga'], function(err, utxos) {
        should.not.exist(err);
        utxos.should.deep.equal(
          [
            { address: 'n4RjVsaEJjEJSYxqQurCrF5QhG1nHG2Cga',
              txid: 'ca823f388f5234dc83ff3d94c9e302b324eca3aaf6fef0765f819e18a11925c7',
              vout: 1,
              ts: 1380334964,
              scriptPubKey: '76a914fb4e21a7a4281668ff6fc91818f972495b5eb43b88ac',
              amount: 14.998,
              confirmations: 420230
            }
          ]
        );
        done();
      });
    });
    it('should return an empty array if a NoOutputs error is given', function(done) {
      var explorer = new BitcoreNode(opts);
      var response = {
        error: {
          message: 'NoOutputs'
        }
      };

      explorer.socket = {
        send: function(data, callback) {
          callback(response);
        }
      };

      explorer.getUnspentUtxos(['n4RjVsaEJjEJSYxqQurCrF5QhG1nHG2Cga'], function(err, utxos) {
        should.not.exist(err);
        utxos.should.deep.equal([]);
        done();
      });
    });
    it('should give an error if another error is given', function(done) {
      var explorer = new BitcoreNode(opts);
      var response = {
        error: {
          message: 'Another error'
        }
      };

      explorer.socket = {
        send: function(data, callback) {
          callback(response);
        }
      };

      explorer.getUnspentUtxos(['n4RjVsaEJjEJSYxqQurCrF5QhG1nHG2Cga'], function(err, utxos) {
        should.exist(err);
        done();
      });
    });
  });

  describe('#broadcast', function() {
    it('should return the txid of the transaction if successful', function(done) {
      var explorer = new BitcoreNode(opts);
      var response = {
        result: '4cb4fcdda98597e66881ed7908d73f0757c3dc8388d1aa03c33aa73c197182ba'
      };

      explorer.socket = {
        send: function(data, callback) {
          callback(response);
        }
      };

      explorer.broadcast('tx', function(err, txid) {
        should.not.exist(err);
        txid.should.equal(response.result);
        done();
      });
    });
    it('should give an error if there is an error', function(done) {
      var explorer = new BitcoreNode(opts);
      var response = {
        error: {
          message: 'error'
        }
      };

      explorer.socket = {
        send: function(data, callback) {
          callback(response);
        }
      };

      explorer.broadcast('tx', function(err, txid) {
        should.exist(err);
        err.message.should.equal('error');
        done();
      });
    });
  });

  describe('#getTransaction', function() {
    var hash = '4cb4fcdda98597e66881ed7908d73f0757c3dc8388d1aa03c33aa73c197182ba';
    it('should return the transaction if it exists with the txid on it', function(done) {
      var explorer = new BitcoreNode(opts);
      var response = {
        result: {
          hash: hash
        }
      };

      explorer.socket = {
        send: function(data, callback) {
          callback(response);
        }
      };

      explorer.getTransaction(hash, function(err, tx) {
        should.not.exist(err);
        tx.txid.should.equal(hash);
        done();
      });
    });
    it('should give a null tx but no error if the transaction does not exist', function(done) {
      var explorer = new BitcoreNode(opts);
      var response = {
        error: {
          message: 'NotFound'
        }
      };

      explorer.socket = {
        send: function(data, callback) {
          callback(response);
        }
      };

      explorer.getTransaction(hash, function(err, tx) {
        should.not.exist(err);
        should.not.exist(tx);
        done();
      });
    });
    it('should give an error if an error occurred', function(done) {
      var explorer = new BitcoreNode(opts);
      var response = {
        error: {
          message: 'other'
        }
      };

      explorer.socket = {
        send: function(data, callback) {
          callback(response);
        }
      };

      explorer.getTransaction(hash, function(err, tx) {
        should.exist(err);
        err.message.should.equal('other');
        done();
      });
    });
  });

  describe('#getTransactions', function() {
    it('should give the correct address activity', function(done) {
      var explorer = new BitcoreNode(opts);
      var response = {
        result: [
          {
            "address": "mkvHzEwt1vZiosen1hK7vgbUTxcnWghn7e",
            "satoshis": 2000000000,
            "height": 109659,
            "confirmations": 420463,
            "timestamp": 1380332118,
            "fees": 0,
            "outputIndexes": [
              1
            ],
            "inputIndexes": [],
            "tx": {
              "hash": "fb0d9cd116635c72e074276eb0e434417c1fc55657f70d3e42e59a9062f6b42a",
              "version": 1,
              "inputs": [
                {
                  "prevTxId": "89a2f4564b1f7a4ac71521b0ec6c5b6576e0254facf6a3663d3f165505949682",
                  "outputIndex": 1,
                  "sequenceNumber": 4294967295,
                  "script": "493046022100c372276ecaeb2c499d1e9065e76e176e74b3bbd7d5b54e9e1e752a5dbe9636e4022100f2831e0a8a7ac275037f81e64ca189d84ed34927a03f256d75946b31699a450601210297be0871e66af1aa0a0df38b7a9429ca04e782dbb104798bdd2e05f7bdca54a6",
                  "scriptString": "73 0x3046022100c372276ecaeb2c499d1e9065e76e176e74b3bbd7d5b54e9e1e752a5dbe9636e4022100f2831e0a8a7ac275037f81e64ca189d84ed34927a03f256d75946b31699a450601 33 0x0297be0871e66af1aa0a0df38b7a9429ca04e782dbb104798bdd2e05f7bdca54a6",
                  "output": {
                    "satoshis": 68274931377,
                    "script": "76a914cd11c4860436033f007e601c9085a4dd878e58b388ac"
                  }
                }
              ],
              "outputs": [
                {
                  "satoshis": 66274931377,
                  "script": "76a9147d3bf86c6d1e479e09e1262937fa8caf5059521a88ac"
                },
                {
                  "satoshis": 2000000000,
                  "script": "76a9143b42a2844f7cd5182e6ac8bd1c1e0793e63f689c88ac"
                }
              ],
              "nLockTime": 0
            }
          },
          {
            "address": "mkvHzEwt1vZiosen1hK7vgbUTxcnWghn7e",
            "satoshis": -2000000000,
            "height": 109892,
            "confirmations": 420230,
            "timestamp": 1380334964,
            "fees": 0,
            "outputIndexes": [],
            "inputIndexes": [
              "0"
            ],
            "tx": {
              "hash": "ca823f388f5234dc83ff3d94c9e302b324eca3aaf6fef0765f819e18a11925c7",
              "version": 1,
              "inputs": [
                {
                  "prevTxId": "fb0d9cd116635c72e074276eb0e434417c1fc55657f70d3e42e59a9062f6b42a",
                  "outputIndex": 1,
                  "sequenceNumber": 4294967295,
                  "script": "483045022100f85fb010efe7cfad961343de688bd3ad8ae97fee7310816d8be1a3d09fc745a5022047231151e0d4b294067201cbfd2b72e866e052e2cca3f18ae92dfbcd74a9a2d90121020f642974ce09e1076e65788e0c42bc301cf5bfb9339d5969e11527c05e8582a3",
                  "scriptString": "72 0x3045022100f85fb010efe7cfad961343de688bd3ad8ae97fee7310816d8be1a3d09fc745a5022047231151e0d4b294067201cbfd2b72e866e052e2cca3f18ae92dfbcd74a9a2d901 33 0x020f642974ce09e1076e65788e0c42bc301cf5bfb9339d5969e11527c05e8582a3",
                  "output": {
                    "satoshis": 2000000000,
                    "script": "76a9143b42a2844f7cd5182e6ac8bd1c1e0793e63f689c88ac"
                  }
                }
              ],
              "outputs": [
                {
                  "satoshis": 500200000,
                  "script": "76a914362e2c8417559740eea5708709cfdd90ee257d4788ac"
                },
                {
                  "satoshis": 1499800000,
                  "script": "76a914fb4e21a7a4281668ff6fc91818f972495b5eb43b88ac"
                }
              ],
              "nLockTime": 0
            }
          }
        ]
      };

      explorer.socket = {
        send: function(data, callback) {
          callback(response);
        }
      };

      explorer.getTransactions(["mkvHzEwt1vZiosen1hK7vgbUTxcnWghn7e"], null, null, function(err, activity) {
        should.not.exist(err);
        var expected = [
          {
              "txid": "ca823f388f5234dc83ff3d94c9e302b324eca3aaf6fef0765f819e18a11925c7",
              "version": 1,
              "locktime": 0,
              "vin": [
                  {
                      "txid": "fb0d9cd116635c72e074276eb0e434417c1fc55657f70d3e42e59a9062f6b42a",
                      "vout": 1,
                      "scriptSig": {
                          //"asm": "3045022100f85fb010efe7cfad961343de688bd3ad8ae97fee7310816d8be1a3d09fc745a5022047231151e0d4b294067201cbfd2b72e866e052e2cca3f18ae92dfbcd74a9a2d901 020f642974ce09e1076e65788e0c42bc301cf5bfb9339d5969e11527c05e8582a3",
                          "hex": "483045022100f85fb010efe7cfad961343de688bd3ad8ae97fee7310816d8be1a3d09fc745a5022047231151e0d4b294067201cbfd2b72e866e052e2cca3f18ae92dfbcd74a9a2d90121020f642974ce09e1076e65788e0c42bc301cf5bfb9339d5969e11527c05e8582a3"
                      },
                      "sequence": 4294967295,
                      //"n": 0,
                      "addr": "mkvHzEwt1vZiosen1hK7vgbUTxcnWghn7e",
                      "valueSat": 2000000000,
                      "value": 20,
                      "doubleSpentTxID": null
                  }
              ],
              "vout": [
                  {
                      "address": "mkTS6dZ1pgsCuXNyZGiVWEdebW8HZSJYFY",
                      "value": "5.00200000",
                      "n": 0,
                      "scriptPubKey": {
                          //"asm": "OP_DUP OP_HASH160 362e2c8417559740eea5708709cfdd90ee257d47 OP_EQUALVERIFY OP_CHECKSIG",
                          "hex": "76a914362e2c8417559740eea5708709cfdd90ee257d4788ac",
                          //"reqSigs": 1,
                          //"type": "pubkeyhash",
                          "addresses": [
                              "mkTS6dZ1pgsCuXNyZGiVWEdebW8HZSJYFY"
                          ]
                      },
                      //"spentTxId": "acc2e0a7c736568ad9dc067b97416398b245e29386ee5851d4e0ab95d8efba84",
                      //"spentIndex": 0,
                      //"spentTs": 1380959417
                  },
                  {
                      "address": "n4RjVsaEJjEJSYxqQurCrF5QhG1nHG2Cga",
                      "value": "14.99800000",
                      "n": 1,
                      "scriptPubKey": {
                          //"asm": "OP_DUP OP_HASH160 fb4e21a7a4281668ff6fc91818f972495b5eb43b OP_EQUALVERIFY OP_CHECKSIG",
                          "hex": "76a914fb4e21a7a4281668ff6fc91818f972495b5eb43b88ac",
                          //"reqSigs": 1,
                          //"type": "pubkeyhash",
                          "addresses": [
                              "n4RjVsaEJjEJSYxqQurCrF5QhG1nHG2Cga"
                          ]
                      }
                  }
              ],
              //"blockhash": "000000000004dd0740dba61037f6f029862099b1483efe3b860e4199269de951",
              "confirmations": 420230,
              "time": 1380334964,
              //"blocktime": 1380334964,
              //"valueOut": 20,
              //"size": 226,
              //"valueIn": 20,
              "fees": 0
          },
          {
              "txid": "fb0d9cd116635c72e074276eb0e434417c1fc55657f70d3e42e59a9062f6b42a",
              "version": 1,
              "locktime": 0,
              "vin": [
                  {
                      "txid": "89a2f4564b1f7a4ac71521b0ec6c5b6576e0254facf6a3663d3f165505949682",
                      "vout": 1,
                      "scriptSig": {
                          //"asm": "3046022100c372276ecaeb2c499d1e9065e76e176e74b3bbd7d5b54e9e1e752a5dbe9636e4022100f2831e0a8a7ac275037f81e64ca189d84ed34927a03f256d75946b31699a450601 0297be0871e66af1aa0a0df38b7a9429ca04e782dbb104798bdd2e05f7bdca54a6",
                          "hex": "493046022100c372276ecaeb2c499d1e9065e76e176e74b3bbd7d5b54e9e1e752a5dbe9636e4022100f2831e0a8a7ac275037f81e64ca189d84ed34927a03f256d75946b31699a450601210297be0871e66af1aa0a0df38b7a9429ca04e782dbb104798bdd2e05f7bdca54a6"
                      },
                      "sequence": 4294967295,
                      //"n": 0,
                      "addr": "mzDG6u5AXeM9yEyH41znLvVFhsha9dYMhW",
                      "valueSat": 68274931377,
                      "value": 682.74931377,
                      "doubleSpentTxID": null
                  }
              ],
              "vout": [
                  {
                      "address": "mrw8brEDm7Qz49xxXFhbnSy1KtByGvRCJd",
                      "value": "662.74931377",
                      "n": 0,
                      "scriptPubKey": {
                          //"asm": "OP_DUP OP_HASH160 7d3bf86c6d1e479e09e1262937fa8caf5059521a OP_EQUALVERIFY OP_CHECKSIG",
                          "hex": "76a9147d3bf86c6d1e479e09e1262937fa8caf5059521a88ac",
                          //"reqSigs": 1,
                          //"type": "pubkeyhash",
                          "addresses": [
                              "mrw8brEDm7Qz49xxXFhbnSy1KtByGvRCJd"
                          ]
                      },
                      //"spentTxId": "ce76f29ea4a5ab910027b8cf125390dc1558562bad1b56b6ac0385c1e6fc241b",
                      //"spentIndex": 0,
                      //"spentTs": 1380338701
                  },
                  {
                      "address": "mkvHzEwt1vZiosen1hK7vgbUTxcnWghn7e",
                      "value": "20.00000000",
                      "n": 1,
                      "scriptPubKey": {
                          //"asm": "OP_DUP OP_HASH160 3b42a2844f7cd5182e6ac8bd1c1e0793e63f689c OP_EQUALVERIFY OP_CHECKSIG",
                          "hex": "76a9143b42a2844f7cd5182e6ac8bd1c1e0793e63f689c88ac",
                          //"reqSigs": 1,
                          //"type": "pubkeyhash",
                          "addresses": [
                              "mkvHzEwt1vZiosen1hK7vgbUTxcnWghn7e"
                          ]
                      },
                      //"spentTxId": "ca823f388f5234dc83ff3d94c9e302b324eca3aaf6fef0765f819e18a11925c7",
                      //"spentIndex": 0,
                      //"spentTs": 1380334964
                  }
              ],
              //"blockhash": "00000000002631c7174f9aa5ed66a7f02a3b71d00e566d598eedbeea67f2bed2",
              "confirmations": 420463,
              "time": 1380332118,
              //"blocktime": 1380332118,
              //"valueOut": 682.74931377,
              //"size": 227,
              //"valueIn": 682.74931377,
              "fees": 0
          }
        ];
        activity.should.deep.equal(expected);
        done();
      });
    });
    it('should give an error if an error occurred', function(done) {
      var explorer = new BitcoreNode(opts);
      var response = {
        error: {
          message: 'error'
        }
      };

      explorer.socket = {
        send: function(data, callback) {
          callback(response);
        }
      };

      explorer.getTransactions(['mkvHzEwt1vZiosen1hK7vgbUTxcnWghn7e'], null, null, function(err, activity) {
        should.exist(err);
        err.message.should.equal('error');
        done();
      });
    });
  });

  describe('#getAddressActivity', function() {
    it('should return true if there is address activity', function(done) {
      var explorer = new BitcoreNode(opts);
      explorer.getTransactions = sinon.stub().callsArgWith(3, null, ['one', 'two']);

      explorer.getAddressActivity(['mkvHzEwt1vZiosen1hK7vgbUTxcnWghn7e'], function(err, hasHistory) {
        should.not.exist(err);
        hasHistory.should.equal(true);
        done();
      });
    });
    it('should return false if there is no address activity', function(done) {
      var explorer = new BitcoreNode(opts);
      explorer.getTransactions = sinon.stub().callsArgWith(3, null, []);

      explorer.getAddressActivity(['mkvHzEwt1vZiosen1hK7vgbUTxcnWghn7e'], function(err, hasHistory) {
        should.not.exist(err);
        hasHistory.should.equal(false);
        done();
      });
    });
    it('should give an error if an error occured', function(done) {
      var explorer = new BitcoreNode(opts);
      explorer.getTransactions = sinon.stub().callsArgWith(3, new Error('error'));

      explorer.getAddressActivity(['mkvHzEwt1vZiosen1hK7vgbUTxcnWghn7e'], function(err, hasHistory) {
        should.exist(err);
        err.message.should.equal('error');
        done();
      });
    });
  });

  describe('#estimateFee', function() {
    it('should give the intended response', function(done) {
      var explorer = new BitcoreNode(opts);
      var response = {
        result: 1000
      };

      explorer.socket = {
        send: function(data, callback) {
          callback(response);
        }
      };

      explorer.estimateFee(2, function(err, result) {
        should.not.exist(err);
        result.should.deep.equal({
          feePerKB: 0.00001
        });
        done();
      });
    });
    it('should give an error if an error occurred', function(done) {
      var explorer = new BitcoreNode(opts);
      var response = {
        error: {
          message: 'error'
        }
      };

      explorer.socket = {
        send: function(data, callback) {
          callback(response);
        }
      };

      explorer.estimateFee(2, function(err, result) {
        should.exist(err);
        err.message.should.equal('error');
        done();
      });
    });
  });

  describe('#initSocket', function() {
    it('should proxy the connect event', function(done) {
      var explorer = new BitcoreNode(opts);
      socket = new EventEmitter();

      var proxy = explorer.initSocket();
      proxy.on('connect', function(arg1, arg2) {
        arg1.should.equal('arg1');
        arg2.should.equal('arg2');
        done();
      });

      explorer.socket.emit('connect', 'arg1', 'arg2');
    });

    it('should proxy the connect_error event', function(done) {
      var explorer = new BitcoreNode(opts);
      socket = new EventEmitter();

      var proxy = explorer.initSocket();
      proxy.on('connect_error', function(data) {
        data.should.equal('data');
        done();
      });

      explorer.socket.emit('connect_error', 'data');
    });

    it('should subscribe to transaction and block events when inv is emitted', function(done) {
      var explorer = new BitcoreNode(opts);
      socket = new EventEmitter();

      var times = 0;

      socket.on('subscribe', function(channel) {
        if(times === 0) {
          channel.should.equal('transaction');
        } else if(times === 1) {
          channel.should.equal('block');
          done();
        }
        times++;
      });

      var proxy = explorer.initSocket();
      proxy.emit('subscribe', 'inv');
    });

    it('should proxy transaction events', function(done) {
      var explorer = new BitcoreNode(opts);
      socket = new EventEmitter();

      var bitcoreNodeTx = {
        "rejected": false,
        "tx": {
          "hash": "143d0b2ec92a0024ed3efcde21f062bb711046c029898125ca3530456609a601",
          "version": 1,
          "inputs": [
            {
              "prevTxId": "8711d2698193a4d098e11b90cc9b460903993ed60d60d6bd9bc9fe54f31d686a",
              "outputIndex": 0,
              "sequenceNumber": 4294967295,
              "script": "473044022065d0bdab62e117735e4fa228ebe93423559440807f51566d68cd8d24052a60f70220026fc0ecad76fdebc76958f9f25b4df321b5908b695a6ed598342d136b76d88901210312fd2e64ccbaf81a611453cbfb1a2a59b35c3ed2a9bdb906e03e94c4e0999ba1",
              "scriptString": "71 0x3044022065d0bdab62e117735e4fa228ebe93423559440807f51566d68cd8d24052a60f70220026fc0ecad76fdebc76958f9f25b4df321b5908b695a6ed598342d136b76d88901 33 0x0312fd2e64ccbaf81a611453cbfb1a2a59b35c3ed2a9bdb906e03e94c4e0999ba1"
            }
          ],
          "outputs": [
            {
              "satoshis": 40000,
              "script": "76a91419a3402806c7e26d7201be322fdf17813b34124f88ac"
            },
            {
              "satoshis": 0,
              "script": "6a0001004caab9aea56399c190da747ea86c24b99a310bff3b839858ef2a79dfbccddd67"
            }
          ],
          "nLockTime": 0
        }
      };

      var proxy = explorer.initSocket();
      proxy.on('tx', function(tx) {
        tx.should.deep.equal({
          "txid": "143d0b2ec92a0024ed3efcde21f062bb711046c029898125ca3530456609a601",
          "vout": [
            {
              "mhrWkhceuHsHGLUdyT3qa4RKevHC9uZZEJ": 40000
            }
          ],
          "valueOut": 0.0004
        });
        done();
      });

      socket.emit('transaction', bitcoreNodeTx);
    });

    it('should proxy block events', function(done) {
      var explorer = new BitcoreNode(opts);
      socket = new EventEmitter();
      var hash = '00000000000000001385d80432d5e767a1b99d2c3616178057c1ec1cc3179baf';

      var proxy = explorer.initSocket();

      proxy.on('block', function(hash) {
        hash.should.equal(hash);
      });

      socket.emit('block', hash);
      done();
    });
  });
});