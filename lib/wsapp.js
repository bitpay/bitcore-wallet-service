'use strict';

var $ = require('preconditions').singleton();
var _ = require('lodash');
var async = require('async');
var log = require('npmlog');
log.debug = log.verbose;
var Uuid = require('uuid');

var WalletService = require('./server');
var MessageBroker = require('./messagebroker');

log.level = 'debug';

var WsApp = function() {
    this.connectedWallets = {};
    this.authorizedWallets = {};
};

function keysToArray(dict){
  var ret = [];
  for (var key in dict)
    ret.push(key);
  return ret;
}

WsApp.prototype._handleNotification = function(notification) {
  var namespace = this.io.to(notification.walletId);
  var to = this.authorizedWallets[notification.walletId] || {};
  namespace.emit('multimessage', {to: keysToArray(to), message: 'notification', payload: notification});
};

function _unauthorized(socket, connectionId) {
  socket.emit('message', {to: connectionId, message: 'unauthorized'});
};

WsApp.prototype._walletConnected = function(socket, data){
  if (!data || !data.from)
    return;
  var connectionId = data.from;
  var wallet = this.connectedWallets[connectionId] = {
    socket: socket,
    nonce: Uuid.v4()
  };
  socket.emit('message', {to: connectionId, message: 'challenge', payload: wallet.nonce});
};

WsApp.prototype._authorizeWallet = function(socket, data){
  if (!data || !data.from || !data.payload || !(data.from in this.connectedWallets))
    return;
  var connectionId = data.from;
  if (!connectionId || !(connectionId in this.connectedWallets))
    return;

  var nonce = data.payload.message;
  var connectedWallet = this.connectedWallets[connectionId];
  var expectedNonce = connectedWallet.nonce;
  if (nonce != expectedNonce){
    _unauthorized(socket, connectionId);
    return;
  }
  
  var self = this;
  
  WalletService.getInstanceWithAuth(
    data.payload,
    function(err, service) {
      if (err){
        _unauthorized(socket, connectionId);
        return;
      }

      socket.join(service.walletId);
      var dict = null;
      if (service.walletId in self.authorizedWallets)
        dict = self.authorizedWallets[service.walletId];
      else
        dict = self.authorizedWallets[service.walletId] = {};
      dict[connectionId] = null;
      socket.emit('message', {to: connectionId, message: 'authorized'});
    }
  );
};

WsApp.prototype._newConnection = function(socket){
  var self = this;
  socket.on('wallet_connected', self._walletConnected.bind(self, socket));
  socket.on('authorize', self._authorizeWallet.bind(self, socket));
};

WsApp.prototype.start = function(server, opts, cb) {
  opts = opts || {};
  $.checkState(opts.messageBrokerOpts);

  var self = this;

  this.io = require('socket.io')(server);

  async.series([

    function(done) {
      self.messageBroker = new MessageBroker(opts.messageBrokerOpts);
      self.messageBroker.onMessage(_.bind(self._handleNotification, self));
      done();
    },
    function(done) {
      self.io.on('connection', self._newConnection.bind(self));
      done();
    },
  ], function(err) {
    if (cb) return cb(err);
  });
};

module.exports = WsApp;
