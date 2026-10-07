import { networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Use the actual Windows adapter description, never an assumed hotspot subnet.
export function classifyNetworks(interfaces, adapters = []) {
  const entries = [];
  const seen = new Set();
  for (const [name, addresses] of Object.entries(interfaces)) {
    const adapter = adapters.find((item) => item.name === name);
    const usb = /Apple.*(?:Mobile Device.*Ethernet|USB.*(?:Ethernet|Network|Tether))/i.test(
      adapter?.description || name,
    );
    for (const item of addresses || []) {
      if (
        item.family !== 'IPv4' ||
        item.internal ||
        item.address.startsWith('169.254.') ||
        seen.has(item.address)
      )
        continue;
      seen.add(item.address);
      entries.push({ address: item.address, name, kind: usb ? 'usb' : 'lan' });
    }
  }
  return entries;
}

export async function discoverNetworks() {
  let adapters = [],
    diagnostic = '';
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @(Get-NetAdapter -ErrorAction Stop | Select-Object @{n='name';e={$_.Name}},@{n='description';e={$_.InterfaceDescription}}) | ConvertTo-Json -Compress",
        ],
        { windowsHide: true, timeout: 8000, encoding: 'utf8' },
      );
      const parsed = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]');
      adapters = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      diagnostic = '无法读取 Windows 网卡信息。请重启启动脚本后重试。';
    }
  }
  return { networks: classifyNetworks(networkInterfaces(), adapters), diagnostic };
}
