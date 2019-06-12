/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

'use strict';

const cp = require('child_process');
const Logger = require('./utils/Logger');
const config = require('config');
const PROCESSES = config.get('processes');

module.exports = class ProcessManager {
  constructor() {
    this.processes = {};
    this.runningState = "RUNNING";
    this.globalI = 1;
  }

  async start () {
    // Start the rest of the preconfigured SFU modules
    for (let i = 0; i < PROCESSES.length; i++) {
      let { path } = PROCESSES[i];
      let proc = this.startProcess(path);;
      this.processes[proc.pid] = proc;
    }

    process.on('SIGTERM', async () => {
      await this.finishChildProcesses();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      await this.finishChildProcesses();
      process.exit(0);
    });

    process.on('uncaughtException', async (error) => {
      if (error.code === 'EADDRINUSE') {
        Logger.info("[ProcessManager] There's probably another master SFU instance running, keep this one as slave");
        return;
      }
      Logger.error('[ProcessManager] Uncaught exception', error.stack);
      await this.finishChildProcesses();
      process.exit('1');
    });

    // Added this listener to identify unhandled promises, but we should start making
    // sense of those as we find them
    process.on('unhandledRejection', (reason, p) => {
      Logger.error('[ProcessManager] Unhandled Rejection at: Promise', p, 'reason:', reason);
    });
  }

    addDebugParameter(args) {
      //   let globalI = 1;
        var DEBUG_BRK = '--inspect';
        args.splice(0, 0, DEBUG_BRK +"=0.0.0.0:"+ (5588+this.globalI++));
    }

  startProcess (processPath) {
    Logger.info("[ProcessManager] Starting process at path", processPath);
      let proc;
  /*    if//(0){
      (processPath.indexOf("process") >= 0){

         // return;
          var processParameters = [processPath];
          this.addDebugParameter(processParameters);
          console.error("hxtest find process process,set it debug param=" + processParameters);
           proc = cp.fork(processPath, {
              // Pass over all of the environment.
              env: process.ENV,
              // Share stdout/stderr, so we can hear the inevitable errors.
              silent: false,
               execArgv:processParameters
          });

      }else {*/
      var processParameters = [processPath];
      this.addDebugParameter(processParameters);
      console.error("hxtest find process process,set it debug param=" + processParameters);
           proc = cp.fork(processPath, {
              // Pass over all of the environment.
              env: process.ENV,
              // Share stdout/stderr, so we can hear the inevitable errors.
              silent: false,
               execArgv:processParameters

          });
   //   }

    proc.path = processPath;

    proc.on('message', this.onMessage);
    proc.on('error', this.onError);

    // Tries to restart process on unsucessful exit
    proc.on('exit', (code, signal) => {
      let processId = proc.pid;
      if (this.runningState === 'RUNNING' && code === 1) {
        Logger.error('[ProcessManager] Received exit event from child process with PID', proc.pid, ' with code', code, '. Restarting it');
        this.restartProcess(processId);
      }
    });

    return proc;
  }

  restartProcess (pid) {
    let proc = this.processes[pid];
    if (proc) {
      let newProcess = this.startProcess(proc.path);
      this.processes[newProcess.pid] = newProcess;
      delete this.processes[pid];
    }
  }

  onMessage (message) {
    Logger.info('[ProcessManager] Received child message from', this.pid, message);
  }

  onError (e) {
    Logger.error('[ProcessManager] Received child error', this.pid, e);
  }

  onDisconnect (e) {
  }

  async finishChildProcesses () {
    this.runningState = "STOPPING";

    for (var proc in this.processes) {
      if (this.processes.hasOwnProperty(proc)) {
        let procObj = this.processes[proc];
        if (typeof procObj.exit === 'function' && !procObj.killed) {
          await procObj.exit()
        }
      }
    }

    this.runningState = "STOPPED";
  }
}
