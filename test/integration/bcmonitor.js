'use strict';

var _ = require('lodash');
var async = require('async');

var chai = require('chai');
var sinon = require('sinon');
var should = chai.should();
var log = require('npmlog');
log.debug = log.verbose;
log.level = 'info';

var WalletService = require('../../lib/server');
var BlockchainMonitor = require('../../lib/blockchainmonitor');

var TestData = require('../testdata');
var helpers = require('./helpers');
var storage, blockchainExplorer;

var socket = {
  handlers: {},
};
socket.on = function(eventName, handler) {
  this.handlers[eventName] = handler;
};

describe('Blockchain monitor', function() {
  var server, wallet;

  before(function(done) {
    helpers.before(done);
  });
  after(function(done) {
    helpers.after(done);
  });
  beforeEach(function(done) {
    helpers.beforeEach(function(res) {
      storage = res.storage;
      blockchainExplorer = res.blockchainExplorer;
      blockchainExplorer.initSocket = sinon.stub().returns(socket);
      blockchainExplorer.getBlock = sinon.stub().yields(null);

      helpers.createAndJoinWallet(2, 3, function(s, w) {
        server = s;
        wallet = w;
        var bcmonitor = new BlockchainMonitor();
        bcmonitor.start({
          lockOpts: {},
          messageBroker: server.messageBroker,
          storage: storage,
          blockchainExplorers: {
            'testnet': blockchainExplorer,
            'livenet': blockchainExplorer
          },
        }, function(err) {
          should.not.exist(err);
          done();
        });
      });
    });
  });

  it('should notify copayers of incoming txs', function(done) {

    var incoming = {
      txid: '123',
      vout: [{}],
    };
    var address;

    server.createAddress({}, function(err, a) {
      should.not.exist(err);
      address = a.address;

      incoming.vout[0][address] = 1500;
      socket.handlers['tx'](incoming);


      setTimeout(function() {
        server.getNotifications({}, function(err, notifications) {
          should.not.exist(err);
          var notification = _.find(notifications, {
            type: 'NewIncomingTx'
          });
          should.exist(notification);
          notification.walletId.should.equal(wallet.id);
          notification.data.txid.should.equal('123');
          notification.data.address.should.equal(address);
          notification.data.amount.should.equal(1500);
          done();
        });
      }, 100);
    });
  });

  it('should update address lastUsedOn for incoming txs', function(done) {

    var incoming = {
      txid: '123',
      vout: [{}, {}],
    };
    var address, address2;
    var aLongTimeAgo = Date.now() - (1000 * 10 * 86400);

    var clock = sinon.useFakeTimers(aLongTimeAgo, 'Date');

    server.createAddress({}, function(err, a) {
      should.not.exist(err);
      address = a.address;

      server.createAddress({}, function(err, a2) {
        should.not.exist(err);
        address2 = a2.address;

        clock.restore();

        storage.fetchRecentAddresses(wallet.id, (Date.now() / 1000) - 100, function(err, addr) {
          addr.length.should.equal(0);

          incoming.vout[0][address] = 1500;
          incoming.vout[1][address2] = 150;

          socket.handlers['tx'](incoming);

          setTimeout(function() {
            storage.fetchRecentAddresses(wallet.id, (Date.now() / 1000) - 100, function(err, addr) {
              addr.length.should.equal(2);
              done();
            });
          }, 50);
        });
      });
    });
  });

  it.only('should process incoming blocks', function(done) {

    var incoming = {
      hash: '123',
    };
    var address;
    server.createAddress({}, function(err, a) {
      should.not.exist(err);
      address = a.address;

      // TODO add address to block data

      blockchainExplorer.getBlock = sinon.stub().yields(null, 'xxx');

      socket.handlers['block'](incoming);

      setTimeout(function() {
        done();
      }, 50);
    });
  });
});
