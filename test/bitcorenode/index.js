'use strict';

var should = require('chai').should();
var proxyquire = require('proxyquire');
var bitcore = require('bitcore');
var sinon = require('sinon');
var Service = require('../../bitcorenode/index.js');

describe('Bitcore Node Service', function() {
  describe('#constructor', function() {
    it('https settings from node', function() {
      var node = {
        https: true,
        httpsOptions: {
          key: 'key',
          cert: 'cert'
        }
      };
      var options = {
        node: node
      };
      var service = new Service(options);
      service.node.should.equal(node);
      service.options.should.equal(options);
    });
  });
  describe('#_getConfiguration', function() {
    it('will throw with an unknown network', function() {
      var options = {
        node: {
          network: 'unknown'
        }
      };
      var service = new Service(options);
      (function() {
        service._getConfiguration();
      }).should.throw('Unknown network');
    });
    it('livenet local insight', function() {
      var options = {
        node: {
          network: bitcore.Networks.livenet,
          port: 3001
        }
      };
      var service = new Service(options);
      var config = service._getConfiguration();
      config.blockchainExplorerOpts.livenet.should.deep.equal({
        'apiPrefix': '/insight-api',
        'provider': 'insight',
        'url': 'http://localhost:3001'
      });
    });
    it('testnet local insight', function() {
      var options = {
        node: {
          network: bitcore.Networks.testnet,
          port: 3001
        }
      };
      var service = new Service(options);
      var config = service._getConfiguration();
      config.blockchainExplorerOpts.testnet.should.deep.equal({
        'apiPrefix': '/insight-api',
        'provider': 'insight',
        'url': 'http://localhost:3001'
      });
    });
  });
  describe('#start', function() {
    it('error from configuration', function(done) {
      var options = {
        node: {}
      };
      var service = new Service(options);
      service._getConfiguration = function() {
        throw new Error('test');
      };
      service.start(function(err) {
        err.message.should.equal('test');
        done();
      });
    });
    it('error from blockchain monitor', function(done) {
      var app = {};
      function TestBlockchainMonitor() {}
      TestBlockchainMonitor.prototype.start = sinon.stub().callsArgWith(1, new Error('test'));
      function TestLocker() {}
      TestLocker.prototype.listen = sinon.stub();
      function TestEmailService() {}
      TestEmailService.prototype.start = sinon.stub();
      var TestService = proxyquire('../../bitcorenode', {
        '../lib/blockchainmonitor': TestBlockchainMonitor,
        '../lib/emailservice': TestEmailService,
        'socket.io': sinon.stub().returns({
          on: sinon.stub()
        }),
        'locker-server': TestLocker,
      });
      var options = {
        node: {}
      };
      var service = new TestService(options);
      var config = {
        cluster: true
      };
      service._getConfiguration = sinon.stub().returns(config);
      service._startWalletService = sinon.stub().callsArg(1);
      service.start(function(err) {
        err.message.should.equal('test');
        done();
      });
    });
    it('error from email service', function(done) {
      var app = {};
      function TestBlockchainMonitor() {}
      TestBlockchainMonitor.prototype.start = sinon.stub().callsArg(1);
      function TestLocker() {}
      TestLocker.prototype.listen = sinon.stub();
      function TestEmailService() {}
      TestEmailService.prototype.start = sinon.stub().callsArgWith(1, new Error('test'));
      var TestService = proxyquire('../../bitcorenode', {
        '../lib/blockchainmonitor': TestBlockchainMonitor,
        '../lib/emailservice': TestEmailService,
        'socket.io': sinon.stub().returns({
          on: sinon.stub()
        }),
        'locker-server': TestLocker,
      });
      var options = {
        node: {},
      };
      var service = new TestService(options);
      service._getConfiguration = sinon.stub().returns({
        emailOpts: {},
        lockerOpts: {
          lockerServer: {
            port: 3231
          }
        },
        lockOpts: {
          lockerServer: {
            host: 'localhost',
            port: 3231,
          }
        },
        messageBrokerOpts: {
          messageBrokerServer: {
            url: 'http://localhost:3380'
          }
        }
      });
      var config = {};
      service._startWalletService = sinon.stub().callsArg(1);
      service.start(function(err) {
        err.message.should.equal('test');
        done();
      });
    });
  });
});
