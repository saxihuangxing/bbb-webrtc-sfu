/*
 * Lucas Fialho Zawacki
 * (C) Copyright 2017 Bigbluebutton
 *
 */

'use strict';

const BigBlueButtonGW = require('../bbb/pubsub/bbb-gw');
const Audio = require('./audio');
const BaseManager = require('../base/BaseManager');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const errors = require('../base/errors');

module.exports = class AudioManager extends BaseManager {
    constructor (connectionChannel, additionalChannels, logPrefix) {
        super(connectionChannel, additionalChannels, logPrefix);
        this.sfuApp = C.AUDIO_APP;
        this.messageFactory(this._onMessage);
       // this._trackExternalWebcamSources();
    }

    _findByIdAndRole (id, role) {
        let sesh = null;
        let keys = Object.keys(this._sessions);
        keys.forEach((sessionId) => {
            let session = this._sessions[sessionId];
        if (sessionId === (session.connectionId + id + '-' + role)) {
            sesh = session;
        }
    });
        return sesh;
    }

    setStreamAsRecorded (id) {
        let audio = this._findByIdAndRole(id, 'share');

        if (audio) {
            Logger.info("[AudioManager] Setting ", id, " as recorded");
            audio.setStreamAsRecorded();
        } else {
            Logger.warn("[AudioManager] Tried to set stream to recorded but ", id, " has no session!");
        }
    }

    async _onMessage (_message) {
        let message = _message;
        let connectionId = message.connectionId;
        let sessionId;
        let audio;
        let role = message.role? message.role : 'share';
        let cameraId = message.cameraId;
        let shared = role === 'share' ? true : false;
        let iceQueue;

        Logger.debug(this._logPrefix, 'Received message =>', message);

        if (cameraId == null && message.id !== 'close') {
            Logger.warn(this._logPrefix, 'Ignoring message with undefined.cameraId', message);
            return;
        }

        cameraId += '-' + role;

        sessionId = connectionId + cameraId;

        if (message.cameraId) {
            audio = this._fetchSession(sessionId);
            iceQueue = this._fetchIceQueue(sessionId);
        }

        switch (message.id) {
            case 'start':
                Logger.info(this._logPrefix, 'Received message [' + message.id + '] from connection ' + sessionId);

                if (audio) {
                    if (audio.status !== C.MEDIA_STARTING) {
                        await this._stopSession(sessionId);
                        const { voiceBridge } = message;
                        audio = new Audio(this._bbbGW, message.meetingId, message.cameraId,
                            shared, message.connectionId, this.mcs, voiceBridge);
                        this._sessions[sessionId] = audio;
                    } else {
                        return;
                    }
                } else {
                    const { voiceBridge } = message;
                    audio = new Audio(this._bbbGW, message.meetingId, message.cameraId,
                        shared, message.connectionId, this.mcs, voiceBridge);
                    this._sessions[sessionId] = audio;
                }


                try {
                    const sdpAnswer = await audio.start(message.sdpOffer);

                    // Empty ice queue after starting audio
                    this._flushIceQueue(audio, iceQueue);

                    audio.once(C.MEDIA_SERVER_OFFLINE, async (event) => {
                        const errorMessage = this._handleError(this._logPrefix, connectionId, message.cameraId, role, errors.MEDIA_SERVER_OFFLINE);
                    this._bbbGW.publish(JSON.stringify({
                        ...errorMessage,
                }), C.FROM_AUDIO);
                });

                    this._bbbGW.publish(JSON.stringify({
                        connectionId: connectionId,
                        type: 'audio',
                        role: role,
                        id : 'startResponse',
                        cameraId: message.cameraId,
                        sdpAnswer : sdpAnswer
                    }), C.FROM_AUDIO);
                }
                catch (err) {
                    const errorMessage = this._handleError(this._logPrefix, connectionId, message.cameraId, role, err);
                    return this._bbbGW.publish(JSON.stringify({
                        ...errorMessage
                }), C.FROM_AUDIO);
                }
                break;

            case 'publish':
                Logger.info("Received SUBSCRIBE from external source", message);

                const userId = await this.mcs.join(message.meetingId, 'SFU', {});

                const retRtp = await this.mcs.publish(userId, message.meetingId, C.RTP, { descriptor: message.sdpOffer });

                Audio.setSharedWebcam(cameraId.split('-')[0], retRtp.sessionId);

                this._bbbGW.publish(JSON.stringify({
                    id: 'publish',
                    type: C.AUDIO_APP,
                    role: 'send',
                    response: 'accepted',
                    meetingId: message.meetingId,
                    sessionId: retRtp.sessionId,
                    answer: retRtp.answer
                }), C.FROM_AUDIO);
                break;

            case 'stop':
                await this._stopSession(sessionId);
                break;

            case 'pause':
                if (audio) {
                    audio.pause(message.state);
                }
                break;

            case 'onIceCandidate':
                if (audio && audio.constructor === Audio) {
                    audio.onIceCandidate(message.candidate);
                } else {
                    Logger.info(this._logPrefix, "Queueing ice candidate for later in audio", cameraId);
                    iceQueue.push(message.candidate);
                }
                break;

            case 'close':
                Logger.info(this._logPrefix, "Closing sessions of connection", connectionId);
                this._killConnectionSessions(connectionId);
                break;

            default:
                const errorMessage = this._handleError(this._logPrefix, connectionId, null, null, errors.SFU_INVALID_REQUEST);
                this._bbbGW.publish(JSON.stringify({
                    ...errorMessage,
        }), C.FROM_AUDIO);
        break;
    }
    }
}
