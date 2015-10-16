'use strict';

var should = require('chai').should();
var proxyquire = require('proxyquire');
var bitcore = require('bitcore');
var sinon = require('sinon');
var Server = require('../../bitcorenode/server.js');

describe('Server Utilities', function() {

  describe('#readHttpsOptions', function() {
    var server = proxyquire('../../bitcorenode/server.js', {
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
  describe('#startCluster', function() {
    it('will throw error with missing options', function() {
      var server = proxyquire('../../bitcorenode/server.js', {});
      (function() {
        server.startCluster({});
      }).should.throw('When running in cluster mode, locker server');
      (function() {
        server.startCluster({
          lockOpts: {}
        });
      }).should.throw('When running in cluster mode, locker server');
      (function() {
        server.startCluster({
          lockOpts: {
            lockerServer: {}
          }
        });
      }).should.throw('When running in cluster mode, message broker');
      (function() {
        server.startCluster({
          lockOpts: {
            lockerServer: {}
          },
          messageBrokerOpts: {}
        });
      }).should.throw('When running in cluster mode, message broker');
    });
    it('should start several instances', function(done) {
      var httpServer = {
        listen: sinon.stub()
      };
      var server = proxyquire('../../bitcorenode/server.js', {
        'os': {
          cpus: sinon.stub().returns({length: 8})
        },
        'sticky-session': function(instances) {
          instances.should.equal(8);
          return httpServer;
        }
      });
      server.start = sinon.stub().callsArg(1);
      server.startCluster({
        lockOpts: {
          lockerServer: {
            host: 'localhost',
            port: 3231
          }
        },
        messageBrokerOpts: {
          messageBrokerServer: 'http://localhost:3380'
        },
        port: 3232
      });
      httpServer.listen.callCount.should.equal(1);
      httpServer.listen.args[0][0].should.equal(3232);
      done();
    });

  });
  describe('#start', function() {
    it('will start express and web socket servers', function(done) {
      function TestExpressApp() {}
      TestExpressApp.prototype.start = sinon.stub().callsArg(1);
      function TestWSApp() {}
      TestWSApp.prototype.start = sinon.stub().callsArg(2);
      var listen = sinon.stub().callsArg(1);
      var server = proxyquire('../../bitcorenode/server.js', {
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
      var server = proxyquire('../../bitcorenode/server.js', {
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
      var server = proxyquire('../../bitcorenode/server.js', {
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
      var server = proxyquire('../../bitcorenode/server.js', {
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
