// Windows-only smoke check. No GeoGuessr calls or guest creation.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { encodeNativeMessage } from '../native-host.mjs';
const config = JSON.parse(await readFile(new URL('../native-messaging/com.geoguessr.reserved_seats.json', import.meta.url), 'utf8'));
const command = `""${config.path}" ${config.allowed_origins[0]} --parent-window=0"`;
const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true, windowsVerbatimArguments: true });
let bytes = Buffer.alloc(0);
let stderr = '';
const replies = [];
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 10000);
child.stdout.on('data', chunk => {
  bytes = Buffer.concat([bytes, chunk]);
  while (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE(0)) {
    const size = bytes.readUInt32LE(0);
    if (size > 131072) throw new Error('Unexpected frame size.');
    const reply = JSON.parse(bytes.subarray(4, size + 4).toString('utf8'));
    replies.push(reply);
    bytes = bytes.subarray(size + 4);
    if (reply.requestId === 'launcher_status') {
      if (!reply.ok || reply.result.seats.length !== 0) throw new Error('Expected an empty native state.');
      child.stdin.write(encodeNativeMessage({ requestId: 'launcher_shutdown', action: 'shutdown' }));
    }
  }
});
child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
child.on('error', () => { clearTimeout(timeout); process.exitCode = 1; });
child.on('close', code => {
  clearTimeout(timeout);
  const passed = code === 0 && stderr === '' && bytes.length === 0 && replies.length === 2 && replies.every(reply => reply.ok);
  console.log(passed ? 'Windows native launcher: status and shutdown passed; no guest creation.' : 'Windows native launcher verification failed.');
  process.exitCode = passed ? 0 : 1;
});
child.stdin.write(encodeNativeMessage({ requestId: 'launcher_status', action: 'status' }));
