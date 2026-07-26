// Cobertura de una silueta de servicio distinta a la del catálogo.
//
// Las fixtures product-catalog y catalog-extended son el mismo comercio: agregado
// raíz + entidad hija, lifecycle con estados, CRUD y listado paginado por HTTP.
// Un generador ajustado a esa silueta parece correcto hasta que llega un servicio
// con otra forma. metering-digest es la forma contraria en los ejes que importan:
// sin capa api (lo disparan una suscripción y un schedule), sin bloque aggregates,
// sin lifecycle, sin entidades hijas y con decimales de escala declarada.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'metering-digest');
const PROJECT = path.join('services', 'metering-digest-spring');
const JAVA = 'src/main/java/com/utilities/meteringdigest';

function scaffoldMetering() {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-shape-'));
  const result = scaffoldService({ manifest, layers, workspace, force: true });
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

test('sin capa api no se genera superficie HTTP, ni suelta ni referenciada', () => {
  const { exists, javaFiles } = scaffoldMetering();

  // Nada de controllers ni de las piezas que solo sirven a una entrada HTTP.
  assert.ok(!exists(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`));
  assert.ok(!exists(`${JAVA}/infrastructure/rest/ErrorResponse.java`));
  assert.ok(!exists(`${JAVA}/infrastructure/configurations/WebConfig.java`));
  assert.ok(!exists(`${JAVA}/infrastructure/web/JsonValueEnumConverterFactory.java`));
  assert.ok(!exists(`${JAVA}/infrastructure/web/CorrelationFilter.java`));

  const files = javaFiles();
  assert.ok(!files.some((f) => f.name.endsWith('V1Controller.java')));
});

test('ningún archivo importa una clase propia que no se generó', () => {
  // Guarda estructural, no de silueta: un import al propio paquete base que apunta
  // a una clase inexistente no compila, y es el fallo típico al gatear piezas por
  // capa (o al olvidar el import de un tipo de dominio en otro paquete).
  const { javaFiles } = scaffoldMetering();
  const files = javaFiles();
  const generated = new Set(files.map((f) => f.name.replace(/\.java$/, '')));

  const dangling = [];
  for (const file of files) {
    for (const match of file.content.matchAll(/^import com\.utilities\.meteringdigest\.[\w.]*?(\w+);$/gm)) {
      if (!generated.has(match[1])) dangling.push(`${file.name} → ${match[1]}`);
    }
  }

  assert.deepEqual(dangling, []);
});

test('el trigger es el schedule declarado: cron de 6 campos y dispatch por el mediator', () => {
  const { read } = scaffoldMetering();
  const scheduler = read(`${JAVA}/infrastructure/scheduling/DailyDigestScheduler.java`);

  // El diseño declara cron de 5 campos (agnóstico); Spring pide 6.
  assert.ok(scheduler.includes('@Scheduled(cron = "0 0 2 * * *")'));
  assert.ok(scheduler.includes('public void closeDailyDigest()'));
  assert.ok(scheduler.includes('mediator.dispatch(new CloseDailyDigestCommand())'));
  // La descripción del schedule viaja como javadoc del método.
  assert.ok(scheduler.includes('Cada noche a las 02:00'));
});

test('payload de suscripción: wireName y tipos de dominio con su import', () => {
  const { read } = scaffoldMetering();
  const message = read(`${JAVA}/infrastructure/messaging/subscriptions/MeterReadingCapturedMessage.java`);

  assert.ok(message.includes('@JsonProperty("meter_id") UUID meterId'));
  assert.ok(message.includes('@JsonProperty("consumption_kwh") BigDecimal consumptionKwh'));
  // El enum del diseño vive en domain.enums: sin el import el record no compila.
  assert.ok(message.includes('import com.utilities.meteringdigest.domain.enums.ReadingSource;'));
  // Contrato de recepción escrito donde el agente lo va a leer.
  assert.ok(message.includes("el payload cuelga de 'data'"));
  assert.ok(message.includes("Deduplica por header 'messageId'"));
  assert.ok(message.includes('va a la DLQ del broker'));
});

test('sin lifecycle no se genera máquina de estados en ninguna entidad', () => {
  const { javaFiles } = scaffoldMetering();
  const files = javaFiles();

  for (const marker of ['transitionTo', 'InvalidStateTransitionException']) {
    const referrer = files.find((f) => f.content.includes(marker));
    assert.equal(referrer, undefined, `${marker} generado en ${referrer?.name} sin lifecycle declarado`);
  }
});

test('dos raíces independientes: cada una con su lockVersion y sin colección de hijas', () => {
  const { read, javaFiles } = scaffoldMetering();

  for (const entity of ['MeterReading', 'DailyDigest']) {
    const jpa = read(`${JAVA}/infrastructure/persistence/entities/${entity}Jpa.java`);
    assert.ok(jpa.includes('@Version\n    @Column(name = "lock_version")'), `${entity} sin lockVersion`);
    assert.ok(read(`${JAVA}/domain/aggregate/${entity}.java`).includes('public Long getLockVersion() {'));
  }

  // Sin aggregates compuestos no hay relación padre-hija que mapear.
  const referrer = javaFiles().find((f) => f.content.includes('@OneToMany'));
  assert.equal(referrer, undefined, `@OneToMany generado en ${referrer?.name} sin entidades hijas`);
});

test('decimal con scale: BigDecimal con la escala declarada, fuera de un value object', () => {
  const { read } = scaffoldMetering();

  // En catalog la precisión vive dentro del value object Money; aquí es un campo suelto.
  const jpa = read(`${JAVA}/infrastructure/persistence/entities/MeterReadingJpa.java`);
  assert.ok(jpa.includes('@Column(name = "consumption_kwh", nullable = false, precision = 19, scale = 3)'));
  assert.ok(jpa.includes('private BigDecimal consumptionKwh;'));
  assert.ok(read(`${JAVA}/domain/aggregate/MeterReading.java`).includes('private BigDecimal consumptionKwh;'));
  // Cero coma flotante en el camino de una magnitud (constitution.md).
  assert.ok(!jpa.includes('double') && !jpa.includes('Double'));
});
