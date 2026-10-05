import http from 'node:http';
import { X509Certificate, timingSafeEqual } from 'node:crypto';

const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const local = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
export function createSetupServer({ rootCertificate, addresses, httpsPort, controlToken, onStop }) {
  const certificate = new X509Certificate(rootCertificate);
  if (!certificate.ca || !certificate.verify(certificate.publicKey))
    throw new Error('Not a self-signed root certificate');
  const allowed = new Set(['127.0.0.1', 'localhost', '[::1]', ...addresses]);
  const matchesToken = (value) =>
    typeof value === 'string' &&
    Buffer.byteLength(value) === Buffer.byteLength(controlToken) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(controlToken));
  const server = http.createServer((req, res) => {
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    };
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
      if (!allowed.has(url.hostname)) throw new Error();
    } catch {
      res.writeHead(403, headers).end();
      return;
    }
    if (url.pathname.startsWith('/__')) {
      if (
        !local(req.socket.remoteAddress) ||
        req.headers.origin ||
        !matchesToken(req.headers['x-pocketlink-token'])
      ) {
        res.writeHead(403, headers).end();
        return;
      }
      if (url.pathname === '/__status' && req.method === 'GET') {
        res
          .writeHead(200, { ...headers, 'Content-Type': 'application/json' })
          .end(JSON.stringify({ app: 'PocketLink', pid: process.pid }));
        return;
      }
      if (url.pathname === '/__stop' && req.method === 'POST') {
        res.writeHead(200, headers).end('Stopping');
        setImmediate(onStop);
        return;
      }
      res.writeHead(404, headers).end();
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
      return;
    }
    if (url.pathname === '/rootCA.cer') {
      res
        .writeHead(200, {
          ...headers,
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="PocketLink-rootCA.cer"',
        })
        .end(req.method === 'HEAD' ? undefined : certificate.raw);
      return;
    }
    if (!['/', '/setup'].includes(url.pathname)) {
      res.writeHead(404, headers).end();
      return;
    }
    const target = `https://${url.hostname}:${httpsPort}/`;
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#111512"><title>PocketLink · 首次设置</title><style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#111512;color:#edf1e9;font:15px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:430px;margin:auto;padding:40px 26px}header{color:#c7f48b;font-weight:600}h1{font-size:27px;margin:48px 0 10px}p,li{color:#939e92}a.button{display:block;text-align:center;background:#c7f48b;color:#182211;text-decoration:none;padding:14px;border-radius:14px;font-weight:600;margin:24px 0}.secondary{background:#253022!important;color:#c7f48b!important}ol{padding-left:20px}li{margin:22px 0}b{display:block;color:#edf1e9;font-size:14px;font-weight:500}small{display:block;color:#939e92}summary{color:#939e92;cursor:pointer}code{overflow-wrap:anywhere;font-size:11px}details{margin-top:28px}.name{white-space:pre-wrap;overflow-wrap:anywhere}</style><main><header>PocketLink</header><h1>iPhone 首次设置</h1><p>请在 Safari 中打开。已安装并信任过证书，可直接打开麦克风。</p><a class="button" href="/rootCA.cer">下载根证书</a><ol><li><b>Settings → Profile Downloaded → Install</b>输入手机密码，按提示完成安装。<small>也可在 General → VPN &amp; Device Management 找到已下载的描述文件。</small></li><li><b>Settings → General → About → Certificate Trust Settings</b>在 Enable Full Trust for Root Certificates 下开启对应证书。</li><li>返回 Safari，点击下方按钮。</li></ol><a class="button secondary" href="${escape(target)}">打开麦克风</a><details><summary>证书信息</summary><p class="name">${escape(certificate.subject)}</p><small>SHA-256</small><code>${escape(certificate.fingerprint256)}</code><p>这是本电脑的根证书，请与电脑接收端显示的信息核对。同一根证书只需安装一次。</p></details></main></html>`;
    res
      .writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' })
      .end(req.method === 'HEAD' ? undefined : html);
  });
  return {
    server,
    certificate: { name: certificate.subject, fingerprint: certificate.fingerprint256 },
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
