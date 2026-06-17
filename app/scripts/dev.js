const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const appDir = path.join(__dirname, '..');
const binExt = process.platform === 'win32' ? '.cmd' : '';
const viteBin = path.join(appDir, 'node_modules', '.bin', `vite${binExt}`);
const electronBin = path.join(appDir, 'node_modules', '.bin', `electron${binExt}`);
const DEFAULT_DEV_PORT = Number(process.env.OBELISK_DEV_SERVER_PORT || 5173);

let viteProcess = null;
let electronProcess = null;
let shuttingDown = false;

function spawnLocal(command, args, extraEnv = {}) {
  return spawn(command, args, {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    shell: process.platform === 'win32',
  });
}

function waitForDevServer(url, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve();
        } else {
          if (Date.now() - started >= timeoutMs) {
            reject(new Error(`Timed out waiting for ${url}`));
          } else {
            setTimeout(poll, 250);
          }
        }
      });
      req.on('error', () => {
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(poll, 250);
      });
      req.setTimeout(1000, () => {
        req.destroy();
      });
    };
    poll();
  });
}

function isDevServerRunning(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found from ${startPort} to ${startPort + 19}`);
}

function stopChild(child) {
  if (!child || child.killed) return;
  child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChild(electronProcess);
  stopChild(viteProcess);
  process.exit(exitCode);
}

async function main() {
  let devPort = DEFAULT_DEV_PORT;
  let devUrl = `http://127.0.0.1:${devPort}`;
  const existingServer = await isDevServerRunning(devUrl);
  if (existingServer) {
    console.log(`Using existing Vite dev server at ${devUrl}`);
  } else {
    devPort = await findAvailablePort(DEFAULT_DEV_PORT);
    devUrl = `http://127.0.0.1:${devPort}`;
    viteProcess = spawnLocal(viteBin, ['renderer', '--host', '127.0.0.1', '--port', String(devPort), '--strictPort']);
    viteProcess.on('exit', (code, signal) => {
      if (!shuttingDown && !electronProcess) shutdown(code || (signal ? 1 : 0));
    });

    try {
      await waitForDevServer(devUrl);
    } catch (error) {
      console.error(error.message);
      shutdown(1);
      return;
    }
  }

  electronProcess = spawnLocal(electronBin, ['.', '--dev', ...process.argv.slice(2)], {
    OBELISK_DEV_SERVER_URL: devUrl,
  });
  electronProcess.on('exit', (code, signal) => {
    shutdown(code || (signal ? 1 : 0));
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((error) => {
  console.error(error);
  shutdown(1);
});
