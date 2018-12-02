'use strict';

var _ = require('lodash');
var async = require('async');
var chai = require('chai');
var sinon = require('sinon');
var mongodb = require('mongodb');
var should = chai.should();
var Storage = require('../lib/storage');
var Model = require('../lib/model');
var config = require('./test-config');

var db, storage;

function resetDb(cb) {
  if (!db) return cb();
  db.dropDatabase(function(err) {
    return cb();
  });
};


describe('Storage', function() {
  before(function(done) {
    mongodb.MongoClient.connect(config.mongoDb.uri, function(err, db1) {
      if (err) throw err;
      db = db1;
      storage = new Storage({
        db: db1
      });
      done();
    });
  });
  beforeEach(function(done) {
    resetDb(done);
  });

  describe('Store & fetch wallet', function() {
    it('should correctly store and fetch wallet', function(done) {
      var wallet = Model.Wallet.create({
        id: '123',
        name: 'my wallet',
        m: 2,
        n: 3,
        coin: 'btc',
        network: 'livenet',
      });
      should.exist(wallet);
      storage.storeWallet(wallet, function(err) {
        should.not.exist(err);
        storage.fetchWallet('123', function(err, w) {
          should.not.exist(err);
          should.exist(w);
          w.id.should.equal(wallet.id);
          w.name.should.equal(wallet.name);
          w.m.should.equal(wallet.m);
          w.n.should.equal(wallet.n);
          done();
        })
      });
    });
    it('should not return error if wallet not found', function(done) {
      storage.fetchWallet('123', function(err, w) {
        should.not.exist(err);
        should.not.exist(w);
        done();
      });
    });
  });

  describe('Copayer lookup', function() {
    it('should correctly store and fetch copayer lookup', function(done) {
      var wallet = Model.Wallet.create({
        id: '123',
        name: 'my wallet',
        m: 2,
        n: 3,
        coin: 'btc',
        network: 'livenet',
      });
      _.each(_.range(3), function(i) {
        var copayer = Model.Copayer.create({
          coin: 'btc',
          name: 'copayer ' + i,
          xPubKey: 'xPubKey ' + i,
          requestPubKey: 'requestPubKey ' + i,
          signature: 'xxx',
        });
        wallet.addCopayer(copayer);
      });

      should.exist(wallet);
      storage.storeWalletAndUpdateCopayersLookup(wallet, function(err) {
        should.not.exist(err);
        storage.fetchCopayerLookup(wallet.copayers[1].id, function(err, lookup) {
          should.not.exist(err);
          should.exist(lookup);
          lookup.walletId.should.equal('123');
          lookup.requestPubKeys[0].key.should.equal('requestPubKey 1');
          lookup.requestPubKeys[0].signature.should.equal('xxx');
          done();
        })
      });
    });
    it('should not return error if copayer not found', function(done) {
      storage.fetchCopayerLookup('2', function(err, lookup) {
        should.not.exist(err);
        should.not.exist(lookup);
        done();
      });
    });
  });

  describe('Transaction proposals', function() {
    var wallet, proposals;

    beforeEach(function(done) {
      wallet = Model.Wallet.create({
        id: '123',
        name: 'my wallet',
        m: 2,
        n: 3,
        coin: 'btc',
        network: 'livenet',
      });
      _.each(_.range(3), function(i) {
        var copayer = Model.Copayer.create({
          coin: 'btc',
          name: 'copayer ' + i,
          xPubKey: 'xPubKey ' + i,
          requestPubKey: 'requestPubKey ' + i,
          signature: 'signarture ' + i,
        });
        wallet.addCopayer(copayer);
      });
      should.exist(wallet);
      storage.storeWalletAndUpdateCopayersLookup(wallet, function(err) {
        should.not.exist(err);

        proposals = _.map(_.range(4), function(i) {
          var tx = Model.TxProposal.create({
            walletId: '123',
            coin: 'btc',
            network: 'livenet',
            outputs: [{
              toAddress: '18PzpUFkFZE8zKWUPvfykkTxmB9oMR8qP7',
              amount: i + 100,
            }],
            feePerKb: 100e2,
            creatorId: wallet.copayers[0].id,
          });
          if (i % 2 == 0) {
            tx.status = 'pending';
            tx.isPending().should.be.true;
          } else {
            tx.status = 'rejected';
            tx.isPending().should.be.false;
          }
          tx.txid = 'txid' + i;
          return tx;
        });
        async.each(proposals, function(tx, next) {
          storage.storeTx('123', tx, next);
        }, function(err) {
          should.not.exist(err);
          done();
        });
      });
    });
    it('should fetch tx', function(done) {
      storage.fetchTx('123', proposals[0].id, function(err, tx) {
        should.not.exist(err);
        should.exist(tx);
        tx.id.should.equal(proposals[0].id);
        tx.walletId.should.equal(proposals[0].walletId);
        tx.creatorName.should.equal('copayer 0');
        done();
      });
    });
    it('should fetch tx by hash', function(done) {
      storage.fetchTxByHash('txid0', function(err, tx) {
        should.not.exist(err);
        should.exist(tx);
        tx.id.should.equal(proposals[0].id);
        tx.walletId.should.equal(proposals[0].walletId);
        tx.creatorName.should.equal('copayer 0');
        done();
      });
    });

    it('should fetch all pending txs', function(done) {
      storage.fetchPendingTxs('123', function(err, txs) {
        should.not.exist(err);
        should.exist(txs);
        txs.length.should.equal(2);
        txs = _.sortBy(txs, 'amount');
        txs[0].amount.should.equal(100);
        txs[1].amount.should.equal(102);
        done();
      });
    });
    it('should remove tx', function(done) {
      storage.removeTx('123', proposals[0].id, function(err) {
        should.not.exist(err);
        storage.fetchTx('123', proposals[0].id, function(err, tx) {
          should.not.exist(err);
          should.not.exist(tx);
          storage.fetchTxs('123', {}, function(err, txs) {
            should.not.exist(err);
            should.exist(txs);
            txs.length.should.equal(3);
            _.some(txs, {
              id: proposals[0].id
            }).should.be.false;
            done();
          });
        });
      });
    });
  });
});
