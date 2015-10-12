'use strict';

var https = require('https');
var http = require('http');
var async = require('async');
var fs = require('fs');
var sticky = require('sticky-session');
var cluster = require('cluster');

var ExpressApp = require('../lib/expressapp');
var WsApp = require('../lib/wsapp');

/**
 * Will start the HTTP web server and socket.io for the wallet service,
 * it will not start listing on a port, and will give an http server
 * in the callback.
 * @param {Object} config
 * @param {Function} next
 */
function start(config, next) {
  var expressApp = new ExpressApp();
  var wsApp = new WsApp();

  var server;

  if (config.https) {
    var serverOpts = utils.readHttpsOptions(config);
    server = https.createServer(serverOpts, expressApp.app);
  } else {
    server = http.Server(expressApp.app);
  }

  async.parallel([
    function(done) {
      expressApp.start(config, done);
    },
    function(done) {
      wsApp.start(server, config, done);
    },
  ], function(err) {
    if (err) {
      return next(err);
    }
    next(null, server);
  });

  return server;
}

/**
 * This method will read `key` and `cert` files from disk based on `httpsOptions` and
 * return `serverOpts` with the read files.
 * @returns {Object}
 */
function readHttpsOptions(config) {
  if(!config.httpsOptions || !config.httpsOptions.key || !config.httpsOptions.cert) {
    throw new Error('Missing https options');
  }

  var serverOpts = {};
  serverOpts.key = fs.readFileSync(config.httpsOptions.key);
  serverOpts.cert = fs.readFileSync(config.httpsOptions.cert);

  // This sets the intermediate CA certs only if they have all been designated in the config.js
  if (config.httpsOptions.CAinter1 &&
      config.httpsOptions.CAinter2 &&
      config.httpsOptions.CAroot) {
    serverOpts.ca = [
      fs.readFileSync(config.httpsOptions.CAinter1),
      fs.readFileSync(config.httpsOptions.CAinter2),
      fs.readFileSync(config.httpsOptions.CAroot)
    ];
  }
  return serverOpts;
}

/**
 * This will start a cluster of web services listening on the same port,
 * to best utilize all of the available CPU.
 */
function startCluster(config) {
  if (!config.lockOpts.lockerServer) {
    throw 'When running in cluster mode, locker server need to be configured';
  }
  if (!config.messageBrokerOpts.messageBrokerServer) {
    throw 'When running in cluster mode, message broker server need to be configured';
  }

  var numCPUs = require('os').cpus().length;
  var clusterInstances = config.clusterInstances || numCPUs;
  var serverModule = config.https ? https : http;

  var server = sticky(clusterInstances, function() {
    return utils.start(config, function(err) {
      if (err) {
        console.error('Could not start BWS instance', err);
      }
    });
  });
  server.listen(config.port, function(err) {
    if (err) {
      console.log('ERROR: ', err);
    }
    console.info('Bitcore Wallet Service running on port ' + config.port);
  });
}

if (require.main === module) {
  if (!process.argv[2]) {
    throw new Error('Expected configuration not available as an argument.');
  }
  var config = JSON.parse(process.argv[2]);
  startCluster(config);
}

var utils = module.exports = {
  startCluster: startCluster,
  readHttpsOptions: readHttpsOptions,
  start: start
};
