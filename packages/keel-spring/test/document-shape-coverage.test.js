// Segunda silueta sobre el renderizador documental.
//
// document-persistence.test.js lo ejercita con inspection-reports, que es la forma
// «rica»: api, agregado con dos niveles de hijas, value objects anidados, outbox.
// Un renderizador ajustado a esa forma parece correcto hasta que llega un servicio
// con otra. metering-digest es la contraria en los ejes que importan —sin capa api,
// sin bloque aggregates, sin lifecycle, sin entidades hijas—, y aquí se pasa por el
// motor documental sin tocar la fixture: dos siluetas × un renderizador, que es la
// misma lógica con la que existe shape-coverage.test.js para la rama relacional.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'metering-digest');
const PROJECT = path.join('services', 'metering-digest-spring');
const JAVA = 'src/main/java/com/utilities/meteringdigest';
const DOCS = `${JAVA}/infrastructure/persistence/documents`;

function scaffoldMeteringAsDocument() {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-document-shape-');
  // El stack se pasa a mano: la fixture declara `model: relational`, y lo que se
  // ejercita aquí es el renderizador, no el gate del cuestionario (que ya cubre
  // stack.test.js). Es el mismo recurso que usa shape-coverage.test.js con H2.
  const result = scaffoldService({
    manifest,
    layers,
    workspace,
    force: true,
    stack: { group: 'com.utilities', database: 'mongodb' }
  });
  const root = path.join(workspace, PROJECT);
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  const exists = (relative) => fs.existsSync(path.join(root, relative));
  const javaFiles = () => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    return walk(path.join(root, 'src/main/java')).map((file) => ({
      name: path.basename(file),
      content: fs.readFileSync(file, 'utf8')
    }));
  };
  return { result, read, exists, javaFiles };
}

test('sin aggregates ni entidades hijas, cada entidad es su propia colección', () => {
  const { read, javaFiles } = scaffoldMeteringAsDocument();

  // Sin bloque `aggregates`, toda entidad es raíz: todas llevan @Document y ninguna
  // va anidada. Es el caso que un renderizador escrito solo contra la fixture rica
  // podría no cubrir (allí siempre hay una hija sin @Document).
  const documents = javaFiles().filter((f) => f.name.endsWith('Document.java'));
  assert.ok(documents.length > 0);
  for (const doc of documents) {
    assert.ok(doc.content.includes('@Document(collection = '), `${doc.name}: falta @Document`);
    assert.ok(!doc.content.includes('List<') || !/Document>\s+\w+ =/.test(doc.content), `${doc.name}: no debería anidar entidades`);
  }

  // Y la escala declarada del decimal sigue llegando al tipo nativo del motor.
  const meter = read(`${DOCS}/MeterReadingDocument.java`);
  assert.ok(meter.includes('targetType = FieldType.DECIMAL128'));
});

test('sin capa api no hay superficie HTTP que traducir, tampoco en la rama documental', () => {
  const { exists } = scaffoldMeteringAsDocument();
  // El handler de unicidad y el de concurrencia viven en el @RestControllerAdvice:
  // sin api no hay ninguno, así que el contrato de nombres de índice no tiene a
  // quién servir — y el gate por capa tiene que seguir mandando sobre el de motor.
  assert.ok(!exists(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`));
  // Los índices sí se crean: no dependen de que haya API.
  assert.ok(exists(`${JAVA}/infrastructure/persistence/config/MongoIndexConfig.java`));
});

test('ningún archivo generado toca JPA ni deja un import colgando', () => {
  const { javaFiles } = scaffoldMeteringAsDocument();
  const files = javaFiles();

  assert.deepEqual(
    files.filter((f) => /jakarta\.persistence|org\.hibernate/.test(f.content)).map((f) => f.name),
    []
  );

  const generated = new Set(files.map((f) => f.name.replace(/\.java$/, '')));
  const dangling = [];
  for (const file of files) {
    for (const match of file.content.matchAll(/^import com\.utilities\.meteringdigest\.[\w.]*?(\w+);$/gm)) {
      if (!generated.has(match[1])) dangling.push(`${file.name} → ${match[1]}`);
    }
  }
  assert.deepEqual(dangling, []);
});
