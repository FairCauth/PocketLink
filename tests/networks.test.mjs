import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNetworks } from '../scripts/networks.mjs';
import { createPocketServer } from '../server/index.mjs';
import QRCode from 'qrcode';

test('USB detection uses Apple adapter identity, not an assumed IP range', () => {
  const address = (ip, extra = {}) => ({ family: 'IPv4', address: ip, internal: false, ...extra });
  const result = classifyNetworks(
    {
      Ethernet: [address('10.42.0.2')],
      WiFi: [address('172.20.10.8')],
      Broken: [address('169.254.2.1')],
      Loopback: [address('127.0.0.1', { internal: true })],
    },
    [{ name: 'Ethernet', description: 'Apple Mobile Device Ethernet #2' }],
  );
  assert.deepEqual(
    result.map(({ address, kind }) => [address, kind]),
    [
      ['10.42.0.2', 'usb'],
      ['172.20.10.8', 'lan'],
    ],
  );
  assert.equal(classifyNetworks({ Ethernet: [address('172.20.10.2')] })[0].kind, 'lan');
});

test('shared-network QR remains wireless; USB cannot fall back to a hotspot QR', async (t) => {
  const app = await createPocketServer({
    port: 0,
    env: {},
    phoneAddresses: ['192.168.1.2', '172.20.10.2'],
    usbAddresses: ['172.20.10.2'],
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(config.phoneNetworks, [{ kind: 'lan' }, { kind: 'usb' }]);
  assert.equal(
    await (await fetch(`${base}/api/qr.svg?index=1&code=12345678&mode=lan`)).text(),
    await QRCode.toString(`${config.phoneURLs[1]}/#pair=12345678&mode=lan`, {
      type: 'svg',
      margin: 4,
      errorCorrectionLevel: 'M',
    }),
  );
  assert.equal((await fetch(`${base}/api/qr.svg?index=0&code=12345678&mode=usb`)).status, 400);
  assert.equal((await fetch(`${base}/api/qr.svg?index=1&code=12345678&mode=usb`)).status, 400);
  assert.equal(config.usbProtocol, 'pocketlink-usb-v1');
  assert.equal((await fetch(`${base}/api/qr.svg?index=1&code=12345678&mode=bad`)).status, 400);
});
