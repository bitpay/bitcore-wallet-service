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

      helpers.createAndJoinWallet(2, 3, function(s, w) {
        server = s;
        wallet = w;

        var bcmonitor = new BlockchainMonitor();
        bcmonitor.start({
          lockOpts: {},
          messageBroker: server.messageBroker,
          storage: storage,
          blockchainExplorers: {
            'btc': {
              'testnet': blockchainExplorer,
              'livenet': blockchainExplorer
            }
          },
        }, function(err) {
          should.not.exist(err);
          done();
        });
      });
    });
  });

  it('should notify copayers of incoming txs', function(done) {
    server.createAddress({}, function(err, address) {
      should.not.exist(err);

      var incoming = {
        txid: '123',
        vout: [{}],
      };
      incoming.vout[0][address.address] = 1500;
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
          notification.data.address.should.equal(address.address);
          notification.data.amount.should.equal(1500);
          done();
        });
      }, 100);
    });
  });

  it('should update addressWithBalance cache on 1 incoming tx', function(done) {
    server.createAddress({}, function(err, address) {
      should.not.exist(err);
      var incoming = {
        txid: '123',
        vout: [{}],
      };
      server.storage.fetchAddressesWithBalance(wallet.id, function(err,ret) {
        should.not.exist(err);
        _.isEmpty(ret).should.equal(true);
        incoming.vout[0][address.address] = 1500;
        socket.handlers['tx'](incoming);
        setTimeout(function() {
          server.storage.fetchAddressesWithBalance(wallet.id, function(err,ret) {
            should.not.exist(err);
            ret.length.should.equal(1);
            ret[0].address.should.equal(address.address);
            done();
          });
        }, 100);
      });
    });
  });

  it('should update addressWithBalance cache on 2 incoming tx, same address', function(done) {
    server.createAddress({}, function(err, address) {
      should.not.exist(err);

      server.storage.fetchAddressesWithBalance(wallet.id, function(err,ret) {
        should.not.exist(err);
        _.isEmpty(ret).should.equal(true);

        var incoming = {
          txid: '123',
          vout: [{}],
        };
        incoming.vout[0][address.address] = 1500;

        socket.handlers['tx'](incoming);
        setTimeout(function() {


          var incoming2 = {
            txid: '456',
            vout: [{}],
          };
          incoming2.vout[0][address.address] = 2500;
          socket.handlers['tx'](incoming2);

          setTimeout(function() {
            server.storage.fetchAddressesWithBalance(wallet.id, function(err,ret) {
              should.not.exist(err);
              ret.length.should.equal(1);
              ret[0].address.should.equal(address.address);
              done();
            });
          }, 100);
        }, 100);
      });
    });
  });


  it('should update addressWithBalance cache on 2 incoming tx, different address', function(done) {
    server.createAddress({}, function(err, address) {
      should.not.exist(err);
      server.createAddress({}, function(err, address2) {
        should.not.exist(err);
        server.storage.fetchAddressesWithBalance(wallet.id, function(err,ret) {
          should.not.exist(err);
          _.isEmpty(ret).should.equal(true);

          var incoming = {
            txid: '123',
            vout: [{}],
          };
          incoming.vout[0][address.address] = 1500;
          socket.handlers['tx'](incoming);

          setTimeout(function() {

            var incoming2 = {
              txid: '456',
              vout: [{}],
            };
            incoming2.vout[0][address2.address] = 500;
            socket.handlers['tx'](incoming2);

            setTimeout(function() {
              server.storage.fetchAddressesWithBalance(wallet.id, function(err,ret) {
                should.not.exist(err);
                ret.length.should.equal(2);
                ret[0].address.should.equal(address.address);
                done();
              });
            }, 100);
          }, 100);
        });
      });
    });
  });





  it('should not notify copayers of incoming txs more than once', function(done) {
    server.createAddress({}, function(err, address) {
      should.not.exist(err);

      var incoming = {
        txid: '123',
        vout: [{}],
      };
      incoming.vout[0][address.address] = 1500;
      socket.handlers['tx'](incoming);
      setTimeout(function() {
        socket.handlers['tx'](incoming);

        setTimeout(function() {
          server.getNotifications({}, function(err, notifications) {
            should.not.exist(err);
            var notification = _.filter(notifications, {
              type: 'NewIncomingTx'
            });
            notification.length.should.equal(1);
            done();
          });
        }, 100);
      }, 50);
    });
  });

  it('should notify copayers of tx confirmation', function(done) {
    server.createAddress({}, function(err, address) {
      should.not.exist(err);

      var incoming = {
        txid: '123',
        vout: [{}],
      };
      incoming.vout[0][address.address] = 1500;

      server.txConfirmationSubscribe({
        txid: '123'
      }, function(err) {
        should.not.exist(err);

        blockchainExplorer.getTxidsInBlock = sinon.stub().callsArgWith(1, null, ['123', '456']);
        socket.handlers['block']('block1');

        setTimeout(function() {
          blockchainExplorer.getTxidsInBlock = sinon.stub().callsArgWith(1, null, ['123', '456']);
          socket.handlers['block']('block2');

          setTimeout(function() {
            server.getNotifications({}, function(err, notifications) {
              should.not.exist(err);
              var notifications = _.filter(notifications, {
                type: 'TxConfirmation'
              });
              notifications.length.should.equal(1);
              var n = notifications[0];
              n.walletId.should.equal(wallet.id);
              n.creatorId.should.equal(server.copayerId);
              n.data.txid.should.equal('123');
              done();
            });
          }, 50);
        }, 50);
      });
    });
  });
});
