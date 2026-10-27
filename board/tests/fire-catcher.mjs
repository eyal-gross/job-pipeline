// Stands in for the claude.ai routine trigger on localhost: accepts the board's fire POSTs and appends each payload to payloads.jsonl.
// A payload whose company name contains FAILME is answered with 500 (to test the fire-failed path).
import http from 'node:http';
import fs from 'node:fs';
const OUT = new URL('./payloads.jsonl', import.meta.url);
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let payload = null;
    try { payload = JSON.parse(JSON.parse(body).text); } catch { payload = { raw: body.slice(0, 500) }; }
    fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), payload }) + '\n');
    const fail = /FAILME/.test(JSON.stringify(payload));
    console.log('fired', payload.kind, payload.name || '', fail ? '-> 500' : '');
    res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' }); res.end(fail ? '{"error":"simulated"}' : '{"ok":true}');
  });
}).listen(8898, () => console.log('fire catcher on 8898'));
