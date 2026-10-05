import { readFile, writeFile, mkdir, rename, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { X509Certificate, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { certificateNeedsRenewal } from './certificates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const runtime = path.join(root, '.runtime');
const stateFile = path.join(runtime, 'server.json');
const certDir = path.join(root, 'certs');
const caRecord = path.join(certDir, 'authority.json');
const certFile = path.join(certDir, 'pocketlink.pem');
const keyFile = path.join(certDir, 'pocketlink-key.pem');
const mkcertFile = path.join(root, 'mkcert.exe');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
};
async function run(file, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { cwd: root, windowsHide: true, ...options });
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', (data) => (stdout += data));
    child.stderr?.on('data', (data) => (stderr += data));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`${path.basename(file)} 执行失败 (${code})\n${stderr.trim()}`)),
    );
  });
}
function portValue(flag, fallback) {
  const index = args.indexOf(flag);
  const value = index < 0 ? fallback : Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1024 || value > 65535)
    throw new Error(`${flag} 必须为 1024–65535。`);
  return value;
}
async function control(state, action) {
  if (!state || !Number.isInteger(state.setupPort) || typeof state.token !== 'string') return false;
  try {
    const response = await fetch(`http://127.0.0.1:${state.setupPort}/__${action}`, {
      method: action === 'stop' ? 'POST' : 'GET',
      headers: { 'X-PocketLink-Token': state.token },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    return action === 'stop' || (await response.json()).app === 'PocketLink';
  } catch {
    return false;
  }
}
async function stopRunning() {
  const state = await json(stateFile);
  if (!(await control(state, 'status'))) {
    console.log('没有发现由启动脚本运行的 PocketLink 服务。');
    return;
  }
  if (!(await control(state, 'stop'))) throw new Error('停止请求失败，请在启动窗口按 Ctrl+C。');
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!(await control(state, 'status'))) {
      console.log('PocketLink 已停止。');
      return;
    }
    await pause(100);
  }
  throw new Error('服务仍在结束，请稍后重试。');
}
async function ensureFree(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () =>
      reject(
        new Error(
          `端口 ${port} 已被占用。请先关闭之前启动的服务，再运行本脚本。不会自动终止其他程序。`,
        ),
      ),
    );
    probe.listen(port, '0.0.0.0', () => probe.close(resolve));
  });
}
async function ensureMkcert(checkOnly) {
  try {
    await readFile(mkcertFile);
    return;
  } catch {}
  if (checkOnly) throw new Error('尚未下载 mkcert，请正常运行启动脚本。');
  if (process.platform !== 'win32') throw new Error('此启动器面向 Windows。');
  console.log('正在从 mkcert 官方 GitHub 下载工具…');
  const response = await fetch(
    'https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-windows-amd64.exe',
    { signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok)
    throw new Error(
      `mkcert 下载失败：HTTP ${response.status}。可从官方 Releases 下载到项目目录，命名为 mkcert.exe 后重试。`,
    );
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length < 100000 || data.subarray(0, 2).toString() !== 'MZ')
    throw new Error('下载的 mkcert 文件格式错误。');
  await writeFile(mkcertFile + '.download', data);
  await rename(mkcertFile + '.download', mkcertFile);
}
function browser(port) {
  if (args.includes('--no-browser') || process.platform !== 'win32') return;
  const child = spawn(
    'rundll32.exe',
    ['url.dll,FileProtocolHandler', `https://localhost:${port}/receiver`],
    { windowsHide: true, stdio: 'ignore' },
  );
  child.on('error', () => console.log(`请在浏览器打开 https://localhost:${port}/receiver`));
  child.unref();
}
async function addresses() {
  const all = [
    ...new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter((v) => v.family === 'IPv4' && !v.internal && !v.address.startsWith('169.254.'))
        .map((v) => v.address),
    ),
  ];
  const virtualRange = (ip) => /^198\.(18|19)\./.test(ip);
  all.sort((a, b) => Number(virtualRange(a)) - Number(virtualRange(b)));
  // Prefer the Windows default route; users with VPN/multiple NICs can choose another address in Settings.
  try {
    const primary = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$r=Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Where-Object {(Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue).HardwareInterface} | Sort-Object @{Expression={$_.RouteMetric+$_.InterfaceMetric}} | Select-Object -First 1; if($r){Get-NetIPAddress -InterfaceIndex $r.InterfaceIndex -AddressFamily IPv4 | Where-Object {$_.AddressState -eq 'Preferred'} | Select-Object -First 1 -ExpandProperty IPAddress}",
    ]);
    if (all.includes(primary)) return [primary, ...all.filter((ip) => ip !== primary)];
  } catch {}
  return all;
}
async function main() {
  if (args.includes('--stop')) {
    await stopRunning();
    return;
  }
  const port = portValue('--port', 8787),
    setupPort = portValue('--setup-port', 8788);
  if (port === setupPort) throw new Error('HTTPS 和首次设置页面必须使用不同端口。');
  const checkOnly = args.includes('--check');
  await ensureMkcert(checkOnly);
  const saved = await json(caRecord);
  const caDir = saved?.directory || (await run(mkcertFile, ['-CAROOT']));
  const mkcertEnv = { ...process.env, CAROOT: caDir, TRUST_STORES: 'system' };
  const caFile = path.join(caDir, 'rootCA.pem');
  let ca;
  try {
    ca = await readFile(caFile);
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error(`无法读取已有根证书 (${error.code})，请检查 CA 目录的访问权限。`);
    if (saved || checkOnly)
      throw new Error(
        '原根证书丢失，请恢复原 mkcert CA 目录。不要随意重建，否则 iPhone 需要重新信任。',
      );
  }
  const ips = await addresses(),
    names = ['localhost', '127.0.0.1', '::1', ...ips];
  let cert, key;
  try {
    cert = await readFile(certFile);
    key = await readFile(keyFile);
  } catch {}
  const renew = !ca || certificateNeedsRenewal({ cert, key, root: ca, names });
  if (checkOnly) {
    console.log(
      JSON.stringify(
        {
          addresses: ips,
          rootDirectory: caDir,
          rootFingerprint: ca ? new X509Certificate(ca).fingerprint256 : null,
          certificateNeedsRenewal: renew,
          receiver: `https://localhost:${port}/receiver`,
          setupPort,
        },
        null,
        2,
      ),
    );
    return;
  }
  await mkdir(runtime, { recursive: true });
  const lockFile = path.join(runtime, 'starting.lock');
  let lock;
  try {
    lock = await open(lockFile, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await json(lockFile);
    let alive = true;
    try {
      if (!previous?.pid) throw new Error();
      process.kill(previous.pid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw new Error('PocketLink 正在启动，请等待当前启动窗口完成。');
    await unlink(lockFile);
    lock = await open(lockFile, 'wx');
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  let app, setup, state;
  try {
    const old = await json(stateFile);
    if (await control(old, 'status')) {
      if (
        !renew &&
        old.port === port &&
        old.setupPort === setupPort &&
        JSON.stringify(old.addresses) === JSON.stringify(ips)
      ) {
        console.log('PocketLink 已在运行，正在打开接收端。');
        browser(port);
        return;
      }
      console.log('网络或证书已变化，正在重新启动 PocketLink…');
      await stopRunning();
      await pause(300);
    }
    await ensureFree(port);
    await ensureFree(setupPort);
    console.log('正在检查电脑的证书信任（首次运行可能出现系统确认）…');
    await run(mkcertFile, ['-install'], { env: mkcertEnv });
    ca = await readFile(caFile);
    const rootCertificate = new X509Certificate(ca);
    if (Date.parse(rootCertificate.validTo) < Date.now() + 30 * 86400000)
      throw new Error('根证书即将过期，需要更换并在 iPhone 上重新安装。');
    if (saved?.fingerprint && saved.fingerprint !== rootCertificate.fingerprint256)
      throw new Error(
        '根证书与上次不同。请恢复原 CA，或确认更换后删除 certs/authority.json 并在手机重新安装。',
      );
    await mkdir(certDir, { recursive: true });
    await writeFile(
      caRecord,
      JSON.stringify({ directory: caDir, fingerprint: rootCertificate.fingerprint256 }, null, 2),
    );
    if (certificateNeedsRenewal({ cert, key, root: ca, names })) {
      console.log('正在为当前网络地址签发 HTTPS 证书，手机无需重复安装同一根证书…');
      const pendingCert = path.join(certDir, 'pocketlink-next.pem'),
        pendingKey = path.join(certDir, 'pocketlink-next-key.pem');
      await run(mkcertFile, ['-cert-file', pendingCert, '-key-file', pendingKey, ...names], {
        env: mkcertEnv,
      });
      if (
        certificateNeedsRenewal({
          cert: await readFile(pendingCert),
          key: await readFile(pendingKey),
          root: ca,
          names,
        })
      )
        throw new Error('生成的证书未通过验证。');
      await rename(pendingKey, keyFile);
      await rename(pendingCert, certFile);
    } else console.log('当前 HTTPS 证书可复用。');
    const { createPocketServer } = await import('../server/index.mjs');
    const { createSetupServer } = await import('../server/setup.mjs');
    const token = randomBytes(32).toString('hex');
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await Promise.all([app?.close(), setup?.close()]);
      if ((await json(stateFile))?.token === token) await unlink(stateFile).catch(() => {});
      console.log('PocketLink 已停止。');
    };
    setup = createSetupServer({
      rootCertificate: ca,
      addresses: ips,
      httpsPort: port,
      controlToken: token,
      onStop: () => {
        void shutdown();
      },
    });
    await new Promise((resolve, reject) => {
      setup.server.once('error', reject);
      setup.server.listen(setupPort, '0.0.0.0', resolve);
    });
    // The launcher always serves locally; inherited PUBLIC_ORIGIN must not advertise a stale host.
    app = await createPocketServer({
      port,
      phoneAddresses: ips,
      setup: { port: setupPort, certificate: setup.certificate },
      env: { ...process.env, TLS_CERT: certFile, TLS_KEY: keyFile, PUBLIC_ORIGIN: '' },
    });
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(port, '0.0.0.0', resolve);
    });
    state = { pid: process.pid, port, setupPort, addresses: ips, token };
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
    process.once('SIGINT', () => {
      void shutdown();
    });
    process.once('SIGTERM', () => {
      void shutdown();
    });
    console.log(`\n已启动： https://localhost:${port}/receiver`);
    for (const ip of ips)
      console.log(`手机： https://${ip}:${port}    首次设置： http://${ip}:${setupPort}/setup`);
    if (!ips.length) console.log('未检测到局域网地址，请连接 Wi-Fi 或有线网络后重新运行。');
    console.log(
      '\n手机与电脑连接同一网络，在接收端扫码。首次证书安装与信任需在 iPhone 设置中完成。',
    );
    console.log('如 Windows 提示防火墙访问，请允许 Node.js 访问所用的可信专用网络。');
    console.log(
      '保持此窗口打开。停止：Ctrl+C，或双击 Stop-PocketLink.cmd。切换网络后重新运行启动脚本。\n',
    );
    browser(port);
  } catch (error) {
    await Promise.allSettled([app?.close(), setup?.close()]);
    throw error;
  } finally {
    await lock.close();
    await unlink(lockFile).catch(() => {});
  }
}
main().catch((error) => {
  console.error(`\nPocketLink 启动失败：${error.message}`);
  process.exitCode = 1;
});
