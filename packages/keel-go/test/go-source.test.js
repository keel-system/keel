// go-source.js escribe Go que gofmt deja en paz y que compila, sin Go instalado. Lo que afirma este test sale de
// gofmt de verdad: `gofmt-captures.json` guarda su salida (go1.27.3) para cada forma de alinear que usa un emisor, y
// el alineador tiene que reproducirla byte a byte. go-check vuelve a juzgarlo con gofmt sobre todo lo emitido.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GENERATED_HEADER, alignRows, collectImports, goFile, importBlock, isStdlib, keyedLiteral, packageNameOf } from '../src/lib/go-source.js';

const captures = JSON.parse(fs.readFileSync(new URL('./gofmt-captures.json', import.meta.url), 'utf8'));

for (const [name, { pairs, expected }] of Object.entries(captures.keyed)) {
  test(`literal con clave (${name}): alinea y corta como go/printer`, () => {
    assert.deepEqual(keyedLiteral(pairs), expected);
  });
}

for (const [name, { rows, expected }] of Object.entries(captures.rows)) {
  test(`campos de struct (${name}): alinea como el tabwriter de gofmt`, () => {
    assert.deepEqual(alignRows(rows), expected);
  });
}

test('el nombre de un paquete importado: sin el sufijo de versión mayor ni el prefijo go-', () => {
  assert.equal(packageNameOf('go.yaml.in/yaml/v3'), 'yaml');
  assert.equal(packageNameOf('github.com/google/go-cmp/cmp'), 'cmp');
  assert.equal(packageNameOf('golang.org/x/sync/errgroup'), 'errgroup');
  assert.equal(packageNameOf('github.com/jackc/pgx/v5/stdlib'), 'stdlib');
  assert.equal(packageNameOf('net/http'), 'http');
  assert.equal(isStdlib('net/http'), true);
  assert.equal(isStdlib('product-catalog/internal/domain'), true, 'una ruta sin punto parece de la biblioteca: por eso el módulo propio se separa por prefijo');
  assert.equal(isStdlib('github.com/google/uuid'), false);
});

test('el colector se queda con lo que el cuerpo usa: no cuenta comentarios ni cadenas', () => {
  const body = 'func F() {\n\t// fmt.Println no cuenta aquí\n\t_ = "strings.ToUpper tampoco"\n\t_ = time.Now()\n}\n';
  assert.deepEqual(collectImports(['fmt', 'strings', 'time'], body).map((spec) => spec.path), ['time']);
  // Un alias cuenta por el alias, y un import en blanco se queda siempre.
  assert.deepEqual(collectImports([{ path: 'svc/config', name: 'configfiles' }, { path: 'embed', name: '_' }], 'var _ = configfiles.Files').map((spec) => spec.path), ['svc/config', 'embed']);
  // Una ruta relativa al módulo se completa.
  assert.deepEqual(collectImports(['internal/platform/config'], 'var _ = config.Load', 'svc').map((spec) => spec.path), ['svc/internal/platform/config']);
});

test('los imports van en los tres grupos de goimports, cada uno ordenado', () => {
  const block = importBlock([{ path: 'svc/internal/httpapi' }, { path: 'golang.org/x/sync/errgroup' }, { path: 'net/http' }, { path: 'context' }, { path: 'svc/config', name: 'configfiles' }], 'svc');
  assert.equal(
    block,
    'import (\n\t"context"\n\t"net/http"\n\n\t"golang.org/x/sync/errgroup"\n\n\tconfigfiles "svc/config"\n\t"svc/internal/httpapi"\n)'
  );
  assert.equal(importBlock([{ path: 'fmt' }]), 'import "fmt"');
});

test('un archivo lleva la cabecera de código generado solo si lo escribe build', () => {
  const generated = goFile({ pkg: 'p', body: 'var X = 1' });
  assert.ok(generated.startsWith(`${GENERATED_HEADER}\n\npackage p\n`));
  assert.ok(!goFile({ pkg: 'p', body: 'var X = 1', generated: false }).includes(GENERATED_HEADER));
  // Un doc.go acaba en la cláusula package, sin líneas en blanco detrás (medido con gofmt).
  assert.equal(goFile({ pkg: 'p', doc: 'Package p hace algo.\n\nY más.', body: '' }), `${GENERATED_HEADER}\n\n// Package p hace algo.\n//\n// Y más.\npackage p\n`);
});
