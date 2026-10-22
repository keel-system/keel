// Instrumentación del sandbox (keel-recover), no código del legacy: paso 1a en Express. Express no
// tiene un endpoint que liste sus rutas, así que se leen del PROCESO: se carga con
// NODE_OPTIONS=--require, envuelve `express()` para conocer cada app y, cuando el servidor escucha,
// recorre su pila (routers anidados incluidos) y escribe la tabla en RECOVER_ROUTES_OUT. Lo lee
// `keel-recover introspect`. Medido en Express 4 (`app._router`, capas con `regexp`); en Express 5
// la pila está en `app.router` y el prefijo de un router montado no se puede leer de su regexp: la
// ruta sale sin él y marcada `mount: unknown`.
'use strict';

var Module = require('module');
var fs = require('fs');
var http = require('http');

var OUT = process.env.RECOVER_ROUTES_OUT || '/coverage/keel-recover-routes.json';
var apps = [];
var origLoad = Module._load;

Module._load = function (request) {
  var exported = origLoad.apply(this, arguments);
  if (request === 'express' && typeof exported === 'function' && !exported.__keelRecover) {
    var wrapped = function () {
      var app = exported.apply(this, arguments);
      apps.push(app);
      return app;
    };
    Object.keys(exported).forEach(function (k) {
      wrapped[k] = exported[k];
    });
    wrapped.__keelRecover = true;
    return wrapped;
  }
  return exported;
};

// El prefijo de un router montado sale de su regexp: /^\/api\/?(?=\/|$)/i → /api
var MOUNT_TAIL = new RegExp('\\\\/\\?\\(\\?=\\\\/\\|\\$\\)$');
var PARAM = new RegExp('\\(\\?:\\(\\[\\^\\\\/\\]\\+\\?\\)\\)', 'g');

function mountOf(layer) {
  if (!layer.regexp) return null;
  if (layer.regexp.fast_slash) return '';
  var i = 0;
  return layer.regexp.source
    .replace(/^\^/, '')
    .replace(MOUNT_TAIL, '')
    .replace(PARAM, function () {
      return ':' + ((layer.keys[i++] || {}).name || 'param');
    })
    .split('\\/')
    .join('/');
}

function walk(stack, prefix, out, unknownMount) {
  (stack || []).forEach(function (layer) {
    var mount = mountOf(layer);
    if (layer.route) {
      Object.keys(layer.route.methods).forEach(function (m) {
        if (m === '_all') return;
        var row = {
          method: m.toUpperCase(),
          path: prefix + layer.route.path,
          handlers: layer.route.stack.map(function (s) {
            return s.name || '<anonymous>';
          }),
        };
        if (unknownMount) row.mount = 'unknown';
        out.push(row);
      });
    } else if (layer.handle && layer.handle.stack && (layer.name === 'router' || layer.name === 'handle')) {
      walk(layer.handle.stack, prefix + (mount || ''), out, unknownMount || mount === null);
    } else {
      out.push({ middleware: layer.name || '<anonymous>', mount: prefix + (mount || '') || '/' });
    }
  });
}

var origListen = http.Server.prototype.listen;
http.Server.prototype.listen = function () {
  this.once('listening', function () {
    var out = [];
    apps.forEach(function (app) {
      var router = app._router || app.router;
      if (router) walk(router.stack, '', out, false);
    });
    try {
      fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    } catch (err) {
      console.error('keel-recover: no se pudo escribir la tabla de rutas en ' + OUT + ': ' + err.message);
    }
  });
  return origListen.apply(this, arguments);
};
