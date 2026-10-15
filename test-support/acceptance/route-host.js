// NOT-476: serves the real Botmancers API route handlers (app/api/**/route.ts)
// behind the real owner boundary (proxy.ts) on an ephemeral loopback port.
//
// `next dev` would write .next/ and regenerate next-env.d.ts and AGENTS.md
// in the working repository, so the harness does not start it. Instead the
// route modules are loaded through the caller's jiti instance (sharing its
// database module), and each HTTP request becomes a standard Request:
// proxy() runs first exactly as Next's middleware would, then the matched
// handler with its awaited dynamic params. Never binds a fixed port.
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS harness consumed by standalone Node tests. */

const fs = require('fs');
const http = require('http');
const path = require('path');

function discoverRoutes(apiDir) {
  const routes = [];
  const walk = (dir, segments) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), [...segments, entry.name]);
      else if (entry.name === 'route.ts') routes.push({ file: path.join(dir, entry.name), segments });
    }
  };
  walk(apiDir, ['api']);
  return routes.map(route => {
    const names = [];
    const pattern = route.segments.map(segment => {
      const param = /^\[(\w+)\]$/.exec(segment);
      if (param) { names.push(param[1]); return '([^/]+)'; }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    // Static segments win over dynamic ones at the same depth.
    const dynamic = names.length;
    return { ...route, names, dynamic, regex: new RegExp(`^/${pattern}$`) };
  }).sort((a, b) => a.dynamic - b.dynamic);
}

async function startRouteHost({ jiti, repoRoot, port }) {
  const { NextRequest } = require('next/server');
  const proxy = jiti(path.join(repoRoot, 'proxy.ts'));
  const routes = discoverRoutes(path.join(repoRoot, 'app', 'api'));
  const modules = new Map();
  const requests = [];

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    const init = { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) };
    let response;
    const gate = proxy.proxy(new NextRequest(url, init));
    if (!gate.headers.get('x-middleware-next')) {
      response = gate;
    } else {
      const route = routes.find(candidate => candidate.regex.test(url.pathname));
      if (!route) {
        response = Response.json({ error: 'not found' }, { status: 404 });
      } else {
        if (!modules.has(route.file)) modules.set(route.file, jiti(route.file));
        const mod = modules.get(route.file);
        const handler = mod[req.method];
        if (typeof handler !== 'function') {
          response = Response.json({ error: 'method not allowed' }, { status: 405 });
        } else {
          const values = route.regex.exec(url.pathname).slice(1).map(decodeURIComponent);
          const params = Object.fromEntries(route.names.map((name, i) => [name, values[i]]));
          response = await handler(new NextRequest(url, init), { params: Promise.resolve(params) });
        }
      }
    }
    requests.push({ method: req.method, path: url.pathname, status: response.status });
    const body = Buffer.from(await response.arrayBuffer());
    const outHeaders = {};
    response.headers.forEach((value, key) => { if (!key.startsWith('x-middleware')) outHeaders[key] = value; });
    res.writeHead(response.status, outHeaders);
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error && error.message) }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    // A same-origin owner request, as the Botmancers page sends it.
    async owner(method, pathname, body) {
      const response = await fetch(origin + pathname, {
        method,
        headers: { 'content-type': 'application/json', origin },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, json, text };
    },
    // A mutating request from another origin.
    async foreign(method, pathname, body) {
      const response = await fetch(origin + pathname, {
        method,
        headers: { 'content-type': 'application/json', origin: 'http://evil.invalid' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

module.exports = { discoverRoutes, startRouteHost };
