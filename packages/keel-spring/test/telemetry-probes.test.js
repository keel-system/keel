// El vocabulario de la telemetría es fuente ÚNICA, y esto es lo que lo hace comprobable.
//
// De `src/lib/telemetry-probes.js` salen los nombres de observación, los atributos, la ruta del
// scrape, los interruptores y la forma de las series. Los consumen el scaffolding (que emite el
// Java y el YAML), el generador del panel (que escribe las consultas) y el runner (que afirma).
// Un literal suelto en cualquiera de los tres rompe la propiedad que da valor a todo esto: que el
// panel y el servidor no puedan tener dos vocabularios.
//
// Y la otra mitad: los casos del runner se cruzan con el XML de JUnit por su ID, así que el id y
// el `@DisplayName` tienen que salir del mismo sitio. Con dos listas, un caso renombrado
// desaparece de la matriz sin que nada se ponga rojo — el runner informaría de menos casos y
// seguiría saliendo en verde.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CASES,
  DOUBLES_CLASS,
  METRICS_TRANSPORT,
  OBSERVATIONS,
  PROBE_CLASS,
  SWITCH_CLASS,
  doublesClass,
  probeClass,
  promMetric,
  switchClass
} from '../src/lib/telemetry-probes.js';

const packageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBES = path.join('src', 'lib', 'telemetry-probes.js');

function sources(dir, found = []) {
  for (const entry of fs.readdirSync(path.join(packageDir, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(rel, found);
    else if (entry.name.endsWith('.js') && rel !== PROBES) found.push(rel);
  }
  return found;
}

test('ningún literal del vocabulario vive fuera del módulo de sondas', () => {
  const literales = [
    METRICS_TRANSPORT.scrapePath,
    promMetric(OBSERVATIONS.useCase).count,
    promMetric(OBSERVATIONS.storage).bucket,
    OBSERVATIONS.storage,
    OBSERVATIONS.mailSend
  ];
  const archivos = [...sources('src'), ...sources('scripts')];
  for (const archivo of archivos) {
    const contenido = fs.readFileSync(path.join(packageDir, archivo), 'utf8');
    for (const literal of literales) {
      // Se permite NOMBRARLO en un comentario (los javadoc del Java generado lo citan); lo que se
      // prohíbe es construir con él, que es lo que se desincroniza en silencio.
      const enCodigo = contenido
        .split('\n')
        .filter((linea) => !linea.trimStart().startsWith('//') && !linea.trimStart().startsWith('*'))
        .join('\n');
      assert.ok(
        !enCodigo.includes(literal),
        `${archivo} escribe '${literal}' a mano: tiene que salir de src/lib/telemetry-probes.js`
      );
    }
  }
});

test('cada caso del runner tiene id único y su método está en la clase que lo declara', () => {
  const ids = CASES.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'hay ids repetidos');
  const metodos = CASES.map((item) => item.method);
  assert.equal(new Set(metodos).size, metodos.length, 'hay métodos repetidos');

  const spec = {
    basePackage: 'com.ejemplo.servicio',
    appClass: 'ServicioApplication',
    commandFqn: 'com.ejemplo.servicio.application.commands.HacerAlgoCommand',
    subsystems: ['storage', 'mail', 'cache'],
    storageBucket: 'assetBinaries',
    mailFrom: 'de@keel.test',
    mailTo: 'para@keel.test',
    mailAttachments: false,
    cacheConstantRef: 'com.ejemplo.servicio.infrastructure.configurations.cache.CacheConfig.LISTAR_CACHE',
    doublesClass: DOUBLES_CLASS,
    imports: ['com.ejemplo.servicio.domain.storage.FileStorage'],
    fields: '\n\n    @Autowired\n    private FileStorage fileStorage;',
    hasPrivateBucket: true,
    hasPublicBucket: true
  };
  const probe = probeClass(spec);
  const switched = switchClass(spec);

  for (const item of CASES) {
    const clase = item.method === 'switchedOff' ? switched : probe;
    assert.ok(clase.includes(`void ${item.method}()`), `${item.id}: falta el método ${item.method}`);
    // El @DisplayName EMPIEZA por el id porque es por ahí por donde el runner cruza el XML.
    assert.ok(clase.includes(`@DisplayName("${item.id} ·`), `${item.id}: su @DisplayName no empieza por el id`);
  }
  assert.ok(probe.includes(`class ${PROBE_CLASS}`));
  assert.ok(switched.includes(`class ${SWITCH_CLASS}`));
});

test('la sonda no puede medir un no-op: exige observabilidad y la exposición OpenMetrics', () => {
  const spec = {
    basePackage: 'com.ejemplo.servicio',
    appClass: 'ServicioApplication',
    commandFqn: 'com.ejemplo.servicio.application.commands.HacerAlgoCommand',
    subsystems: [],
    imports: [],
    fields: ''
  };
  const probe = probeClass(spec);
  // Boot APAGA la observabilidad en los @SpringBootTest: sin esto se mediría un registro no-op,
  // que nunca falla.
  assert.ok(probe.includes('@AutoConfigureObservability'));
  // Y el exemplar viaja SOLO en OpenMetrics: con el Accept por defecto la respuesta trae las mismas
  // series y ni un exemplar, así que la sonda concluiría que no se emiten.
  assert.ok(probe.includes('application/openmetrics-text'));
  // El muestreo al 100 %: un exemplar solo se emite si la traza está muestreada.
  assert.ok(probe.includes('management.tracing.sampling.probability=1.0'));
});

test('el doble del puerto de almacenamiento sale del DISEÑO y no puede ser final', () => {
  const base = { basePackage: 'com.ejemplo.servicio' };
  const completo = doublesClass({ ...base, hasPrivateBucket: true, hasPublicBucket: true });
  assert.ok(completo.includes('public byte[] download('));
  assert.ok(completo.includes('public String publicUrl('));
  assert.ok(completo.includes('public String signedUrl('));

  const minimo = doublesClass({ ...base, hasPrivateBucket: false, hasPublicBucket: false });
  assert.ok(!minimo.includes('download('), 'sin buckets privados el puerto no declara download');
  assert.ok(!minimo.includes('publicUrl('), 'sin buckets públicos el puerto no declara publicUrl');
  assert.ok(!minimo.includes('signedUrl('));
  assert.ok(minimo.includes('public StoredObject upload('));
  assert.ok(minimo.includes('void delete('));

  // Con el aspecto puesto, Spring proxya este bean por CGLIB: una clase `final` deja el contexto
  // sin arrancar, con un mensaje que habla de CGLIB y no de telemetría.
  assert.ok(!/static final class InMemoryFileStorage/.test(minimo));
});
