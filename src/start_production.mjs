// src/start_production.mjs
// Combined supervisor launching both the web dashboard (server.mjs) and CLMM/hedge monitor (index.mjs)
// inside a single container so both share .monitor-status.json on local disk.

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

let shuttingDown = false;
let pendingExitCode = 0;
let serverProc = null;
let monitorProc = null;
let monitorRestartTimer = null;

function maybeFinishShutdown() {
  if (shuttingDown && !serverProc && !monitorProc) {
    process.exit(pendingExitCode);
  }
}

function spawnService(name, scriptRelPath) {
  const proc = spawn(process.execPath, [path.join(ROOT_DIR, scriptRelPath)], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: process.env
  });
  console.log(`[Supervisor] Started ${name} (pid: ${proc.pid})`);
  return proc;
}

function startMonitorWithRestart() {
  if (shuttingDown) return;
  monitorProc = spawnService('monitor', 'src/index.mjs');
  monitorProc.on('exit', (code, signal) => {
    monitorProc = null;
    if (shuttingDown) {
      maybeFinishShutdown();
      return;
    }
    console.error(`[Supervisor] monitor exited unexpectedly (code=${code}, signal=${signal}); restarting in 5s...`);
    monitorRestartTimer = setTimeout(startMonitorWithRestart, 5000);
  });
}

function startServer() {
  serverProc = spawnService('server', 'src/server.mjs');
  serverProc.on('exit', (code, signal) => {
    serverProc = null;
    if (shuttingDown) {
      maybeFinishShutdown();
      return;
    }
    console.error(`[Supervisor] server exited unexpectedly (code=${code}, signal=${signal}); shutting down supervisor.`);
    shutdown(code || 1);
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  pendingExitCode = exitCode;
  if (monitorRestartTimer) clearTimeout(monitorRestartTimer);

  for (const [label, proc] of [['server', serverProc], ['monitor', monitorProc]]) {
    if (proc && !proc.killed) {
      try {
        console.log(`[Supervisor] Stopping ${label}...`);
        proc.kill('SIGTERM');
      } catch {}
    }
  }

  maybeFinishShutdown();
  setTimeout(() => {
    for (const proc of [serverProc, monitorProc]) {
      if (proc && !proc.killed) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }
    process.exit(pendingExitCode);
  }, 4000).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

startServer();
startMonitorWithRestart();
