/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

'use strict';

const http = require('http');
const EventEmitter = require('events');
const BigBlueButtonGW = require('../bbb/pubsub/bbb-gw');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');

// Global variables
module.exports = class ConnectionManager {

  constructor (settings, logger) {
    this._screenshareSessions = {};

    this._setupBBB();

    this._emitter = this._setupEventEmitter();
    this._adapters = [];
  }

  setHttpServer(httpServer) {
    this.httpServer = httpServer;
  }

  listen(callback) {
    this.httpServer.listen(callback);
  }

  addAdapter(adapter) {
    adapter.setEventEmitter(this._emitter);
    this._adapters.push(adapter);
  }

  _setupEventEmitter() {
    let self = this;
    let emitter = new EventEmitter();

    emitter.on(C.WEBSOCKET_MESSAGE, (data) => {
        Logger.info('receive WEBSOCKET_MESSAGE : ' + data);
      switch (data.type) {
        case "screenshare":
          self._bbbGW.publish(JSON.stringify(data), C.TO_SCREENSHARE);
          break;

        case "video":
          self._bbbGW.publish(JSON.stringify(data), C.TO_VIDEO);
          break;

        case "audio":
          Logger.info(' publish to audio,data : ' + data);
          self._bbbGW.publish(JSON.stringify(data), C.TO_AUDIO);
          break;

        case "stream":
          self._bbbGW.publish(JSON.stringify(data), C.TO_STREAM);
          break;

        case "default":
          // TODO handle API error message;
      }
    });

    return emitter;
  }

  async _setupBBB() {
    this._bbbGW = new BigBlueButtonGW();

    try {
      const screenshare = await this._bbbGW.addSubscribeChannel(C.FROM_SCREENSHARE);
      const video = await this._bbbGW.addSubscribeChannel(C.FROM_VIDEO);
      const audio = await this._bbbGW.addSubscribeChannel(C.FROM_AUDIO);
      const stream = await this._bbbGW.addSubscribeChannel(C.FROM_STREAM);

      const emitFunk = (data) => {
        this._emitter.emit('response', data);
      };

      screenshare.on(C.REDIS_MESSAGE, emitFunk);
      video.on(C.REDIS_MESSAGE, emitFunk);
      audio.on(C.REDIS_MESSAGE, (data) => {
        this._emitter.emit('response', data);
      });
      stream.on(C.REDIS_MESSAGE, emitFunk);

      Logger.info('[ConnectionManager] Successfully subscribed to processes redis channels');
    }
    catch (err) {
      Logger.info('[ConnectionManager] ' + err);
      this._stopAll;
    }
  }

  _stopSession(sessionId) {
  }

  _stopAll() {
  }
}
