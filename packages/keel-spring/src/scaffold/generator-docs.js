// Conocimiento del generador dentro del proyecto: la skill orquestadora (la
// ÚNICA: no se siembra ninguna en el workspace de diseño), los agentes de la
// orquestación y las skills por tecnología del stack elegido, más las docs de
// apoyo. Junto con el snapshot de specs/, hace el repo autosuficiente: quien lo
// clone puede finalizar la generación sin el workspace Keel.
//
// Dos destinos, según la naturaleza de cada pieza:
//
// - Lo que el harness carga —skills, comandos, agentes— se **proyecta** a la
//   convención de cada harness soportado (.claude/, .opencode/) desde una fuente
//   neutral. Se emiten todos: el proyecto sirve para cualquiera de los dos.
// - Lo que solo es markdown que un agente lee por ruta —architecture,
//   constitution, orchestration, conventions— va a `docs/keel/`, **una sola
//   copia**, fuera del directorio de harness: no cambia de forma con la
//   herramienta, y meterlo ahí obligaría a duplicarlo por cada harness nuevo.
//
// Misma regeneración segura que el resto del scaffolding.

import fs from 'node:fs';
import path from 'node:path';
import { HARNESSES, applyTokens, emitHarnessFiles } from 'keel-core';
import { assetsDir, SKILL } from '../lib/assets.js';
import { usesIdempotencyCheck } from './idempotency-check.js';

const generatorDir = path.join(assetsDir, 'generators', 'spring');
const agentsSourceDir = path.join(assetsDir, 'agents');

// Raíz de las docs de apoyo dentro del proyecto generado. Es también el valor del
// token {{keel:docs}} con el que las citan skills, agentes y conventions entre sí.
export const DOCS_DIR = 'docs/keel';

const CONVENTIONS = [
  'mapping.md',
  'project-layout.md',
  'infra-validation.md',
  'integration-tests.md',
  'flow-fidelity.md',
  'domain-modeling.md',
  'domain-services.md',
  'read-composition.md',
  'dependencies.md',
  'concurrency.md',
  'virtual-threads.md'
];

// Docs de primer nivel del generador, junto a conventions/ bajo DOCS_DIR.
const GUIDES = ['architecture.md', 'constitution.md', 'orchestration.md'];

// Subagentes de la orquestación. Son **hojas**: ninguno puede lanzar agentes
// (`spawns: false` en su frontmatter neutral, que cada harness traduce a su
// forma), porque el único orquestador es la skill — ver orchestration.md § Los
// cinco agentes.
export const AGENTS = [
  'keel-spring-code.md',
  'keel-spring-infra.md',
  'keel-spring-tests.md',
  'keel-spring-validate.md',
  'keel-spring-quality.md'
];

// Skills por tecnología aplicables al servicio (mismo mapeo que skills/README.md):
// una por categoría de stack elegida (minio/s3 comparten keel-spring-s3,
// redis/valkey keel-spring-redis, los seis dialectos relacionales
// keel-spring-database y MongoDB keel-spring-mongodb —tuning/validación: el código
// de persistencia lo genera build en ambos—) más las gateadas por presencia de
// capa, no por stack: keel-spring-httpclient acompaña a la capa http-clients
// (integraciones HTTP salientes, no es una elección de stack).
export function stackSkills(model) {
  const { layersPresent, stack } = model;
  const skills = [];
  if (layersPresent.persistence && stack.database) {
    // Los dialectos relacionales comparten skill porque comparten mapeo (JPA) y solo
    // difieren en un reference por dialecto. El modelo documental no comparte nada
    // con ellos: otro mapeo, otros índices, otra transaccionalidad.
    skills.push(model.persistenceKind === 'document' ? 'keel-spring-mongodb' : 'keel-spring-database');
  }
  if (layersPresent.messaging && stack.broker) skills.push(`keel-spring-${stack.broker}`);
  if (layersPresent.storage && stack.storage) skills.push('keel-spring-s3');
  // Gateada por capa, como la de clientes HTTP: el correo no es una elección de
  // stack (no hay proveedor que elegir en build; se decide al desplegar).
  if (layersPresent.mail) skills.push('keel-spring-mail');
  if (layersPresent.httpClients) skills.push('keel-spring-httpclient');
  if (stack.cache) skills.push('keel-spring-redis');
  if (stack.auth && stack.auth !== 'none') skills.push(`keel-spring-${stack.auth}`);
  return skills;
}

export function generate(model) {
  const files = [];

  // Docs de apoyo: una sola copia, agnósticas del harness.
  for (const name of GUIDES) {
    files.push({ path: `${DOCS_DIR}/${name}`, content: docContent(path.join(generatorDir, name)) });
  }
  for (const name of CONVENTIONS) {
    files.push({
      path: `${DOCS_DIR}/conventions/${name}`,
      content: docContent(path.join(generatorDir, 'conventions', name))
    });
  }

  // Y los artefactos que sí carga el harness, proyectados a cada uno de ellos.
  for (const harness of HARNESSES) {
    files.push(...harnessArtifacts(model, harness));
  }

  return files;
}

// Nombres del archivo de contexto de cada harness (CLAUDE.md, AGENTS.md). En
// material compartido son tan mentira como una ruta `.claude/`: el archivo existe
// con OTRO nombre para quien use el otro harness. Y a diferencia de la ruta, aquí
// el token tampoco vale (docContent los rechaza), así que la frase tiene que
// hablar del "archivo de contexto del repo" sin nombrarlo.
const CONTEXT_FILES = new RegExp(`\\b(${HARNESSES.map((h) => h.contextFile.replace('.', '\\.')).join('|')})`, 'g');

/**
 * Las docs de apoyo viven en un único sitio, compartido por todos los harnesses:
 * ahí una ruta `.claude/…` mentiría a quien use el otro. Así que solo se resuelve
 * `{{keel:docs}}` —que sí es común— y cualquier token de harness es un error: esa
 * frase debe nombrar la skill o el agente, no su ruta.
 */
function docContent(sourceFile) {
  const resolved = applyTokens(fs.readFileSync(sourceFile, 'utf8'), { docs: DOCS_DIR });
  const leftover = resolved.match(/\{\{keel:\w+\}\}/g);
  if (leftover) {
    throw new Error(
      `${path.basename(sourceFile)} cita rutas de harness (${[...new Set(leftover)].join(', ')}), ` +
        `pero vive en ${DOCS_DIR}/ y lo leen los dos: nombra la skill o el agente en vez de su ruta.`
    );
  }
  const contextFiles = resolved.match(CONTEXT_FILES);
  if (contextFiles) {
    throw new Error(
      `${path.basename(sourceFile)} nombra el archivo de contexto (${[...new Set(contextFiles)].join(', ')}), ` +
        `pero vive en ${DOCS_DIR}/ y lo leen los dos, donde ese archivo se llama de otra forma: ` +
        'di "el archivo de contexto del repo" sin nombrarlo.'
    );
  }
  return resolved;
}

/** Skill orquestadora + skills por tecnología + agentes, en la convención de un harness. */
function harnessArtifacts(model, harness) {
  const tokens = { ...harness.tokens, docs: DOCS_DIR };
  const files = [];

  // La orquestadora se sintetiza (depende del servicio, del stack y de las capas),
  // así que no pasa por emitHarnessFiles: no hay asset del que proyectarla.
  files.push({ path: harness.skillPath(SKILL, 'SKILL.md'), content: skillMd(model, harness) });
  if (harness.commandPath) {
    files.push({
      path: harness.commandPath(SKILL),
      content: orchestratorCommand(model)
    });
  }

  // Las de tecnología y los agentes sí son assets neutrales. `commands: false`:
  // una skill de tecnología es conocimiento que el agente consulta al tocar el
  // broker o la BD, no algo que nadie invoque con `/`.
  files.push(
    ...emitHarnessFiles({
      harnesses: [harness],
      skills: stackSkills(model).map((name) => path.join(generatorDir, 'skills', name)),
      agents: AGENTS.map((name) => path.join(agentsSourceDir, name)),
      commands: false,
      extraTokens: { docs: DOCS_DIR }
    })
  );

  return files.map((file) => ({ ...file, content: applyTokens(file.content, tokens) }));
}

/** Stub de comando de la orquestadora, para los harnesses que separan comando y skill. */
function orchestratorCommand(model) {
  const description = `Completa la generación de ${model.service.projectName} a partir del diseño Keel de specs/, orquestando los subagentes de código, infraestructura, pruebas de integración, validación funcional y calidad.`;
  return `---\ndescription: ${JSON.stringify(description)}\n---\n\nUsa la skill \`${SKILL}\` y sigue su proceso al pie de la letra, de la fase 0 a la 7. No admite argumentos: el cwd ya es la raíz del proyecto.\n`;
}

// Skill del proyecto: la única del generador, y delgada a propósito. El proceso
// especializado (capas declaradas, stack, verificación) vive en el archivo de
// contexto del repo y el detalle de gating en orchestration.md; aquí el arranque,
// las rutas locales (siempre relativas a esta raíz) y la orquestación de los
// subagentes.
/**
 * Qué añade la fase 3 al pase de calidad según el modelo de persistencia.
 *
 * La asimetría es real, no una diferencia de redacción: en el modelo relacional el
 * baseline hay que REDACTARLO (Hibernate infiere el DDL y nadie sabe qué infirió) y
 * probarlo exige borrar el volumen de la misma base sobre la que corre la
 * no-regresión, así que la prueba en vivo queda pendiente para el diseñador. En el
 * documental los índices los generó build enteros desde el diseño, y verificarlos es
 * una lectura: se ejecuta dentro del pipeline y nunca queda en PENDING.
 */
function qualityTitleSuffix(model) {
  if (!model.layersPresent.persistence) return '';
  return model.persistenceKind === 'document' ? ' + verificación de índices' : ' + baseline de migraciones';
}

/**
 * El gate determinista del tramo que no está garantizado por construcción: build genera
 * los mecanismos de repetición y compensación, y el USO lo escribe el agente de código.
 * Se anuncia aquí porque dos de sus seis familias —reconciliación y entrega del outbox—
 * no tienen ningún escenario `FL-*` detrás, así que este es su único gate.
 */
function qualityIdempotencyGate(model) {
  if (!usesIdempotencyCheck(model)) return '';
  return ' Ese pase incluye `bash infra/check-idempotency.sh`, el gate determinista de la cadena de idempotencia y compensación (`dedupe`, `payloadContract`, `commandIdempotency`, `compensation`, `reconciliation`, `outboxDelivery`, `mailDelivery`): build genera los mecanismos y el agente de código escribe el uso, que es el único tramo que no está garantizado por construcción. Dos de esas familias —**reconciliación** y **entrega del outbox**— no tienen ningún escenario `FL-*` detrás (un cron no se alcanza desde fuera, y el fallback del dispatcher no lanza), así que este es su único gate: si alguna sale `KO`, relánzalo con sus hallazgos exactos.';
}

function qualitySchemaGate(model) {
  if (!model.layersPresent.persistence) return '';
  if (model.persistenceKind === 'document') {
    return ' El mismo agente **verifica los índices** (`bash infra/export-indexes.sh` con la infraestructura arriba, y contraste en los dos sentidos contra `MongoIndexConfig`, `specs/persistence.keel.yaml` y el mapa de constraints del `ApiExceptionHandler`): exige `indexes: OK` **e** `indexesTested: OK`. Aquí no hay baseline que redactar —los índices los generó build enteros desde el diseño— ni `PENDING` que arrastrar: exportarlos solo lee, así que la comprobación se ejecuta de verdad dentro del pipeline y no destruye la base de la no-regresión. `indexes: KO` → relánzalo una vez con su error exacto.';
  }
  return ' El mismo agente produce el **baseline de migraciones** (`db/migration/V1__baseline_schema.sql`, exportado de las entidades ya finales con `infra/export-schema.sh`) y lo verifica con un **doble check estático** —fidelidad al DDL exportado + contraste con las entidades y el diseño—: exige `baseline: OK`, porque sin él el servicio compila y valida pero no es desplegable (en production Hibernate solo valida el esquema). `baseline: KO` → relánzalo una vez con su error exacto. El agente **no** lo prueba contra la BD (arrancar con `PROFILE=local,migrations` exige borrar el volumen, y eso destruiría la base de la no-regresión): devuelve `baselineTested: PENDING` y esa prueba en vivo la hace el diseñador. Arrástralo al resumen final del paso 7 — es alcance que el pipeline no cubre, no un fallo.';
}

function skillMd(model, harness) {
  const { service } = model;
  const techSkills = stackSkills(model);
  const techSkillsBullet = techSkills.length
    ? `\n- Skills por tecnología (\`{{keel:skills}}\`, hermanas de esta) — guía de implementación, instaladas solo las aplicables a este servicio (del stack de \`keel-stack.json\` y de las capas de diseño presentes): ${techSkills.map((s) => `\`${s}\``).join(', ')}. Cada una trae \`references/\` (configuración, implementación, troubleshooting) que se leen bajo demanda según la tabla de su SKILL.md.`
    : '';
  return `---
name: ${SKILL}
description: Completa la generación de este microservicio Spring Boot a partir del diseño Keel incluido en specs/, orquestando los subagentes de código, infraestructura, pruebas de integración, validación funcional y calidad. Usar dentro de este proyecto, sin argumentos.
---

# /${SKILL} — completar ${service.projectName}

Este proyecto fue generado por \`keel-spring build\` desde \`specs/${service.name}\` v${service.version} y es **autosuficiente**: todo lo necesario para finalizar la generación está en este repo. Se invoca **sin argumentos, con el cwd en esta raíz**; todas las rutas de abajo son relativas a ella. Tú eres el **orquestador**: el trabajo lo hacen los subagentes de \`{{keel:agents}}\`.

## Proceso

0. **Precondiciones.** \`specs/\` es un snapshot del diseño que \`keel-spring build\` ya validó (schemas, referencias cruzadas y frontera del generador) y que refresca en cada build: no lo revalides ni lo edites — el canónico es \`specs/${service.name}/\` del workspace de diseño, y un cambio funcional se hace allí y se re-ejecuta \`keel-spring build specs/${service.name}\`. Comprueba solo dos cosas antes de arrancar: que existe \`specs/validation-scenarios.md\` (sin escenarios no hay contra qué validar el servidor: detente y pide cerrar el diseño con \`/keel-design\`) y que esta raíz es un repo git (si no, \`git init -b main\`). El stack ya lo eligió el diseñador y está en \`keel-stack.json\`: respétalo; para cambiarlo hay que borrarlo y re-ejecutar \`keel-spring build --force\` en el workspace. Solo pregunta al usuario decisiones que el scaffolding no cubre, y regístralas en el \`README.md\`.
1. **Fase 1 — en paralelo** (los tres subagentes lanzados a la vez, en un único mensaje):
   - \`keel-spring-code\`: «Completa el proyecto en \`.\` (esta raíz). Tu proceso, tu alcance y tu criterio de terminado son los de tu archivo de agente; \`{{keel:context}}\` es el contexto del repo (diseño, stack, orden de las capas), no tu lista de tareas.» — TODOs, lógica de negocio y adaptadores del stack hasta \`./gradlew build -x test\` en verde. **Sin pruebas unitarias**: no las escribe ni las ejecuta.
   - \`keel-spring-infra\`: «Levanta y valida la infraestructura de \`.\` (\`infra/docker-compose.yaml\`). Déjala arriba y reporta.»
   - \`keel-spring-tests\`: «Traduce los escenarios \`FL-*\` de \`specs/validation-scenarios.md\` a pruebas de integración en \`src/integrationTest/\` de \`.\`.» — una clase por flujo, en caja negra y **sin leer \`src/main/java\`**, hasta \`./gradlew compileIntegrationTestJava\` en verde.

   Los tres arrancan a la vez porque todos sus insumos ya están en disco: no hay arista entre ellos. Que el autor de las pruebas **nunca vea el código terminado** es justo lo que impide que un test se acomode a lo que el código hace en vez de a lo que el \`Then\` dice; y el source set las compila sin \`src/main/java\`, así que el paralelismo es real. **Espera a los tres sin hacer nada más**: hasta que los tres hayan reportado no ejecutes ninguna herramienta sobre el proyecto —ni Gradle, ni \`compose\`, ni ediciones, ni lecturas de \`build/\`—; tu único trabajo mientras corren es esperar y decidir el gating. Cada agente cierra su reporte con un bloque estructurado (\`status\`, \`blockers\`, \`failures\`…): el gating se decide sobre esos campos. Sin docker/podman (\`infra status: PENDIENTE\`) → **detente**: sin infraestructura no hay validación end-to-end y, al no haber suite unitaria, la generación queda sin red de seguridad; reporta el código como compilado pero NO validado e indica cómo levantar la infraestructura. Infra KO corregible → relanza \`keel-spring-infra\` una vez con el diagnóstico. \`code\` con \`compiles: false\` → relanza \`keel-spring-code\` pasándole sus \`failures\` (máx. 2 ciclos). \`tests\` en KO **por causa propia** → relánzalo; si su KO viene de \`src/main/java\` o de contención de locks de Gradle, no es suyo: se reevalúa al cerrar el gate de \`code\`. \`blockers\` no vacío en cualquiera → detente y repórtalo al usuario.
2. **Fase 2a — puntuación mecánica (la haces tú, sin agente).** Solo con los tres en OK: ejecuta \`bash infra/score-scenarios.sh\`. El script arranca por el **humo del arnés** (\`--tests '*HarnessSmokeIT'\`, unos segundos: reset, servidor, credenciales, lectura y purga de los canales, caché) y solo con él en verde ejecuta \`./gradlew integrationTest\` (la app la arranca JUnit contra la infra real; el reset por flujo lo hace cada clase en su \`@BeforeAll\`) y compone la matriz \`FL-* → OK | FALLO | NO_EJERCITADO\` desde el XML de JUnit. Eso es parseo, no criterio: no necesita agente y la matriz sale determinista. Toda la salida de Gradle queda en \`build/keel-scenarios/run.log\`; por stdout solo llega la matriz — no vuelques ese log en tu contexto salvo que lo necesites para diagnosticar, porque tú sobrevives todo el pipeline. Según el **código de salida**: \`3\` → **el entorno está bloqueado, no hay nada que arreglar ni nadie a quien relanzar**: un Gradle de una corrida anterior sigue vivo sosteniendo el lock de \`build/\` (típicamente porque la lanzaste en segundo plano y tu herramienta la mató a mitad — el proceso sobrevive a ese \`killed\`). Párala (\`./gradlew --stop\`, y \`jps -l | grep -i gradle\` para los workers, que no siempre caen con eso) y vuelve a lanzar el script tal cual; no consume cupo. El script te lo dice con esas palabras, y **por eso no lo lances en segundo plano con un timeout corto**; \`2\` → el arnés está roto y la suite **no** se ejecutó: relanza \`keel-spring-tests\` (no consume cupo, y exígele verificación amplia + \`harnessPatches\`); \`0\` → matriz al 100%, **salta directo a la fase 3 sin invocar a nadie**; \`1\` → hay algo que arbitrar, ve a la fase 2b.
3. **Fase 2b — arbitraje (el gate de la generación: exige el 100% de los escenarios en OK).** Lanza \`keel-spring-validate\` pasándole la matriz y, por cada fallo, su \`class\` y la ruta de su volcado en \`build/keel-failures/\`, y **espera su reporte sin ejecutar nada** (lánzalo en modo síncrono, o no vuelvas a llamar a ninguna herramienta hasta que llegue): una pasada tuya de \`score-scenarios.sh\` mientras él arbitra le borra los volcados que vino a leer. Lo mismo con cada agente que relances abajo. **No ejecuta la suite ni recompone la matriz** (una pasada nueva sobrescribe los volcados): solo decide de quién es la culpa de cada fallo, contra el \`Then\` original. Eso es lo único que no se puede mecanizar, y está fuera de \`keel-spring-code\` a propósito: quien debe poner la suite en verde no puede ser quien decide si la prueba que no pasa está mal. El veredicto \`culprit\` decide a quién relanzar: \`code\` → relanza \`keel-spring-code\` con **exactamente** sus \`failures\` (con el campo \`evidence\`: el agente abre el JSON crudo, no el extracto, y antes de ejecutar nada); \`test\` → relanza \`keel-spring-tests\` (corrige la prueba, no el servicio); \`harness\` (el mismo síntoma de fontanería en clases independientes) → relanza \`keel-spring-tests\` exigiéndole verificación amplia (todas las clases que usan el método corregido, no dos de muestra) y el bloque \`harnessPatches\`, que es lo que devuelve el defecto al generador; \`design\` → detente y propón el cambio a los artefactos, nunca acomodes el código en silencio. El agente relanzado cierra verificando su fix con \`./gradlew integrationTest --tests '<ClaseAfectada>'\`, pero **ese verde no aprueba el escenario**: tras cualquier ciclo de fix se vuelve siempre a \`bash infra/score-scenarios.sh\` con la suite completa —única que ve una regresión en otro flujo y la única de la que sale la matriz—, nunca directamente a la fase 3. Si la tanda mezcla \`culprit: code\` con \`culprit: test\`/\`harness\`, relánzalos **en serie** (primero \`code\`): ambos ejecutan Gradle sobre este directorio y \`resetState()\` vacía la misma base de datos, así que en paralelo se estorban. **Cómo contar los ciclos**: el cupo cuenta solo los ciclos código→re-puntuación por fallos puntuales (\`blocking: scoped\`) y **escala con el número de flujos \`FL-*\`** del diseño — hasta 10 flujos, 2 ciclos (tope duro 4); de 11 a 20, 3 (tope 5); más de 20, 4 (tope 6). No consumen cupo ni los ciclos que cerraron un **bloqueo sistémico** (\`blocking: systemic\`: una causa transversal —seguridad, arranque, infraestructura— que impedía ejercitar prácticamente cualquier escenario, y destrabarla es lo que hace visibles por primera vez los fallos finos) ni los \`culprit: test\` o \`culprit: harness\`, que no dicen nada sobre el código. Alcanzado el tope que aplique, reporta la matriz y detente. Si hubo \`harnessPatches\`, inclúyelos en el resumen final: son defectos del generador, no de este proyecto. Detalle completo en \`{{keel:docs}}/orchestration.md\`.
4. **Fase 3 — calidad${qualityTitleSuffix(model)}.** Solo con **todos** los escenarios OK: lanza \`keel-spring-quality\` sobre la raíz \`.\` y **espera su reporte sin tocar el proyecto** (él está ejecutando \`build\`, \`integrationTest\` y \`test\` sobre este mismo directorio: cualquier Gradle tuyo en paralelo choca con su lock y con su base de datos). Aplica solo cambios no-conductuales y cierra con \`./gradlew build -x test\` en verde **y \`./gradlew integrationTest\` al 100%** — la no-regresión la comprueba él mismo, ya no hace falta un nodo de re-validación; si reporta \`status: KO\` o \`scenarios: KO\`, revierte/reporta — nunca hagas commit con la compilación en rojo o un escenario fallando.${qualitySchemaGate(model)}${qualityIdempotencyGate(model)} Consolida sus \`remaining\` en el resumen. Al terminar, baja la infraestructura (\`docker compose -f infra/docker-compose.yaml down\`, o \`podman compose\`). \`deploy/\` no se toca en ninguna fase: es el servicio empaquetado para que **el diseñador** lo pruebe a mano cuando quiera.
5. **Guía de despliegue productivo.** Con los escenarios en 100% OK tras el pase de calidad y **antes** del commit, completa la sección \`## Despliegue en producción\` del \`README.md\` para que enumere todos los pasos y todos los parámetros necesarios para levantar el servidor en producción. El scaffolding dejó un baseline (pasos + tabla de parámetros obligatorios); tu trabajo es reconciliarlo con lo que los agentes realmente cablearon: si al implementar los adaptadores del stack (publishers/listeners del broker, adaptador de storage, auth saliente de los clientes HTTP) aparecieron parámetros nuevos, añádelos. Fuente de verdad: \`src/main/resources/parameters/production/*.yaml\` (todo \`\${VAR}\` sin default es obligatorio) + \`keel-stack.json\` + el código final. No inventes parámetros: si un \`\${VAR}\` no aparece en \`parameters/production/\`, no va en la guía.
6. **Informe de generación.** Antes del commit, escribe \`INFORME-GENERACION.md\` en esta raíz: lo que apareció durante la generación y **no es de este proyecto**, sino del generador. Fuentes, todas de los bloques estructurados que ya recibiste: \`harnessPatches\` (parches al andamiaje), los \`failures\` con \`culprit: harness\`, los \`probes[].verdict: FALSO-NEGATIVO\` de infraestructura y los \`designGaps\` consolidados de los cinco agentes. Estructura y regla de oro —cada entrada dice de quién es— en \`{{keel:docs}}/orchestration.md\` § El cierre devuelve al generador lo que es del generador. Si no hubo nada que reportar, dilo en una línea y no inventes hallazgos: un informe vacío es un buen resultado.
7. **Cerrar.** Commit (\`Generado desde specs/${service.name} v${service.version}\`) y resumen: decisiones, matriz escenario → resultado, estado de cada agente, ajustes de calidad aplicados/pendientes y huecos del diseño detectados (\`designGaps\` consolidados).

## Conocimiento local

\`{{keel:context}}\` contiene el contexto completo (fuente de verdad del diseño, stack elegido, orden capa por capa y verificación); los agentes lo consumen. \`{{keel:docs}}/\` aporta el apoyo:

- \`{{keel:docs}}/orchestration.md\` — el pipeline completo: fases, diagrama, responsabilidades y límites de cada agente, tabla de handoffs y reglas de conteo de ciclos. Consúltalo ante cualquier duda de gating.
- \`{{keel:docs}}/architecture.md\` — arquitectura hexagonal + CQRS y función de cada paquete. Léelo antes de tocar código si no conoces ya la estructura.
- \`{{keel:docs}}/constitution.md\` — reglas inviolables (frontera hexagonal, transaccionalidad, contratos públicos, precisión numérica). Ninguna implementación puede romperlas.
- \`specs/\` (raíz del proyecto) — snapshot del diseño Keel (manifiesto + un artefacto por capa + \`validation-scenarios.md\`), refrescado en cada \`keel-spring build\`. El canónico es \`specs/${service.name}/\` del workspace de diseño: los cambios funcionales se hacen allí y se re-ejecuta el build, nunca se editan aquí.
- \`{{keel:docs}}/conventions/\` — mapeo DSL → código (\`mapping.md\`, síguelo estrictamente), estructura del proyecto (\`project-layout.md\`), sondeo y reset de infraestructura (\`infra-validation.md\`), traducción de los escenarios \`FL-*\` a pruebas de integración (\`integration-tests.md\`), auditoría de fidelidad al flujo (\`flow-fidelity.md\`), modelado del dominio (\`domain-modeling.md\`: agregados ricos, invariantes y reparto de la validación) y guías de handler (\`domain-services.md\`, \`virtual-threads.md\`).${techSkillsBullet}

**Un solo actor sobre el proyecto, en todo momento.** Mientras un subagente esté vivo, tú no ejecutas herramientas sobre este directorio: no ejecutes Gradle, no toques \`infra/\`, no edites ni leas \`build/\`. No es cortesía, es corrección — \`infra/score-scenarios.sh\` sobrescribe \`build/keel-failures/\` (la evidencia que el árbitro está leyendo), Gradle bloquea el directorio y \`resetState()\` vacía la misma base de datos que la suite del agente está usando; es la razón por la que \`code\` y \`tests\` se relanzan en serie, y te incluye a ti. Y el trabajo de un agente **no lo haces tú aunque sepas hacerlo**: las restricciones que hacen válida esta generación —el de pruebas sin leer \`src/main/java\`, el árbitro sin corregir código, el de calidad sin cambiar comportamiento— son del agente, no del proceso; hechas desde aquí no rigen ninguna. Tu único trabajo propio es la fase 2a (donde no hay ningún agente corriendo) y los pasos 5 a 7.

Reglas inviolables completas en \`{{keel:docs}}/constitution.md\`; en corto: el diseño es la única fuente de verdad funcional, los \`code\` de error y nombres de evento se copian exactos, todo importe o magnitud científica se opera con \`BigDecimal\` con escala y redondeo explícitos (nunca \`double\`/\`float\`; comparaciones con \`compareTo\`), y ante ambigüedad, diseño > conventions > tu criterio (documentado en el README). No des la generación por terminada con la compilación en rojo o algún escenario fallando. Las pruebas **unitarias** no forman parte de este flujo: son un proceso independiente y posterior a la validación del diseñador. Las de **integración** sí: los escenarios \`FL-*\` viven en \`src/integrationTest/\` y son el gate.
`;
}
