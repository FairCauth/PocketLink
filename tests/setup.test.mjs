import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { X509Certificate } from 'node:crypto';
import { certificateNeedsRenewal } from '../scripts/certificates.mjs';
import { createSetupServer } from '../server/setup.mjs';
import { createPocketServer } from '../server/index.mjs';

const mkcert = fileURLToPath(new URL('../mkcert.exe', import.meta.url));
let available = process.platform === 'win32';
try {
  await access(mkcert);
} catch {
  available = false;
}
test(
  'local setup: renewal, unchanged CA, certificate-only download and protected stop',
  { skip: !available },
  async (t) => {
    const folder = await mkdtemp(path.join(tmpdir(), 'pocketlink-test-'));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const certFile = path.join(folder, 'server.pem'),
      keyFile = path.join(folder, 'server-key.pem');
    const issue = (names) =>
      execFileSync(mkcert, ['-cert-file', certFile, '-key-file', keyFile, ...names], {
        env: { ...process.env, CAROOT: folder, TRUST_STORES: 'none' },
        windowsHide: true,
        stdio: 'pipe',
      });
    const names = ['localhost', '127.0.0.1'];
    issue(names);
    const root = await readFile(path.join(folder, 'rootCA.pem'));
    const cert = await readFile(certFile),
      key = await readFile(keyFile);
    assert.equal(certificateNeedsRenewal({ cert, key, root, names }), false);
    assert.equal(
      certificateNeedsRenewal({ cert, key, root, names: [...names, '192.168.50.20'] }),
      true,
    );
    assert.equal(
      certificateNeedsRenewal({
        cert,
        key,
        root,
        names,
        now: Date.parse(new X509Certificate(cert).validTo),
      }),
      true,
    );
    assert.equal(certificateNeedsRenewal({ cert, key: root, root, names }), true);
    issue([...names, '192.168.50.20']);
    assert.deepEqual(
      await readFile(path.join(folder, 'rootCA.pem')),
      root,
      'IP changes must preserve the CA',
    );
    assert.equal(
      certificateNeedsRenewal({
        cert: await readFile(certFile),
        key: await readFile(keyFile),
        root,
        names: [...names, '192.168.50.20'],
      }),
      false,
    );
    let stopped = false;
    const setup = createSetupServer({
      rootCertificate: root,
      addresses: ['127.0.0.1'],
      httpsPort: 8787,
      controlToken: 'test-token',
      onStop: () => (stopped = true),
    });
    setup.server.listen(0, '127.0.0.1');
    await once(setup.server, 'listening');
    t.after(() => setup.close());
    const port = setup.server.address().port,
      base = `http://127.0.0.1:${port}`;
    const page = await (await fetch(base + '/setup')).text();
    assert.match(page, /Settings → Profile Downloaded → Install/);
    assert.match(page, /https:\/\/127\.0\.0\.1:8787\//);
    const download = await fetch(base + '/rootCA.cer');
    assert.equal(download.headers.get('content-type'), 'application/x-x509-ca-cert');
    assert.equal(
      new X509Certificate(Buffer.from(await download.arrayBuffer())).fingerprint256,
      new X509Certificate(root).fingerprint256,
    );
    for (const route of [
      '/rootCA-key.pem',
      '/certs/pocketlink-key.pem',
      '/server.json',
      '/receiver',
      '/api/config',
    ])
      assert.equal((await fetch(base + route)).status, 404);
    assert.equal((await fetch(base + '/__stop', { method: 'POST' })).status, 403);
    assert.equal(
      (
        await fetch(base + '/__stop', {
          method: 'POST',
          headers: { 'x-pocketlink-token': 'test-token', origin: base },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + '/__status', { headers: { 'x-pocketlink-token': 'test-token' } })).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + '/__stop', {
          method: 'POST',
          headers: { 'x-pocketlink-token': 'test-token' },
        })
      ).status,
      200,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, true);
    const app = await createPocketServer({
      port: 0,
      env: {},
      phoneAddresses: ['127.0.0.1'],
      setup: { port, certificate: setup.certificate },
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    t.after(() => app.close());
    const appBase = `http://127.0.0.1:${app.server.address().port}`;
    const config = await (await fetch(appBase + '/api/config')).json();
    assert.deepEqual(config.setupURLs, [base + '/setup']);
    assert.equal(config.certificate.fingerprint, setup.certificate.fingerprint);
    for (const kind of ['phone', 'setup']) {
      const response = await fetch(appBase + `/api/qr.svg?kind=${kind}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<svg/);
    }
    assert.equal((await fetch(appBase + '/api/qr.svg?index=999')).status, 404);
  },
);
