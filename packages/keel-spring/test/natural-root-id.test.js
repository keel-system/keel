// La identidad de una raíz es la que declara el diseño, no `UUID id`.
//
// El puerto, Spring Data, los dos adaptadores y el resolver de referencias escribían `UUID id` y
// `getId()` a mano. En la corrida user-profile (2026-10-01) la lápida `DeletedSubject` —cuyo id es
// el `subject: String` del titular— salió con un puerto `findById(UUID id)` contra un espejo que sí
// mapeaba `String subject`: no compilaba y el agente lo arregló a mano en tres archivos. Ahora los
// cinco leen `rootId()` (src/scaffold/repositories.js). El sujeto es `MeterDecommission` de la
// fixture metering-digest, que existe para esto: `java-syntax` y `compile-check` la recorren.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { planService } from '../src/scaffold/index.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'metering-digest');
const STACK = { database: 'postgresql', broker: 'kafka', cache: null, auth: null, storage: null, telemetry: 'none' };

function render({ document = false } = {}) {
  const { manifest, layers, errors } = loadService(fixture);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  if (document) patched.persistence.default.model = 'document';
  const stack = document ? { ...STACK, database: 'mongodb' } : STACK;
  const { files } = planService({ manifest, layers: patched, workspace: '.', stack });
  const byName = (suffix) => {
    const hit = files.find((f) => f.path.split(/[\/]/).join('/').endsWith(suffix));
    assert.ok(hit, `no se generó ${suffix}`);
    return String(hit.content);
  };
  return byName;
}

test('el puerto de una raíz con id natural lo tipa como el diseño', () => {
  const port = render()('domain/repository/MeterDecommissionRepository.java');
  assert.match(port, /Optional<MeterDecommission> findById\(String serialNumber\);/);
  assert.match(port, /void deleteById\(String serialNumber\);/);
  assert.ok(!/findById\(UUID/.test(port), 'el puerto sigue tipando el id como UUID');
});

test('Spring Data y el adaptador relacional casan con el espejo', () => {
  const read = render();
  assert.match(
    read('MeterDecommissionJpaRepository.java'),
    /extends JpaRepository<MeterDecommissionJpa, String>/
  );
  const adapter = read('MeterDecommissionRepositoryImpl.java');
  assert.match(adapter, /public Optional<MeterDecommission> findById\(String serialNumber\)/);
  assert.match(adapter, /entity\.getSerialNumber\(\) != null/, 'carga la instancia gestionada por un getter que no existe');
  assert.ok(!/entity\.getId\(\)/.test(adapter), 'el adaptador llama a getId() sobre una raíz que no tiene id');
  assert.match(adapter, /public void deleteById\(String serialNumber\)/);
});

test('la rama documental lee la misma fuente', () => {
  const read = render({ document: true });
  assert.match(read('MeterDecommissionMongoRepository.java'), /extends MongoRepository<MeterDecommissionDocument, String>/);
  const adapter = read('MeterDecommissionRepositoryImpl.java');
  assert.match(adapter, /public Optional<MeterDecommission> findById\(String serialNumber\)/);
  assert.match(adapter, /public void deleteById\(String serialNumber\)/);
  assert.ok(!/entity\.getId\(\)/.test(adapter), 'el adaptador documental llama a getId()');
});

test('y una raíz con uuid sigue saliendo como antes', () => {
  // El control: sin él, un arreglo que tipara TODO como String saldría verde.
  const port = render()('domain/repository/DailyDigestRepository.java');
  assert.match(port, /Optional<DailyDigest> findById\(UUID id\);/);
  assert.match(port, /import java\.util\.UUID;/);
});
