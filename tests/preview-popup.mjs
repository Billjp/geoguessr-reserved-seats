// Local visual preview only: no GeoGuessr API or companion calls.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const seats = Array.from({ length: 5 }, (_, index) => ({ seatId: String(index + 1).repeat(32), nick: `ReservedSeat-${index + 1}`, partyCode: 'ABCDE', state: 'holding', selection: 'candidate', warning: null }));
const previewStatus = { ready: true, maxSeats: 100, configuredCount: 5, reservation: { partyCode: 'ABCDE', target: 5, state: 'holding', warning: null, capacity: 20, availableToReserve: 19 }, seats };
const mock = `globalThis.chrome = {runtime: {sendMessage: async message => {
  if (message.action === 'reservationSettings') return {ok:true,result:{configuredCount:5}};
  if (message.action === 'hostStatus') return {ok:true,result:${JSON.stringify(previewStatus)}};
  return {ok:false,error:'表示確認用ページです。実際の操作は拡張から行ってください。'};
}}};`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
createServer(async (request, response) => {
  const name = request.url === '/' ? 'popup.html' : request.url.slice(1);
  if (!['popup.html', 'popup.css', 'popup.js', 'mock.js'].includes(name)) { response.writeHead(404).end(); return; }
  if (name === 'mock.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(mock); return; }
  let body = await readFile(new URL(`../extension/${name}`, import.meta.url), 'utf8');
  if (name === 'popup.html') body = body.replace('<script type="module"', '<script src="mock.js"></script><script type="module"');
  response.writeHead(200, { 'Content-Type': `${types[name.slice(name.lastIndexOf('.'))]}; charset=utf-8`, 'Cache-Control': 'no-store' }).end(body);
}).listen(38478, '127.0.0.1', () => console.log('Popup visual preview: http://127.0.0.1:38478'));
