/* Tiny static server. ES modules, importmaps and cross-origin textures all
   need a real HTTP origin — opening index.html as file:// gives Chrome an
   opaque origin and every one of those loads is refused.
   node serve.mjs [port]                                                    */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = +(process.argv[2] || 8099);
const ROOT = path.resolve('.');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
                '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

http.createServer((rq, rs) => {
  const rel = decodeURI(rq.url.split('?')[0]);
  const f = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!f.startsWith(ROOT)) { rs.writeHead(403); return rs.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { rs.writeHead(404, { 'content-type': 'text/plain' }); return rs.end('not found'); }
    rs.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream',
                        'cache-control': 'no-cache' });
    rs.end(d);
  });
}).listen(PORT, () => console.log(`nightdrive → http://localhost:${PORT}/`));
