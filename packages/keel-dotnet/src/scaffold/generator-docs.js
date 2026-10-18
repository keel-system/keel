// Conocimiento del generador dentro del proyecto: la skill orquestadora `keel-generate-dotnet` (la ÚNICA del flujo:
// no se siembra ninguna en el workspace de diseño), los cinco agentes de la orquestación, las skills por tecnología
// del stack y las docs de apoyo. Junto con el snapshot de specs/, hace el repo autosuficiente: quien lo clone puede
// completar la generación sin el workspace.
//
// Dos destinos, igual que en keel-spring y keel-nest:
//   · lo que el harness CARGA —skills, agentes, el archivo de contexto— se PROYECTA a la convención de cada harness
//     soportado (HARNESSES de keel-core) desde una fuente neutral;
//   · lo que solo es markdown que un agente lee por ruta —architecture, constitution, orchestration, conventions— va
//     a `docs/keel/`, UNA sola copia, y no puede citar rutas de harness.

import { usesKafka, usesRabbitMq, usesSnsSqs } from './messaging.js';
import { usesIdempotencyCheck } from './idempotency-check.js';
import { usesHttpClients } from './http-clients.js';
import { usesMail } from './mail.js';
import { usesCache } from './cache.js';
import { usesStorageAdapter } from './storage.js';
import fs from 'node:fs';
import path from 'node:path';
import { HARNESSES, applyTokens, emitHarnessFiles } from 'keel-core';
import { contractDocs } from 'keel-core/gen/contract-docs';
import { describeStack } from 'keel-core/gen/stack';
import { assetsDir, SKILL, TARGET_FRAMEWORK } from '../lib/assets.js';
import { solution } from './render.js';
import { usesRelational, usesDocument } from './persistence.js';
import { usesJwt } from './security.js';
import { usesSchemaBaseline, baselineCommand } from './schema-baseline.js';
import { HARNESS_SMOKE_CLASS } from './integration-tests.js';
import { usesTelemetry } from 'keel-core/gen/telemetry-vocabulary';

const generatorDir = path.join(assetsDir, 'generators', 'dotnet');
const agentsSourceDir = path.join(assetsDir, 'agents');

/** Raíz de las docs de apoyo en el proyecto generado; es también el valor del token {{keel:docs}}. */
export const DOCS_DIR = 'docs/keel';

/** Docs de primer nivel del generador, junto a conventions/ bajo DOCS_DIR. */
export const GUIDES = ['architecture.md', 'constitution.md', 'orchestration.md'];

/** Las convenciones: el único punto de instalación (un archivo nuevo de conventions/ va aquí). */
export const CONVENTIONS = ['mapping.md', 'project-layout.md', 'domain-modeling.md', 'flow-fidelity.md', 'integration-tests.md', 'infra-validation.md'];

/** Las que solo aplican con una elección del stack: la de observabilidad, con telemetría. */
export const CONDITIONAL_CONVENTIONS = { 'observability.md': (model) => usesTelemetry(model) };

/** Los subagentes de la orquestación. Son HOJAS (`spawns: false`): el único orquestador es la skill. */
export const AGENTS = ['keel-dotnet-code.md', 'keel-dotnet-infra.md', 'keel-dotnet-tests.md', 'keel-dotnet-validate.md', 'keel-dotnet-quality.md'];

/** Skills por tecnología aplicables al servicio: la de la base (relacional o documental), la del proveedor de identidad y la del broker. */
export function stackSkills(model) {
  const skills = usesRelational(model) ? ['keel-dotnet-database'] : usesDocument(model) ? ['keel-dotnet-mongodb'] : [];
  if (usesJwt(model) && ['keycloak', 'cognito'].includes(model.stack?.auth)) skills.push(`keel-dotnet-${model.stack.auth}`);
  if (usesRabbitMq(model)) skills.push('keel-dotnet-rabbitmq');
  if (usesKafka(model)) skills.push('keel-dotnet-kafka');
  if (usesSnsSqs(model)) skills.push('keel-dotnet-snssqs');
  // Los clientes salientes (incremento 11): la llamada, los rechazos, el barrido de reconciliación y el proveedor de prueba.
  if (usesHttpClients(model)) skills.push('keel-dotnet-httpclient');
  // El correo saliente (capa mail, adelantada al 12e): lo que build genera, la guarda del doble envío y el buzón.
  if (usesMail(model)) skills.push('keel-dotnet-mail');
  // Los cobros (capa payments): la skill neutra y la de la pasarela elegida, solo esa.
  if (model.payments) skills.push('keel-dotnet-payments', `keel-dotnet-${model.payments.gateway.id}`);
  // La caché de lectura (13f): la skill de su store; Redis y Valkey hablan el mismo protocolo y comparten skill, como en
  // keel-spring y keel-nest.
  if (usesCache(model) && ['redis', 'valkey'].includes(model.stack?.cache)) skills.push('keel-dotnet-redis');
  // El almacenamiento de binarios (13g): MinIO y S3 hablan el mismo protocolo y comparten skill, como en keel-spring y
  // keel-nest. El adaptador lo escribe el agente.
  if (usesStorageAdapter(model)) skills.push('keel-dotnet-s3');
  return skills;
}

export function generate(model) {
  const files = [];
  for (const name of GUIDES) files.push({ path: `${DOCS_DIR}/${name}`, content: docContent(path.join(generatorDir, name)) });
  for (const name of [...CONVENTIONS, ...Object.keys(CONDITIONAL_CONVENTIONS).filter((name) => CONDITIONAL_CONVENTIONS[name](model))]) {
    files.push({ path: `${DOCS_DIR}/conventions/${name}`, content: docContent(path.join(generatorDir, 'conventions', name)) });
  }
  // Los documentos de contrato del método, los mismos que instalan keel-spring y keel-nest (keel-core/gen/contract-docs.js).
  for (const doc of contractDocs()) files.push({ path: `${DOCS_DIR}/${doc.name}`, content: doc.content });
  for (const harness of HARNESSES) files.push(...harnessArtifacts(model, harness));
  return files;
}

// El archivo de contexto de cada harness tiene otro nombre en el otro: en material compartido sería tan mentira
// como una ruta `.claude/`.
const CONTEXT_FILES = new RegExp(`\\b(${HARNESSES.map((h) => h.contextFile.replace('.', '\\.')).join('|')})`, 'g');

/**
 * Las docs viven en un único sitio, compartido por todos los harnesses: solo se resuelve `{{keel:docs}}`, y
 * cualquier token de harness o nombre de archivo de contexto es un error de la fuente — esa frase tiene que nombrar
 * la skill o el agente, no su ruta.
 */
export function docContent(sourceFile) {
  const resolved = applyTokens(fs.readFileSync(sourceFile, 'utf8'), { docs: DOCS_DIR });
  const leftover = resolved.match(/\{\{keel:\w+\}\}/g);
  if (leftover) {
    throw new Error(`${path.basename(sourceFile)} cita rutas de harness (${[...new Set(leftover)].join(', ')}), pero vive en ${DOCS_DIR}/ y lo leen todos.`);
  }
  const contextFiles = resolved.match(CONTEXT_FILES);
  if (contextFiles) {
    throw new Error(`${path.basename(sourceFile)} nombra el archivo de contexto (${[...new Set(contextFiles)].join(', ')}), que en otro harness se llama de otra forma.`);
  }
  return resolved;
}

/** Contexto del repo + skill orquestadora + skills por tecnología + agentes, en la convención de un harness. */
function harnessArtifacts(model, harness) {
  const tokens = { ...harness.tokens, docs: DOCS_DIR };
  const files = [
    { path: harness.contextFile, content: contextMd(model) },
    { path: harness.skillPath(SKILL, 'SKILL.md'), content: skillMd(model) },
    ...emitHarnessFiles({
      harnesses: [harness],
      skills: stackSkills(model).map((name) => path.join(generatorDir, 'skills', name)),
      agents: AGENTS.map((name) => path.join(agentsSourceDir, name)),
      extraTokens: { docs: DOCS_DIR }
    })
  ];
  return files.map((file) => ({ ...file, content: applyTokens(file.content, tokens) }));
}

/** El ejecutable de las pruebas de flujo, con la clase que se le pide (la ruta relativa a la raíz del proyecto). */
function flowsCommand(model, className) {
  const project = solution(model).integrationTests;
  return `dotnet ${project.dir}/bin/Debug/${TARGET_FRAMEWORK}/${project.name}.dll -class "${project.name}.${className}"`;
}

function contextMd(model) {
  const { service } = model;
  const sln = solution(model);
  const layers = Object.keys(model.layersPresent).filter((layer) => model.layersPresent[layer]);
  const persistence = usesRelational(model);
  return `# ${service.projectName}

Servicio .NET generado por \`keel-dotnet build\` desde \`specs/${service.name}\` v${service.version}. Es el equivalente
de los servidores de keel-spring y keel-nest del mismo diseño: mismo contrato HTTP, mismo cable, mismo esquema.

- **Diseño**: \`specs/\` es un snapshot del diseño Keel; el canónico vive en el workspace de diseño. No se edita aquí.
- **Capas declaradas**: ${layers.length > 0 ? layers.join(', ') : '(ninguna)'}.
- **Stack** (\`keel-stack.json\`): ${describeStack(model.stack)}.
- **Arquitectura**: hexagonal + CQRS (\`{{keel:docs}}/architecture.md\`), un proyecto por capa (\`${sln.domain.name}\`, \`${sln.application.name}\`, \`${sln.infrastructure.name}\`, \`${sln.api.name}\`): la frontera la impone el compilador con las referencias entre proyectos. Reglas inviolables: \`{{keel:docs}}/constitution.md\`.
- **Configuración**: perfil por \`PROFILE\` (default \`local\`), \`config/application.yaml\` + \`config/parameters/<perfil>/\`; \`\${VAR}\` es obligatoria y \`\${VAR:default}\` opcional.
- **Casos de uso**: un mensaje y un handler por operación, despachados por \`UseCaseMediator\`, que abre la transacción; el registro de los handlers es generado (\`UseCaseRegistration\`). Los handlers nacen con las notas del diseño y terminan en \`throw new NotImplementedException("TODO: <operación>")\`.${
    persistence ? `\n- **Esquema**: en \`local\` lo crea EF Core desde el modelo (\`EnsureCreated\`); en \`develop\` y \`production\`, las migraciones de EF Core al arrancar.` : ''
  }${
    usesDocument(model)
      ? `\n- **Documentos** (MongoDB, sobre un replica set): no hay migraciones; los índices del diseño los crea el servidor al arrancar (\`DocumentIndexes.cs\`) y \`bash infra/export-indexes.sh\` los exporta para verificarlos.`
      : ''
  }
- **Paquetes**: solo con licencia permisiva y versión exacta (\`Directory.Packages.props\`); nunca uno que haya pasado a licencia comercial (MediatR, AutoMapper, MassTransit, FluentAssertions…).

## Completar el servicio

\`/${SKILL}\`, sin argumentos y con el cwd en esta raíz: orquesta los agentes de código, infraestructura, pruebas,
arbitraje y calidad hasta el 100% de los escenarios \`FL-*\`. El pipeline: \`{{keel:docs}}/orchestration.md\`.

## Verificación

\`\`\`bash
dotnet restore                     # la primera vez escribe packages.lock.json: commitéalos
dotnet build                       # la solución entera; un warning es un error
dotnet test                        # las pruebas de build (perfil test, sin infraestructura)
bash infra/up.sh && bash infra/validate-infra.sh   # la infraestructura de prueba
bash infra/score-scenarios.sh                      # compila + humo del arnés + flujos FL-* + matriz
\`\`\`
${
    (model.formatTypes ?? []).length > 0
      ? '\n`infra/check-domain-guards.sh` sale en ROJO recién generado a propósito: el formato de los value types escalares lo hace cumplir `<Tipo>Format.Validate(...)`, y esa llamada es del agente.\n'
      : ''
  }${
    usesIdempotencyCheck(model)
      ? '\n`infra/check-idempotency.sh` también sale en ROJO recién generado a propósito: comprueba que el código del agente USE los mecanismos de repetición que build generó (la guarda de los listeners, el registro de peticiones, el reclamo de los barridos, el Raise de los eventos, el dispatcher del outbox). Es el mismo gate que el de los servidores de keel-spring y keel-nest.\n'
      : ''
  }${
    (model.services ?? []).some((service) => (service.operations ?? []).length > 0)
      ? `\n\`infra/check-logging.sh\`${usesTelemetry(model) ? ' y `infra/check-telemetry.sh`' : ''} salen en VERDE recién generado${usesTelemetry(model) ? 's' : ''}: vetan lo que el agente pueda añadir (un objeto de entrada entero en un log, un mensaje construido a mano, un \`LogError\` desde Domain o Application, la consola a pelo, trabajo lanzado sin el contexto de la petición${usesTelemetry(model) ? '; una etiqueta de métrica fuera del vocabulario' : ''}). Un rojo ahí es siempre código del agente.\n`
      : ''
  }`;
}

function skillMd(model) {
  const { service } = model;
  const sln = solution(model);
  const persistence = usesRelational(model);
  const baseline = usesSchemaBaseline(model);
  const indexes = usesDocument(model);
  const techSkills = stackSkills(model);
  const techSkillsBullet = techSkills.length
    ? `\n- Skills por tecnología (\`{{keel:skills}}\`, hermanas de esta), instaladas solo las aplicables a este servicio: ${techSkills.map((s) => `\`${s}\``).join(', ')}. Cada una trae \`references/\` que se leen bajo demanda.`
    : '';
  return `---
name: ${SKILL}
description: Completa la generación de este microservicio .NET a partir del diseño Keel incluido en specs/, orquestando los subagentes de código, infraestructura, pruebas de integración, arbitraje y calidad. Usar dentro de este proyecto, sin argumentos.
---

# /${SKILL} — completar ${service.projectName}

Este proyecto lo generó \`keel-dotnet build\` desde \`specs/${service.name}\` v${service.version} y es **autosuficiente**.
Se invoca **sin argumentos, con el cwd en esta raíz**; todas las rutas son relativas a ella. Tú eres el
**orquestador**: el trabajo lo hacen los subagentes de \`{{keel:agents}}\`. El pipeline completo, con sus porqués:
\`{{keel:docs}}/orchestration.md\`.

## Proceso

0. **Precondiciones.** \`specs/\` es un snapshot que \`keel-dotnet build\` ya validó: no lo revalides ni lo edites
   —el canónico es \`specs/${service.name}/\` del workspace, y un cambio funcional lo hace **el diseñador** allí y
   re-ejecuta \`keel-dotnet build\`—. **Tú no editas ni este snapshot ni el workspace.** Un escenario que contradice al
   diseño es un \`culprit: design\`: se **propone** en \`design-gaps.yaml\`, no se aplica (\`infra/score-scenarios.sh\`
   comprueba el sello de \`specs/\` y sale con \`2\` si cambió). Comprueba solo: que existe
   \`specs/validation-scenarios.md\` (sin escenarios no hay contra qué validar: detente y pide cerrar el diseño con
   \`/keel-design\`), que esta raíz es un repo git (si no, \`git init -b main\`), que está el SDK de .NET 10
   (\`dotnet --list-sdks\`) y que los paquetes se restauran (\`dotnet restore\`). El stack está en
   \`keel-stack.json\`: respétalo.
1. **Fase 1 — en paralelo** (los tres lanzados a la vez, en un único mensaje):
   - \`keel-dotnet-code\`: «Completa el proyecto en \`.\`. Tu proceso, tu alcance y tu criterio de terminado son los de
     tu archivo de agente; \`{{keel:context}}\` es el contexto del repo, no tu lista de tareas.» — hasta \`dotnet build\`
     en verde, sin warnings.
   - \`keel-dotnet-infra\`: «Levanta y valida la infraestructura de \`.\` (\`infra/\`). Déjala arriba y reporta.»
   - \`keel-dotnet-tests\`: «Traduce los escenarios \`FL-*\` de \`specs/validation-scenarios.md\` a pruebas en
     \`${sln.integrationTests.dir}/\` de \`.\`.» — una clase por flujo, en caja negra y **sin leer \`src/\`**, hasta
     \`bash infra/check-flows.sh\` en verde.

   **Espera a los tres sin hacer nada más.** Gating sobre su bloque estructurado: sin docker/podman
   (\`infra status: PENDIENTE\`) → **detente** (compilado pero NO validado). Infra KO corregible → relanza infra una
   vez. \`code\` con \`compiles: false\` → relánzalo con sus \`failures\` (máx. 2 ciclos). \`tests\` en KO por causa
   propia → relánzalo; si su KO viene de \`src/\`, no es suyo. \`blockers\` en cualquiera → detente y repórtalo.
2. **Fase 2a — puntuación mecánica (tú, sin agente).** Con los tres en OK: \`bash infra/score-scenarios.sh\`. Compila
   la solución, arranca por el **humo del arnés** y solo con él en verde ejecuta la suite y compone la matriz
   \`FL-* → OK | FALLO | OMITIDO | NO_EJERC\` desde el XML JUnit. La salida de \`dotnet\` va a
   \`build/keel-scenarios/run.log\` y la del servidor a \`build/keel-scenarios/server.log\`: no las vuelques en tu
   contexto salvo para diagnosticar. Según el código: \`0\` → fase 3 **sin invocar a nadie**; \`1\` → fase 2b; \`2\` →
   **nada que arbitrar**: con \`BUILD: KO\`, relanza a quien sea dueño de los errores que imprime (\`src/\` →
   \`keel-dotnet-code\`, el proyecto de flujos → \`keel-dotnet-tests\`); con el humo rojo, la matriz vacía, la suite en
   rojo por pruebas que no son escenarios o un flujo que no arrancó, relanza \`keel-dotnet-tests\` (no consume cupo)
   — salvo que el defecto esté fuera del proyecto de flujos (\`infra/\`, la solución, \`Directory.*.props\`): eso es de
   build, lo corriges tú y va al informe como fix del generador.
3. **Fase 2b — arbitraje.** Lanza \`keel-dotnet-validate\` con la matriz y, por cada fallo, su clase de flujo y su
   volcado de \`build/keel-failures/\`, y **espera sin ejecutar nada** (una pasada tuya del script le borraría la
   evidencia). Según \`culprit\`: \`code\` → \`keel-dotnet-code\` con **exactamente** sus \`failures\` (con
   \`evidence\`); \`test\` → \`keel-dotnet-tests\`; \`harness\` → \`keel-dotnet-tests\` exigiendo verificación amplia y
   \`harnessPatches\`; \`design\` → detente y propón el cambio. Tras cualquier ciclo de fix se vuelve **siempre** a
   \`bash infra/score-scenarios.sh\`. Mezcla de \`code\` con \`test\`/\`harness\` → **en serie**, primero \`code\`
   (comparten la base de prueba). Cupo de ciclos \`blocking: scoped\`, por número de flujos \`FL-*\`: hasta 10, 2 (tope
   4); de 11 a 20, 3 (tope 5); más de 20, 4 (tope 6). No lo consumen los \`systemic\` ni los \`test\`/\`harness\`.
   Alcanzado el tope, reporta la matriz y detente.
4. **Fase 3 — calidad${baseline ? ' + baseline de migraciones' : indexes ? ' + índices vivos' : ''}.** Solo con **todos** los escenarios OK: lanza
   \`keel-dotnet-quality\` y **espera sin tocar el proyecto**. Hace el pase no-conductual, comprueba la no-regresión
   (la suite al 100%) y \`dotnet test\`${
     baseline
       ? `, y produce el **baseline de migraciones**: revisa el DDL del modelo (\`infra/export-schema.sh\`), crea la migración (\`${baselineCommand(model)}\`) y la **verifica en vivo** (\`infra/verify-baseline.sh\`). Exige \`baseline: OK\` y \`baselineTested: OK\`: sin ellos el servicio pasa sus escenarios (corren en \`local\`) pero no arranca en \`develop\` ni en \`production\`. \`KO\` → relánzalo una vez con su error exacto`
       : indexes
         ? ', y **verifica los índices vivos** contra los que crea el servidor (`bash infra/export-indexes.sh`, sin crear ni borrar ninguno a mano). Exige `indexes: OK` e `indexesTested: OK`'
         : ''
   }. \`status: KO\` o \`scenarios: KO\` → revierte o reporta; nunca hagas commit con algo en rojo. Al terminar, baja la
   infraestructura: \`bash infra/down.sh\`.
5. **Guía de despliegue.** Con todo en verde y **antes** del commit, añade al \`README.md\` una sección
   \`## Despliegue en producción\` con los pasos y la tabla de parámetros obligatorios: todo \`\${VAR}\` sin default de
   \`config/parameters/production/*.yaml\`${persistence ? ', y que el esquema lo crean las migraciones de EF Core al arrancar' : ''}.
   No inventes parámetros.
6. **Informe de generación.** Escribe \`INFORME-GENERACION.md\`, que **abre con la matriz final de
   \`infra/score-scenarios.sh\` y su código de salida, literales**, y sigue con lo que es del generador
   (\`harnessPatches\`, fixes de \`infra/\` o de la solución, \`culprit: harness\`, \`probes[].verdict: FALSO-NEGATIVO\`),
   cada entrada diciendo de quién es. Y \`design-gaps.yaml\` con **cada** \`designGap\` (schema
   \`design-gaps.schema.json\` de keel-core, con el \`service\` y la \`version\` de \`specs/service.keel.yaml\` y
   \`generator: keel-dotnet\`): \`keel-dotnet check\` lo imprime desde el workspace. Antes de escribir un hueco, búscalo
   en \`specs/gaps.yaml\` y \`specs/decisions.yaml\`: si ya está ahí aceptado (\`state: accepted\`), es una decisión
   tomada por escrito y no se reporta. Sin huecos, no se escribe; sin nada
   que reportar, dilo en una línea.
7. **Cerrar.** Commit (\`Generado desde specs/${service.name} v${service.version}\`; los \`packages.lock.json\` incluidos) y
   resumen: matriz, estado de cada agente, ajustes de calidad y huecos del diseño.

## Conocimiento local

- \`{{keel:context}}\` — contexto del repo (diseño, stack, verificación).
- \`{{keel:docs}}/orchestration.md\` — el pipeline: fases, códigos, agentes, handoffs y ciclos.
- \`{{keel:docs}}/architecture.md\` y \`{{keel:docs}}/constitution.md\` — la arquitectura y sus reglas inviolables.
- \`{{keel:docs}}/conventions/\` — mapeo diseño → código (\`mapping.md\`, estricto), estructura y comandos
  (\`project-layout.md\`), el dominio (\`domain-modeling.md\`), la auditoría de cada handler (\`flow-fidelity.md\`), las
  pruebas de los escenarios (\`integration-tests.md\`) y la infraestructura (\`infra-validation.md\`).${techSkillsBullet}
- Un flujo suelto, con la solución compilada: \`${flowsCommand(model, '<Flujo>Flow')}\`; el humo,
  \`${flowsCommand(model, HARNESS_SMOKE_CLASS)}\`.

**Un solo actor sobre el proyecto, en todo momento.** Mientras un subagente esté vivo, tú no ejecutas nada sobre
este directorio: el script sobrescribe la evidencia que el árbitro lee, el reset vacía la base que otro está
usando, y en Windows el servidor de los flujos retiene el ejecutable del Api. Y el trabajo de un agente **no lo
haces tú aunque sepas hacerlo**: sus restricciones —el de pruebas sin leer \`src/\`, el árbitro sin corregir, el de
calidad sin cambiar comportamiento— son del agente. Tu trabajo propio es la fase 2a y los pasos 5 a 7.

En corto, de la constitución: el diseño es la única fuente de verdad funcional, los \`code\` de error se copian
exactos, los importes son \`decimal\` (nunca \`double\`) con escala y redondeo explícitos, ningún paquete con licencia
comercial, y ante ambigüedad, diseño > conventions > criterio. No des la generación por terminada con la
compilación en rojo o un escenario fallando.
`;
}
