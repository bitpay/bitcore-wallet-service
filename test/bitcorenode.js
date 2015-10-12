'use strict';

var should = require('chai').should();
var proxyquire = require('proxyquire');
var bitcore = require('bitcore');
var sinon = require('sinon');
var Service = require('../bitcorenode');
var Server = require('../bitcorenode/server.js');

describe('Server Utilities', function() {

  describe('#readHttpsOptions', function() {
    var server = proxyquire('../bitcorenode/server.js', {
      fs: {
        readFileSync: function(arg) {
          return arg;
        }
      }
    });
    it('will create server options from httpsOptions', function() {
      var config = {
        https: true,
        httpsOptions: {
          key: 'key',
          cert: 'cert',
          CAinter1: 'CAinter1',
          CAinter2: 'CAinter2',
          CAroot: 'CAroot'
        }
      };
      var serverOptions = server.readHttpsOptions(config);
      serverOptions.key.should.equal('key');
      serverOptions.cert.should.equal('cert');
      serverOptions.ca[0].should.equal('CAinter1');
      serverOptions.ca[1].should.equal('CAinter2');
      serverOptions.ca[2].should.equal('CAroot');
    });
  });
  describe('#start', function() {
    it('will start express and web socket servers', function(done) {
      function TestExpressApp() {}
      TestExpressApp.prototype.start = sinon.stub().callsArg(1);
      function TestWSApp() {}
      TestWSApp.prototype.start = sinon.stub().callsArg(2);
      var listen = sinon.stub().callsArg(1);
      var server = proxyquire('../bitcorenode/server.js', {
        '../lib/expressapp': TestExpressApp,
        '../lib/wsapp': TestWSApp,
        'http': {
          Server: sinon.stub().returns({
            listen: listen
          })
        }
      });
      var config = {
        bwsPort: 3232
      };
      server.start(config, function(err, server) {
        if (err) {
          throw err;
        }
        should.exist(server);
        TestExpressApp.prototype.start.callCount.should.equal(1);
        TestExpressApp.prototype.start.args[0][0].should.equal(config);
        TestExpressApp.prototype.start.args[0][1].should.be.a('function');
        TestWSApp.prototype.start.callCount.should.equal(1);
        should.exist(TestWSApp.prototype.start.args[0][0]);
        TestWSApp.prototype.start.args[0][1].should.equal(config);
        TestWSApp.prototype.start.args[0][2].should.be.a('function');
        done();
      });
    });
    it('error from express', function(done) {
      function TestExpressApp() {}
      TestExpressApp.prototype.start = sinon.stub().callsArgWith(1, new Error('test'));
      function TestWSApp() {}
      TestWSApp.prototype.start = sinon.stub().callsArg(2);
      var listen = sinon.stub().callsArg(1);
      var server = proxyquire('../bitcorenode/server.js', {
        '../lib/expressapp': TestExpressApp,
        '../lib/wsapp': TestWSApp,
        'http': {
          Server: sinon.stub().returns({
            listen: listen
          })
        }
      });
      var config = {
        bwsPort: 3232
      };
      server.start(config, function(err) {
        err.message.should.equal('test');
        done();
      });
    });
    it('error from web socket', function(done) {
      function TestExpressApp() {}
      TestExpressApp.prototype.start = sinon.stub().callsArg(1);
      function TestWSApp() {}
      TestWSApp.prototype.start = sinon.stub().callsArgWith(2, new Error('test'));
      var listen = sinon.stub().callsArg(1);
      var server = proxyquire('../bitcorenode/server.js', {
        '../lib/expressapp': TestExpressApp,
        '../lib/wsapp': TestWSApp,
        'http': {
          Server: sinon.stub().returns({
            listen: listen
          })
        }
      });
      var config = {
        bwsPort: 3232
      };
      server.start(config, function(err) {
        err.message.should.equal('test');
        done();
      });
    });
    it('will enable https', function(done) {
      var app = {};
      function TestExpressApp() {
        this.app = app;
      }
      TestExpressApp.prototype.start = sinon.stub().callsArg(1);
      function TestWSApp() {}
      TestWSApp.prototype.start = sinon.stub().callsArg(2);
      var listen = sinon.stub().callsArg(1);
      var httpsOptions = {};
      var createServer = function() {
        arguments[0].should.equal(httpsOptions);
        arguments[1].should.equal(app);
        return {
          listen: listen
        };
      };
      var server = proxyquire('../bitcorenode/server.js', {
        '../lib/expressapp': TestExpressApp,
        '../lib/wsapp': TestWSApp,
        'https': {
          createServer: createServer
        }
      });
      var config = {
        https: true,
        bwsPort: 3232
      };
      server.readHttpsOptions = sinon.stub().returns(httpsOptions);
      server.start(config, function(err) {
        server.readHttpsOptions.callCount.should.equal(1);
        done();
      });
    });
  });

});


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
      service.https.should.equal(true);
      service.httpsOptions.should.deep.equal({
        key: 'key',
        cert: 'cert'
      });
      service.bwsPort.should.equal(3232);
      service.messageBrokerPort.should.equal(3380);
      service.lockerPort.should.equal(3231);
    });
    it('direct https options', function() {
      var node = {};
      var options = {
        node: node,
        https: true,
        httpsOptions: {
          key: 'key',
          cert: 'cert'
        }
      };
      var service = new Service(options);
      service.https.should.equal(true);
      service.httpsOptions.should.deep.equal({
        key: 'key',
        cert: 'cert'
      });
      service.bwsPort.should.equal(3232);
      service.messageBrokerPort.should.equal(3380);
      service.lockerPort.should.equal(3231);
    });
    it('can set custom ports', function() {
      var node = {};
      var options = {
        node: node,
        bwsPort: 1000,
        messageBrokerPort: 1001,
        lockerPort: 1002
      };
      var service = new Service(options);
      service.bwsPort.should.equal(1000);
      service.messageBrokerPort.should.equal(1001);
      service.lockerPort.should.equal(1002);
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
  describe('#start', function(done) {
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
      var TestService = proxyquire('../bitcorenode', {
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
      var config = {};
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
      var TestService = proxyquire('../bitcorenode', {
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
      service._getConfiguration = sinon.stub().returns({
        emailOpts: {}
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
