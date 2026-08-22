// El acceso a la base desde el arnés tiene DOS formas y no son intercambiables:
// `db(String... argv)` (sin shell) y `dbShell(String)` (con `sh -c`). Cuál usa el
// agente de pruebas para su propio helper de fixture lo decide, en la práctica, el
// EJEMPLO que encuentra en el javadoc — y durante dos generaciones seguidas el único
// ejemplo concreto que había era el de `dbShell`, colgado del javadoc de `db`. Las
// dos veces el agente armó su SQL como cadena, las dos veces `podman.exe` reescribió
// las comillas en Windows y se llevó por delante la clase entera desde su `@BeforeAll`
// (`initializationError`, todos los `FL-*` en NO_EJERCITADO), y las dos veces costó un
// ciclo completo de diagnóstico.
//
// Estos tests fijan lo que corrige eso: que cada método lleve el ejemplo de SU forma,
// y que el de `db` traiga una sentencia con comillas —sin comillas, el ejemplo no
// distingue las dos formas, que es exactamente lo que hay que distinguir—.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { generate as generateIntegrationTests } from '../src/scaffold/integration-tests.js';
import { resolveStack } from '../src/scaffold/index.js';
import { DATABASES } from '../src/lib/stack-catalog.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const harnessFor = (database, fixture = 'catalog-extended') => {
  const { manifest, layers } = loadService(path.join(fixturesDir, fixture));
  const stack = resolveStack({ database }, layers, manifest);
  const model = buildModel({ manifest, layers, stack });
  model.stack = stack;
  return generateIntegrationTests(model).find((file) => file.path.endsWith('AbstractFlowIT.java')).content;
};

// El bloque de documentación de un método, desde su `/**` hasta su firma.
const javadocOf = (harness, signature) => {
  const at = harness.indexOf(signature);
  assert.ok(at > 0, `no aparece la firma ${signature}`);
  const open = harness.lastIndexOf('/**', at);
  return harness.slice(open, at);
};

test('el javadoc de db lleva el ejemplo en forma de argv, con la sentencia entrecomillada dentro', () => {
  const harness = harnessFor('postgresql');
  const doc = javadocOf(harness, 'protected static String db(String... argv)');

  // La invocación concreta del motor, como lista y con las credenciales del catálogo.
  assert.match(doc, /<pre>db\("env", "PGPASSWORD=changeme", "psql"/);
  // Y la sentencia como UN elemento más, con sus comillas simples intactas: es lo
  // único que enseña la diferencia con armarla dentro de una cadena para `sh -c`.
  assert.match(doc, /"SELECT id FROM la_tabla WHERE slug = 'ejemplo'"\);<\/pre>/);
  // El ejemplo de `db` no puede ser una llamada a `dbShell`: ese era el defecto.
  assert.ok(!/<pre>dbShell\(/.test(doc), 'el javadoc de db seguía ilustrándose con dbShell');
});

test('el javadoc de dbShell se queda con el sondeo y prohíbe explícitamente el SQL armado', () => {
  const harness = harnessFor('postgresql');
  const doc = javadocOf(harness, 'protected static String dbShell(String command)');

  assert.match(doc, /<pre>dbShell\("PGPASSWORD='changeme' psql -h db -U catalog -d catalog -c 'SELECT 1'/);
  assert.match(doc, /NO se arma como/);
  // Y dice a dónde ir, que es lo que convierte una prohibición en una instrucción.
  assert.match(doc, /\{@link #db\}/);
});

test('el ejemplo sale del catálogo, no de un literal del scaffolding', () => {
  // Misma garantía que broker-probes da a los comandos de broker: una sola
  // definición. Si alguien cambia las credenciales de prueba de un motor, el
  // ejemplo del javadoc tiene que moverse con ellas o enseñaría a conectarse mal.
  const entry = DATABASES.sqlserver;
  const argv = entry.cliQueryArgv({ user: entry.user('catalog'), pass: entry.password, db: 'catalog' });
  assert.ok(argv.includes(entry.password), 'la contraseña del ejemplo no es la del catálogo');

  const harness = harnessFor('sqlserver');
  const doc = javadocOf(harness, 'protected static String db(String... argv)');
  assert.ok(doc.includes(entry.password));
});

test('el ejemplo documental usa el dialecto del motor elegido', () => {
  const doc = javadocOf(harnessFor('mysql'), 'protected static String db(String... argv)');
  // `-p` PEGADO a la contraseña: separado, mysql la pide por terminal y el proceso
  // se cuelga esperando una entrada que en un test no llega nunca.
  assert.match(doc, /"-pchangeme"/);
});

test('con un motor documental el ejemplo es su shell de consulta, no SQL', () => {
  const doc = javadocOf(harnessFor('mongodb', 'inspection-reports'), 'protected static String db(String... argv)');
  assert.match(doc, /"mongosh", "mongodb:\/\//);
  assert.match(doc, /countDocuments/);
  assert.ok(!doc.includes('SELECT id FROM'), 'el ejemplo relacional se coló en la rama documental');
});

test('Oracle declara que no tiene forma argv en vez de inventarse una', () => {
  // sqlplus lee la sentencia por la entrada estándar, y `db(...)` no alimenta stdin.
  // Callarlo dejaría al agente buscando una forma que no existe; decirlo lo manda a
  // `dbShell` con la excepción explicada, que es la respuesta correcta AQUÍ.
  assert.equal(DATABASES.oracle.cliQueryArgv, undefined);
  const doc = javadocOf(harnessFor('oracle'), 'protected static String db(String... argv)');
  assert.match(doc, /entrada estándar/);
  assert.match(doc, /<pre>dbShell\(/);
});

test('los marcadores del ejemplo no llevan <…>: doclint los leería como etiquetas', () => {
  for (const database of ['postgresql', 'mysql', 'sqlserver']) {
    const doc = javadocOf(harnessFor(database), 'protected static String db(String... argv)');
    // Acotado al ejemplo y no «de aquí al final»: el javadoc sigue después con la tabla de
    // valores de enum, y su `<p>` haría saltar esta comprobación sin que el ejemplo tenga nada.
    const start = doc.indexOf('<pre>db(');
    const example = doc.slice(start, doc.indexOf('</pre>', start));
    assert.ok(!/<[a-z_]+>/.test(example.replace(/<\/?(pre|b)>/g, '')), `${database}: marcador con < > en el ejemplo`);
  }
});

// ─── La guarda de JsonPath ───────────────────────────────────────────────────
//
// `$.items[?(@.id=='x')].campo[0]` no falla: MIENTE. Un filtro hace el path indefinido y
// Jayway devuelve siempre una lista (vacía), nunca null y nunca PathNotFoundException, así
// que un `valor != null` montado encima es constantemente cierto. Dentro de un `await(...)`
// eso produce un timeout que parece latencia del servidor cuando el servidor ya había
// convergido — y manda a buscar el defecto donde no está. Costó un ciclo de arbitraje en la
// corrida del 13/08/2026 y contaminó el diagnóstico de un defecto real simultáneo.
//
// La convención ya avisaba de la variante que SÍ falla (destino escalar →
// ClassCastException). Lo que faltaba era cerrar la variante silenciosa, y eso no lo hace un
// documento: lo hace el arnés rechazando el path.

test('el arnés rechaza indexar después de un filtro, que es el fallo que no avisa', () => {
  const harness = harnessFor('postgresql');

  assert.match(harness, /private static void rejectIndexAfterFilter\(String path\)/);
  // La guarda está EN jsonPath, que es por donde pasa todo path crudo: ponerla solo en el
  // helper nuevo dejaría intacto el camino por el que el defecto entró.
  const method = harness.slice(harness.indexOf('protected <T> T jsonPath('));
  assert.ok(method.slice(0, 200).includes('rejectIndexAfterFilter(path)'), method.slice(0, 200));
  // Y el mensaje dice a dónde ir: una prohibición sin alternativa se sortea.
  assert.match(harness, /Usa itemById\(\.\.\.\)/);
});

test('el arnés ofrece la alternativa: filtrar por id y quedarse con el primero en Java', () => {
  const harness = harnessFor('postgresql');

  assert.match(harness, /protected Optional<Map<String, Object>> itemById\(Response response, String collectionPath, String idField, Object idValue\)/);
  // El índice se hace en Java (`findFirst`), no en el path.
  const helper = harness.slice(harness.indexOf('protected Optional<Map<String, Object>> itemById'));
  assert.ok(helper.slice(0, 500).includes('findFirst()'), helper.slice(0, 500));
  // El collectionPath es un parámetro y no una constante: un listado paginado lo trae bajo
  // $.items y una salida de lista es el array raíz.
  assert.match(harness, /\$\.items/);
});

test('la guarda distingue un índice tras filtro de un índice normal', () => {
  // El patrón solo se aplica a lo que va DESPUÉS del filtro: `$.images[0].url` es legítimo
  // y tiene que seguir funcionando. Se comprueba sobre el regex renderizado, que es el que
  // corre en el proyecto.
  const harness = harnessFor('postgresql');
  const line = harness.split('\n').find((l) => l.includes('INDEX_AFTER_FILTER = Pattern.compile('));
  assert.ok(line, harness);
  // El literal Java `"\\[\\s*\\d+\\s*\\]"` describe el regex `\[\s*\d+\s*\]`: se
  // desescapan las barras para ejecutar aquí exactamente el mismo patrón.
  const javaLiteral = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
  const pattern = new RegExp(javaLiteral.split('\\\\').join('\\'));

  const guard = (path) => {
    const filter = path.indexOf('?(');
    return filter >= 0 && pattern.test(path.slice(filter));
  };

  assert.ok(guard("$.items[?(@.id=='x')].awaitingSince[0]"), 'no caza el caso que costó el ciclo');
  assert.ok(guard("$.images[?(@.id=='x')].url[ 0 ]"));
  assert.ok(!guard('$.images[0].url'), 'un índice sin filtro delante es legítimo');
  assert.ok(!guard("$.items[?(@.id=='x')].awaitingSince"), 'el filtro sin índice es la forma correcta');
  assert.ok(!guard('$.id'));
});
