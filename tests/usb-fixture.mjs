import net from 'node:net';
import { muxPacket, parsePlist } from '../server/usbmux.mjs';
import { frameReader, jsonFrame, frame } from '../server/usb-bridge.mjs';

// Simulates Apple's daemon + the native app, including fragmented/coalesced TCP.
export async function fakeUSB({ rejectPair = false, devices, fragment = false } = {}) {
  const sockets = new Set(),
    tunnels = new Set(),
    commands = [],
    connections = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      tunnels.delete(socket);
    });
    let input = Buffer.alloc(0),
      tunnel = false;
    const receive = frameReader((payload) => {
      const message = JSON.parse(payload.subarray(1));
      commands.push(message);
      if (message.type === 'hello') {
        if (rejectPair) {
          socket.destroy();
          return;
        }
        socket.write(jsonFrame({ type: 'ready', protocol: 'pocketlink-usb-v1' }));
        tunnels.add(socket);
      }
    });
    socket.on('data', (data) => {
      if (tunnel) {
        receive(data);
        return;
      }
      input = Buffer.concat([input, data]);
      if (input.length < 16 || input.length < input.readUInt32LE(0)) return;
      const value = parsePlist(input.subarray(16, input.readUInt32LE(0)).toString());
      if (value.MessageType === 'ListDevices') {
        const packet = muxPacket({
          DeviceList: devices || [
            { DeviceID: 8, Properties: { ConnectionType: 'Network', SerialNumber: 'wireless' } },
            { DeviceID: 9, Properties: { ConnectionType: 'USB', SerialNumber: 'wired' } },
          ],
        });
        if (fragment) {
          socket.write(packet.subarray(0, 7));
          setTimeout(() => socket.end(packet.subarray(7)), 5);
        } else socket.end(packet);
      } else if (value.MessageType === 'Connect') {
        connections.push(value);
        tunnel = true;
        socket.write(muxPacket({ MessageType: 'Result', Number: 0 }));
        const tail = input.subarray(input.readUInt32LE(0));
        if (tail.length) receive(tail);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    address: { host: '127.0.0.1', port: server.address().port },
    commands,
    connections,
    tunnels,
    get activeConnections() {
      return sockets.size;
    },
    control: (message) => {
      for (const socket of tunnels) socket.write(jsonFrame({ type: 'control', message }));
    },
    ping: () => {
      for (const socket of tunnels) socket.write(jsonFrame({ type: 'ping' }));
    },
    audio: () => {
      const payload = Buffer.alloc(5 + 960);
      payload[0] = 2;
      payload.writeUInt32LE(48000, 1);
      for (let i = 0; i < 480; i++)
        payload.writeInt16LE(
          Math.round(Math.sin((i * 2 * Math.PI * 1000) / 48000) * 10000),
          5 + 2 * i,
        );
      for (const socket of tunnels) socket.write(frame(payload));
    },
    unplug: () => {
      for (const socket of tunnels) socket.destroy();
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}
