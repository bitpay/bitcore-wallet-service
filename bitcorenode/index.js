'use strict';

var util = require('util');
var fs = require('fs');
var io = require('socket.io');
var https = require('https');
var http = require('http');
var async = require('async');
var Locker = require('locker-server');
var child_process = require('child_process');
var spawn = child_process.spawn;
var EventEmitter = require('events').EventEmitter;
var path = require('path');
var bitcore = require('bitcore');
var _ = bitcore.deps._;
var Networks = bitcore.Networks;
var BlockchainMonitor = require('../lib/blockchainmonitor');
var EmailService = require('../lib/emailservice');
var ExpressApp = require('../lib/expressapp');
var WsApp = require('../lib/wsapp');
var WalletServer = require('./server');
var baseConfig = require('../config');

var BROKER_DEFAULT_PORT = 3380;

/**
 * A Bitcore Node Service module
 * @param {Object} options
 * @param {Node} options.node - A reference to the Bitcore Node instance
 * @param {Boolean} options.https - Enable https for this module, defaults to node settings.
 * @param {Number} options.cluster - Enable clustering
 * @param {Number} options.port - Port for Bitcore Wallet Service API
 * @param {Number} options.lockerOpts - Locker server options
 * @param {Number} options.messageBrokerOpts - Message server options
 */
var Service = function(options) {
  EventEmitter.call(this);

  this.node = options.node;
  this.options = options;
};

util.inherits(Service, EventEmitter);

Service.dependencies = ['insight-api'];

/**
 * Will get the configuration with settings for the locally
 * running Insight API.
 * @returns {Object}
 */
Service.prototype._getConfiguration = function() {
  var self = this;

  var config = _.clone(baseConfig);

  config.https = this.options.https || this.node.https;
  config.httpsOptions = this.options.httpsOptions || this.node.httpsOptions;
  // The default configuration will be to run as a single process
  // in the case that we are running in multiple processes, the service will expect
  // a message-broker and locker server to be available.
  config.cluster = this.options.cluster || false;
  config.port = this.options.port || baseConfig.port;

  if (this.options.lockerOpts) {
    config.lockOpts = this.options.lockerPort;
  }

  if (this.options.messageBrokerOpts) {
    config.messageBrokerOpts = this.options.messageBrokerOpts;
  }

  var providerOptions = {
    provider: 'insight',
    url: (self.node.https ? 'https://' : 'http://') + 'localhost:' + self.node.port,
    apiPrefix: '/insight-api'
  };

  // A bitcore-node is either livenet or testnet, so we'll pass
  // the configuration options to communicate via the local running
  // instance of the insight-api service.
  if (self.node.network === Networks.livenet) {
    config.blockchainExplorerOpts = {
      livenet: providerOptions
    };
  } else if (self.node.network === Networks.testnet) {
    config.blockchainExplorerOpts = {
      testnet: providerOptions
    };
  } else {
    throw new Error('Unknown network');
  }

  return config;

};

/**
 * Will start the wallet service in a cluster, it's necessary that we spawn
 * into a new process, so that this process can be forked into separate child
 * processes without forking the main process.
 */
Service.prototype._startWalletServiceCluster = function(config, next) {
  var args = [
    path.resolve(__dirname, './server.js'),
    JSON.stringify(config)
  ];

  var options = {
    cwd: process.cwd(),
    env: process.env
  };

  var bws = spawn('node', args, options);

  bws.stdout.on('data', function (data) {
    process.stdout.write(data);
  });

  bws.stderr.on('data', function (data) {
    process.stderr.write(data);
  });

  bws.on('close', function (code, signal) {
    if (code && code !== 0) {
      throw new Error('BWS closed with exit code:' + code);
    }
  });
  setImmediate(next);
};



/**
 * Called by the node to start the service
 */
Service.prototype.start = function(done) {

  var self = this;
  var config;
  try {
    config = self._getConfiguration();
  } catch(err) {
    return done(err);
  }

  // When multiple nodes are started with BWS these servers are expected
  // to be run in a different process.
  if (!config.cluster) {
    // Locker Server
    var locker = new Locker();
    locker.listen(config.lockOpts.lockerServer.port);

    // Message Broker
    var messageServer = io(config.messageBrokerOpts.messageBrokerServer.port || BROKER_DEFAULT_PORT);
    messageServer.on('connection', function(s) {
      s.on('msg', function(d) {
        messageServer.emit('msg', d);
      });
    });
  }

  async.series([
    function(next) {
      // Blockchain Monitor
      var blockChainMonitor = new BlockchainMonitor();
      blockChainMonitor.start(config, next);
    },
    function(next) {
      // Email Service
      if (config.emailOpts) {
        var emailService = new EmailService();
        emailService.start(config, next);
      } else {
        setImmediate(next);
      }
    },
    function(next) {
      if (!config.cluster) {
        WalletServer.start(config, function(err, server) {
          if (err) {
            return next(err);
          }
          server.listen(config.port, next);
        });
      } else {
        self._startWalletServiceCluster(config, next);
      }
    }
  ], done);

};

/**
 * Called by node to stop the service
 */
Service.prototype.stop = function(done) {
  setImmediate(function() {
    done();
  });
};

Service.prototype.getAPIMethods = function() {
  return [];
};

Service.prototype.getPublishEvents = function() {
  return [];
};

module.exports = Service;
