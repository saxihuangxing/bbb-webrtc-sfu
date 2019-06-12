'use strict';

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/BaseProvider');
const SHOULD_RECORD = config.get('recordWebcams');
const LOG_PREFIX = "[audio]";
const emitter = require('../utils/emitter');
const errors = require('../base/errors');

let sources = {};

module.exports = class Audio extends BaseProvider {
    constructor(bbbGW, _meetingId, _id, _shared, _connectionId, mcs, voiceBridge) {
        super(bbbGW);
        this.sfuApp = C.AUDIO_APP;
        this.mcs = mcs;
        this.id = _id;
        this.connectionId = _connectionId;
        this.meetingId = _meetingId;
        this.voiceBridge = voiceBridge;
        this.shared = _shared;
        this.role = this.shared? 'share' : 'viewer'
        this.streamName = this.connectionId + this.id + "-" + this.role;
        this.mediaId = null;
        this.status = C.MEDIA_STOPPED;
        this.recording = {};
        this.isRecorded = false;
        this._recordingSubPath = 'recordings';
        this._cameraProfile = 'medium';
        this.candidatesQueue = [];
        this.notFlowingTimeout = null;
        this.isRecording = false;
        this.pending = false;
    }

    static setSource (userId, stream) {
        Logger.info(LOG_PREFIX, "Setting new source media", userId, stream);
        sources[userId] = stream;
        emitter.emit(C.AUDIO_SOURCE_ADDED, userId);
    }

    static removeSource (event) {
        const { userId } = sourceMap;
        sources[userId] = null;
    }

    mediaUserJoined (id) {
        emitter.emit(C.MEDIA_USER_JOINED + id);
    }

    _randomTimeout (low, high) {
        return parseInt(Math.random() * (high - low) + low);
    }

    async onIceCandidate (_candidate) {
        if (this.mediaId) {
            try {
                await this.mcs.addIceCandidate(this.mediaId, _candidate);
            }
            catch (err)   {
                this._handleError(LOG_PREFIX, err, this.role, this.id);
                Logger.error(LOG_PREFIX, "ICE candidate for user", this.userId, "with media", this.mediaId, "could not be added to media controller.", err);
            }
        }
        else {
            this.candidatesQueue.push(_candidate);
            Logger.trace(LOG_PREFIX, "ICE candidate for", this.id, "is going to be queued", this.candidatesQueue.length);
        }
    };

    _onMCSIceCandidate (event, endpoint) {
        const { mediaId, candidate } = event;

        if (mediaId !== endpoint) {
            return;
        }

        Logger.debug(LOG_PREFIX, 'Received ICE candidate from mcs-core for media session', mediaId, '=>', candidate, "for connection", this.connectionId);

        this.bbbGW.publish(JSON.stringify({
            connectionId: this.connectionId,
            type: 'audio',
            role: this.role,
            id : 'iceCandidate',
            cameraId: this.id,
            candidate: candidate
        }), C.FROM_AUDIO);
    }

    _mediaStateWebRTC (event, endpoint) {
        const { mediaId , state } = event;
        const { name, details } = state;

        if (mediaId !== endpoint) {
            return;
        }

        switch (name) {
            case "MediaStateChanged":
                break;

            case "MediaFlowOutStateChange":
            case "MediaFlowInStateChange":
                Logger.info(LOG_PREFIX, "Session with media", mediaId, "received state", state, "for audio", this.streamName);
                if (details === 'NOT_FLOWING' && this.status !== C.MEDIA_PAUSED) {
                    Logger.warn(LOG_PREFIX, "Setting up a timeout for", this.streamName);
                    if (!this.notFlowingTimeout) {
                        this.notFlowingTimeout = setTimeout(() => {
                            if (this.shared) {
                            Logger.warn(LOG_PREFIX, "Media NOT_FLOWING timeout hit for", this.streamName);
                            this.sendPlayStop();
                            clearTimeout(this.notFlowingTimeout);
                            delete this.notFlowingTimeout;
                        }
                    }, config.get('mediaFlowTimeoutDuration') + this._randomTimeout(-2000, 2000));
                    }
                }
                else if (details === 'FLOWING') {
                    if (this.notFlowingTimeout) {
                        Logger.warn(LOG_PREFIX, "Received a media flow before stopping", this.streamName);
                        clearTimeout(this.notFlowingTimeout);
                        delete this.notFlowingTimeout;
                    }
                    if (this.status !== C.MEDIA_STARTED) {

                        // Record the audio stream if it's the original being shared
                        if (this.shouldRecord()) {
                            this.startRecording();
                        }

                        this.sendPlayStart();

                        this.status = C.MEDIA_STARTED;
                    }

                }
                break;

            case C.MEDIA_SERVER_OFFLINE:
                Logger.error(LOG_PREFIX, "Audio provider received MEDIA_SERVER_OFFLINE event", event);
                event.sessionId = this.streamName;
                this.emit(C.MEDIA_SERVER_OFFLINE, event);
                break;

            default: Logger.warn(LOG_PREFIX, "Unrecognized event", event);
        }
    }

    sendPlayStart () {
        this.bbbGW.publish(JSON.stringify({
            connectionId: this.connectionId,
            type: 'audio',
            role: this.role,
            id : 'playStart',
            cameraId: this.id,
        }), C.FROM_AUDIO);
    }

    sendPlayStop () {
        let userCamEvent =
            Messaging.generateUserCamBroadcastStoppedEventMessage2x(this.meetingId, this.id, this.id);
        this.bbbGW.publish(userCamEvent, function(error) {});

        this.bbbGW.publish(JSON.stringify({
            connectionId: this.connectionId,
            type: 'audio',
            role: this.role,
            id : 'playStop',
            cameraId: this.id,
        }), C.FROM_AUDIO);
    }

    shouldRecord () {
        return this.isRecorded && this.shared;
    }

    async startRecording () {
        return new Promise(async (resolve, reject) => {
            try {
                const recordingName = this._cameraProfile + '-' + this.id;
        const recordingPath = this.getRecordingPath(this.meetingId, this._recordingSubPath, recordingName);
        const recordingId = await this.mcs.startRecording(this.userId, this.mediaId, recordingPath);
        this.recording = { recordingId, filename: recordingPath, recordingPath };
        this.mcs.onEvent(C.MEDIA_STATE, this.recording.recordingId, (event) => {
            this._recordingState(event, this.recording.recordingId);
    });
        this.sendStartShareEvent();
        this.isRecording = true;
        resolve(this.recording);
    }
    catch (err) {
            Logger.error(LOG_PREFIX, "Error on start recording with message", err);
            reject(this._handleError(LOG_PREFIX, err, this.role, this.id));
        }
    });
    }

    async stopRecording() {
        this.sendStopShareEvent();

        return this.mcs.stopRecording(this.userId, this.recording.recordingId);
    }

    _recordingState (event, endpoint) {
        const { mediaId , state } = event;
        const { name, details } = state;

        if (mediaId !== endpoint) {
            return;
        }

        Logger.info(LOG_PREFIX, 'Recording status for rec', mediaId, 'for audio', this.streamName, "is", name, state, details);
    }

    start (sdpOffer) {
        return new Promise(async (resolve, reject) => {
            Logger.info(LOG_PREFIX, "Starting audio instance for", this.streamName);
        if (this.status !== C.MEDIA_STOPPING && this._status !== C.MEDIA_STOPPED) {
            this.status = C.MEDIA_STARTING;

            try {
                // Probe akka-apps to see if this is to be recorded
               /* if (SHOULD_RECORD && this.shared) {
                    this.isRecorded = await this.probeForRecordingStatus(this.meetingId, this.id);
                }*/

                this.userId = await this.mcs.join(this.voiceBridge, 'SFU', {});
                this.mediaUserJoined(this.streamName);
                Logger.info(LOG_PREFIX, "MCS join for", this.streamName, "returned", this.userId);
                const sdpAnswer = await this._addMCSMedia(C.WEBRTC, sdpOffer);

                this.mcs.onEvent(C.MEDIA_STATE, this.mediaId, (event) => {
                    this._mediaStateWebRTC(event, this.mediaId);
            });

                this.mcs.onEvent(C.MEDIA_STATE_ICE, this.mediaId, (event) => {
                    this._onMCSIceCandidate(event, this.mediaId);
            });

                this.flushCandidatesQueue(this.mcs, [...this.candidatesQueue], this.mediaId);
                this.candidatesQueue = [];

                Logger.info(LOG_PREFIX, "MCS call for user", this.userId, "returned", this.mediaId);
                return resolve(sdpAnswer);
            }
            catch (err) {
                reject(this._handleError(LOG_PREFIX, err, this.role, this.id));
            }
        } else {
            const error = { code: 2200, reason: errors[2200] }
            reject(this._handleError(LOG_PREFIX, error, this.role, this.id));
        };
    });
    }

    _addMCSMedia (type, descriptor) {
        return new Promise(async (resolve, reject) => {
            try {
                if (this.shared) {
            const options = {
                descriptor,
                name: this._assembleStreamName('publish', this.id, this.voiceBridge),
            }

            const { mediaId, answer } = await this.mcs.publish(this.userId, this.voiceBridge, type, options);
            this.mediaId = mediaId;
            sources[this.id] = this.mediaId;
            return resolve(answer);
        }
    else {
            Logger.info(LOG_PREFIX, "Subscribing to", this.id, sources);
            if (sources[this.id]) {
                const answer = this._subscribeToMedia(descriptor);
                return resolve(answer);
            } else {
                const lazySubscribe = (id) => {
                    Logger.info(LOG_PREFIX, "Lazily subscribing to", id, "in", this.id);
                    if (id === this.id) {
                        const answer = this._subscribeToMedia(descriptor);
                        emitter.removeListener(C.AUDIO_SOURCE_ADDED, lazySubscribe);
                        return resolve(answer);
                    }
                }
                // Media not yet mapped, add it to pending list
                // TODO implement a timeout to drop inactive candidates
                emitter.on(C.AUDIO_SOURCE_ADDED, lazySubscribe);
            }
        }
    }
    catch (err) {
            err = this._handleError(LOG_PREFIX, err, this.role, this.id)
            reject(err);
        }
    });
    }

    async _subscribeToMedia (descriptor) {
        try {
            const options = {
                descriptor,
                name: this._assembleStreamName('subscribe', this.id, this.voiceBridge),
            }
            Logger.info(LOG_PREFIX, 'Subscribing to', sources[this.id], 'from', this.id);
            const { mediaId, answer } = await this.mcs.subscribe(this.userId, sources[this.id], C.WEBRTC, options);
            this.mediaId = mediaId;
            return answer;
        }
        catch (err) {
            throw err;
        }
    }

    async pause (state) {
        const sourceId = sources[this.id];
        const sinkId = this.mediaId;

        // TODO temporarily deactivated this procedure until the connection type param is fixed
        return;

        if (sourceId == null || sinkId == null) {
            Logger.error(LOG_PREFIX, "Source or sink is null.");
            return;
        }

        // We want to pause the stream
        try {
            if (state && (this.status !== C.MEDIA_STARTING || this.status !== C.MEDIA_PAUSED)) {
                await this.mcs.disconnect(sourceId, sinkId, 'AUDIO');
                this.status = C.MEDIA_PAUSED;
            }
            else if (!state && this.status === C.MEDIA_PAUSED) { //un-pause
                await this.mcs.connect(sourceId, sinkId, 'AUDIO');
                this.status = C.MEDIA_STARTED;
            }
        }
        catch (err) {
            this._handleError(LOG_PREFIX, err, this.role, this.id);
        }
    }

    sendStartShareEvent() {
        let shareCamEvent = Messaging.generateWebRTCShareEvent('StartWebRTCShareEvent', this.meetingId, this.recording.filename);
        this.bbbGW.writeMeetingKey(this.meetingId, shareCamEvent, function(error) {});
    }

    sendStopShareEvent () {
        let stopShareEvent =
            Messaging.generateWebRTCShareEvent('StopWebRTCShareEvent', this.meetingId, this.recording.filename);
        this.bbbGW.writeMeetingKey(this.meetingId, stopShareEvent, function(error) {});
    }

    async stop () {
        return new Promise(async (resolve, reject) => {
            if (this.status === C.MEDIA_STOPPED) {
            Logger.warn(LOG_PREFIX, 'Audio session', this.streamName, this.userId, 'at room', this.meetingId, 'already stopped');
            return resolve();
        } else if (this.status === C.MEDIA_STOPPING) {
            Logger.warn(LOG_PREFIX, 'Audio session', this.streamName, this.userId, 'at room', this.meetingId, 'already stopping');
            emitter.once(C.AUDIO_STOPPED + this.streamName, resolve);
        } else {
            Logger.info(LOG_PREFIX, 'Stopping audio session', this.streamName, this.userId, 'at room', this.meetingId);
            const finishAudioSession = async () => {
                try {
                    if (this.shouldRecord() && this.isRecording && this.state !== C.MEDIA_STOPPED) {
                        await this.stopRecording();
                    }
                } catch (e) {
                    Logger.warn(LOG_PREFIX, "Error on stopping recording for", this.streamName, e);
                }

                try {
                    this.status = C.MEDIA_STOPPING;

                    await this.mcs.leave(this.voiceBridge, this.userId);

                    if (this.shared) {
                        delete sources[this.id];
                    }

                    if (this.notFlowingTimeout) {
                        clearTimeout(this.notFlowingTimeout);
                        delete this.notFlowingTimeout;
                    }

                    delete this.candidatesQueue;
                    emitter.emit(C.AUDIO_STOPPED + this.streamName);
                    this.status = C.MEDIA_STOPPED;
                    resolve();
                }
                catch (err) {
                    reject(this._handleError(LOG_PREFIX, err, this.role, this.streamName));
                }
            };

            if (this.userId == null) {
                emitter.once(C.MEDIA_USER_JOINED + this.streamName, finishAudioSession.bind(this));
            } else {
                finishAudioSession();
            }
        }
    });
    }
};
