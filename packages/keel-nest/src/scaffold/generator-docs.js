// Conocimiento del generador dentro del proyecto: la skill orquestadora `keel-generate-nest` (la
// ÚNICA del flujo: no se siembra ninguna en el workspace de diseño), los cinco agentes de la
// orquestación, las skills por tecnología del stack y las docs de apoyo. Junto con el snapshot de
// specs/, hace el repo autosuficiente: quien lo clone puede completar la generación sin el workspace.
//
// Dos destinos, igual que en keel-spring:
//   · lo que el harness CARGA —skills, agentes, el archivo de contexto— se PROYECTA a la convención de
//     cada harness soportado (HARNESSES de keel-core) desde una fuente neutral;
//   · lo que solo es markdown que un agente lee por ruta —architecture, constitution, orchestration,
//     conventions— va a `docs/keel/`, UNA sola copia, y no puede citar rutas de harness.

import fs from 'node:fs';
import path from 'node:path';
import { HARNESSES, applyTokens, emitHarnessFiles } from 'keel-core';
import { describeStack } from 'keel-core/gen/stack';
import { assetsDir, SKILL } from '../lib/assets.js';
import { usesRelational } from './persistence-entities.js';
import { usesJwt } from './security.js';
import { usesSchemaBaseline } from './schema-baseline.js';
import { usesKafka, usesRabbitMq, usesSnsSqs } from './messaging.js';

const generatorDir = path.join(assetsDir, 'generators', 'nest');
const agentsSourceDir = path.join(assetsDir, 'agents');

/** Raíz de las docs de apoyo en el proyecto generado; es también el valor del token {{keel:docs}}. */
export const DOCS_DIR = 'docs/keel';

/** Docs de primer nivel del generador, junto a conventions/ bajo DOCS_DIR. */
export const GUIDES = ['architecture.md', 'constitution.md', 'orchestration.md'];

/** Las convenciones: el único punto de instalación (un archivo nuevo de conventions/ va aquí). */
export const CONVENTIONS = [
  'mapping.md',
  'project-layout.md',
  'domain-modeling.md',
  'flow-fidelity.md',
  'integration-tests.md',
  'infra-validation.md'
];

/** Los subagentes de la orquestación. Son HOJAS (`spawns: false`): el único orquestador es la skill. */
export const AGENTS = ['keel-nest-code.md', 'keel-nest-infra.md', 'keel-nest-tests.md', 'keel-nest-validate.md', 'keel-nest-quality.md'];

/** Skills por tecnología aplicables al servicio: la de la base relacional, la del proveedor de identidad y la del broker. */
export function stackSkills(model) {
  const skills = usesRelational(model) ? ['keel-nest-database'] : [];
  if (usesJwt(model) && ['keycloak', 'cognito'].includes(model.stack?.auth)) skills.push(`keel-nest-${model.stack.auth}`);
  if (usesRabbitMq(model)) skills.push('keel-nest-rabbitmq');
  if (usesKafka(model)) skills.push('keel-nest-kafka');
  if (usesSnsSqs(model)) skills.push('keel-nest-snssqs');
  return skills;
}

export function generate(model) {
  const files = [];
  for (const name of GUIDES) files.push({ path: `${DOCS_DIR}/${name}`, content: docContent(path.join(generatorDir, name)) });
  for (const name of CONVENTIONS) {
    files.push({ path: `${DOCS_DIR}/conventions/${name}`, content: docContent(path.join(generatorDir, 'conventions', name)) });
  }
  for (const harness of HARNESSES) files.push(...harnessArtifacts(model, harness));
  return files;
}

// El archivo de contexto de cada harness tiene otro nombre en el otro: en material compartido sería
// tan mentira como una ruta `.claude/`.
const CONTEXT_FILES = new RegExp(`\\b(${HARNESSES.map((h) => h.contextFile.replace('.', '\\.')).join('|')})`, 'g');

/**
 * Las docs viven en un único sitio, compartido por todos los harnesses: solo se resuelve
 * `{{keel:docs}}`, y cualquier token de harness o nombre de archivo de contexto es un error de la
 * fuente — esa frase tiene que nombrar la skill o el agente, no su ruta.
 */
function docContent(sourceFile) {
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

function contextMd(model) {
  const { service } = model;
  const layers = Object.keys(model.layersPresent).filter((layer) => model.layersPresent[layer]);
  const persistence = usesRelational(model);
  return `# ${service.projectName}

Servicio NestJS generado por \`keel-nest build\` desde \`specs/${service.name}\` v${service.version}. Es el
equivalente del servidor de keel-spring del mismo diseño: mismo contrato HTTP, mismo cable, mismo esquema.

- **Diseño**: \`specs/\` es un snapshot del diseño Keel; el canónico vive en el workspace de diseño. No se edita aquí.
- **Capas declaradas**: ${layers.length > 0 ? layers.join(', ') : '(ninguna)'}.
- **Stack** (\`keel-stack.json\`): ${describeStack(model.stack)}.
- **Arquitectura**: hexagonal + CQRS (\`{{keel:docs}}/architecture.md\`). \`src/domain\` y \`src/application\` no importan el framework; \`src/infrastructure\` es el único sitio que lo conoce. Reglas inviolables: \`{{keel:docs}}/constitution.md\`.
- **Configuración**: perfil por \`PROFILE\` (default \`local\`), \`config/application.yaml\` + \`config/parameters/<perfil>/\`; \`\${VAR}\` es obligatoria y \`\${VAR:default}\` opcional.
- **Inyección**: siempre con \`@Inject(<token>)\` explícito. La capa application no usa \`@Inject\`: sus clases declaran \`static readonly inject = [...]\` y las cablea \`src/infrastructure/usecase/use-case-module.ts\`.
- **Casos de uso**: un mensaje y un handler (\`@Handles(<Mensaje>)\`) por operación, despachados por \`UseCaseMediator\`, que abre la transacción. Los handlers nacen con las notas del diseño y terminan en \`throw new Error('TODO: <operación>')\`.${
    persistence ? `\n- **Esquema**: en \`local\` lo crea TypeORM (\`synchronize\`); en \`develop\` y \`production\`, las migraciones de \`src/migrations/\` al arrancar.` : ''
  }

## Completar el servicio

\`/${SKILL}\`, sin argumentos y con el cwd en esta raíz: orquesta los agentes de código, infraestructura,
pruebas, arbitraje y calidad hasta el 100% de los escenarios \`FL-*\`. El pipeline: \`{{keel:docs}}/orchestration.md\`.

## Verificación

\`\`\`bash
npm install                    # la primera vez crea package-lock.json: commitéalo; después, npm ci
npm run build                  # compila src/
npm run check:architecture     # frontera hexagonal + caja negra de los flujos
npm test                       # las pruebas de build (perfil test, sin infraestructura)
bash infra/up.sh && bash infra/validate-infra.sh   # la infraestructura de prueba
bash infra/score-scenarios.sh                      # humo del arnés + flujos FL-* + matriz
\`\`\`
${
    (model.formatTypes ?? []).length > 0
      ? '\n`infra/check-domain-guards.sh` sale en ROJO recién generado a propósito: el formato de los value types escalares lo hace cumplir `<Tipo>Format.validate(...)`, y esa llamada es del agente.\n'
      : ''
  }`;
}

function skillMd(model) {
  const { service } = model;
  const persistence = usesRelational(model);
  const baseline = usesSchemaBaseline(model);
  const techSkills = stackSkills(model);
  const techSkillsBullet = techSkills.length
    ? `\n- Skills por tecnología (\`{{keel:skills}}\`, hermanas de esta), instaladas solo las aplicables a este servicio: ${techSkills.map((s) => `\`${s}\``).join(', ')}. Cada una trae \`references/\` que se leen bajo demanda.`
    : '';
  return `---
name: ${SKILL}
description: Completa la generación de este microservicio NestJS a partir del diseño Keel incluido en specs/, orquestando los subagentes de código, infraestructura, pruebas de integración, arbitraje y calidad. Usar dentro de este proyecto, sin argumentos.
---

# /${SKILL} — completar ${service.projectName}

Este proyecto lo generó \`keel-nest build\` desde \`specs/${service.name}\` v${service.version} y es
**autosuficiente**. Se invoca **sin argumentos, con el cwd en esta raíz**; todas las rutas son relativas a
ella. Tú eres el **orquestador**: el trabajo lo hacen los subagentes de \`{{keel:agents}}\`. El pipeline
completo, con sus porqués: \`{{keel:docs}}/orchestration.md\`.

## Proceso

0. **Precondiciones.** \`specs/\` es un snapshot que \`keel-nest build\` ya validó: no lo revalides ni lo
   edites —el canónico es \`specs/${service.name}/\` del workspace, y un cambio funcional lo hace **el
   diseñador** allí y re-ejecuta \`keel-nest build\`—. **Tú no editas ni este snapshot ni el workspace.**
   Un escenario que contradice al diseño es un \`culprit: design\`: se **propone** en \`design-gaps.yaml\`,
   no se aplica (\`infra/score-scenarios.sh\` comprueba el sello de \`specs/\` y sale con \`2\` si cambió).
   Comprueba solo: que existe \`specs/validation-scenarios.md\` (sin escenarios no hay contra qué validar:
   detente y pide cerrar el diseño con \`/keel-design\`), que esta raíz es un repo git (si no,
   \`git init -b main\`) y que las dependencias están instaladas (\`npm install\` la primera vez, \`npm ci\`
   si ya hay \`package-lock.json\`). El stack está en \`keel-stack.json\`: respétalo.
1. **Fase 1 — en paralelo** (los tres lanzados a la vez, en un único mensaje):
   - \`keel-nest-code\`: «Completa el proyecto en \`.\`. Tu proceso, tu alcance y tu criterio de terminado
     son los de tu archivo de agente; \`{{keel:context}}\` es el contexto del repo, no tu lista de
     tareas.» — hasta \`npm run build\` y \`npm run check:architecture\` en verde.
   - \`keel-nest-infra\`: «Levanta y valida la infraestructura de \`.\` (\`infra/\`). Déjala arriba y reporta.»
   - \`keel-nest-tests\`: «Traduce los escenarios \`FL-*\` de \`specs/validation-scenarios.md\` a pruebas en
     \`test/integration/\` de \`.\`.» — una por flujo, en caja negra y **sin leer \`src/\`**, hasta
     \`bash infra/check-flows.sh\` en verde.

   **Espera a los tres sin hacer nada más.** Gating sobre su bloque estructurado: sin docker/podman
   (\`infra status: PENDIENTE\`) → **detente** (compilado pero NO validado). Infra KO corregible → relanza
   infra una vez. \`code\` con \`compiles: false\` → relánzalo con sus \`failures\` (máx. 2 ciclos). \`tests\`
   en KO por causa propia → relánzalo; si su KO viene de \`src/\`, no es suyo. \`blockers\` en cualquiera
   → detente y repórtalo.
2. **Fase 2a — puntuación mecánica (tú, sin agente).** Con los tres en OK: \`bash infra/score-scenarios.sh\`.
   Arranca por el **humo del arnés** y solo con él en verde ejecuta la suite y compone la matriz
   \`FL-* → OK | FALLO | OMITIDO | NO_EJERC\` desde el XML JUnit. La salida de Vitest va a
   \`build/keel-scenarios/run.log\`: no la vuelques en tu contexto salvo para diagnosticar. Según el código:
   \`0\` → fase 3 **sin invocar a nadie**; \`1\` → fase 2b; \`2\` → **nada que arbitrar** (humo rojo, matriz
   vacía, la suite falló por pruebas que no son escenarios, un flujo no arrancó sin dejar ningún FALLO, o
   \`specs/\` editado): relanza \`keel-nest-tests\` (no consume cupo) — salvo que el defecto esté fuera de
   \`test/integration/\` (\`infra/\`, \`package.json\`, la configuración de Vitest): eso es de build, lo
   corriges tú y va al informe como fix del generador.
3. **Fase 2b — arbitraje.** Lanza \`keel-nest-validate\` con la matriz y, por cada fallo, su archivo y su
   volcado de \`build/keel-failures/\`, y **espera sin ejecutar nada** (una pasada tuya del script le
   borraría la evidencia). Según \`culprit\`: \`code\` → \`keel-nest-code\` con **exactamente** sus
   \`failures\` (con \`evidence\`); \`test\` → \`keel-nest-tests\`; \`harness\` → \`keel-nest-tests\` exigiendo
   verificación amplia y \`harnessPatches\`; \`design\` → detente y propón el cambio. Tras cualquier ciclo
   de fix se vuelve **siempre** a \`bash infra/score-scenarios.sh\`. Mezcla de \`code\` con \`test\`/\`harness\`
   → **en serie**, primero \`code\` (comparten la base de prueba). Cupo de ciclos \`blocking: scoped\`, por
   número de flujos \`FL-*\`: hasta 10, 2 (tope 4); de 11 a 20, 3 (tope 5); más de 20, 4 (tope 6). No lo
   consumen los \`systemic\` ni los \`test\`/\`harness\`. Alcanzado el tope, reporta la matriz y detente.
4. **Fase 3 — calidad${baseline ? ' + baseline de migraciones' : ''}.** Solo con **todos** los escenarios OK:
   lanza \`keel-nest-quality\` y **espera sin tocar el proyecto**. Hace el pase no-conductual, comprueba la
   no-regresión (la suite al 100%) y \`npm test\`${
     baseline
       ? `, y produce el **baseline de migraciones**: lo exporta (\`infra/export-schema.sh\`), lo revisa, lo copia a \`src/migrations/\` y lo **verifica en vivo** (\`infra/verify-baseline.sh\`). Exige \`baseline: OK\` y \`baselineTested: OK\`: sin ellos el servicio pasa sus escenarios (corren en \`local\`) pero no arranca en \`develop\` ni en \`production\`. \`KO\` → relánzalo una vez con su error exacto`
       : ''
   }. \`status: KO\` o \`scenarios: KO\` → revierte o reporta; nunca hagas commit con algo en rojo. Al
   terminar, baja la infraestructura: \`bash infra/down.sh\`.
5. **Guía de despliegue.** Con todo en verde y **antes** del commit, añade al \`README.md\` una sección
   \`## Despliegue en producción\` con los pasos y la tabla de parámetros obligatorios: todo \`\${VAR}\` sin
   default de \`config/parameters/production/*.yaml\`${persistence ? ', y que el esquema lo crean las migraciones de `src/migrations/` al arrancar' : ''}.
   No inventes parámetros.
6. **Informe de generación.** Escribe \`INFORME-GENERACION.md\`, que **abre con la matriz final de
   \`infra/score-scenarios.sh\` y su código de salida, literales**, y sigue con lo que es del generador
   (\`harnessPatches\`, fixes de \`infra/\` o de la configuración, \`culprit: harness\`,
   \`probes[].verdict: FALSO-NEGATIVO\`), cada entrada diciendo de quién es. Y \`design-gaps.yaml\` con
   **cada** \`designGap\` (schema \`design-gaps.schema.json\` de keel-core, con el \`service\` y la \`version\` de
   \`specs/service.keel.yaml\` y \`generator: keel-nest\`): \`keel-nest check\` lo imprime desde el workspace.
   Sin huecos, no se escribe; sin nada que reportar, dilo en una línea.
7. **Cerrar.** Commit (\`Generado desde specs/${service.name} v${service.version}\`) y resumen: matriz,
   estado de cada agente, ajustes de calidad y huecos del diseño.

## Conocimiento local

- \`{{keel:context}}\` — contexto del repo (diseño, stack, verificación).
- \`{{keel:docs}}/orchestration.md\` — el pipeline: fases, códigos, agentes, handoffs y ciclos.
- \`{{keel:docs}}/architecture.md\` y \`{{keel:docs}}/constitution.md\` — la arquitectura y sus reglas inviolables.
- \`{{keel:docs}}/conventions/\` — mapeo diseño → código (\`mapping.md\`, estricto), estructura y comandos
  (\`project-layout.md\`), el dominio (\`domain-modeling.md\`), la auditoría de cada handler
  (\`flow-fidelity.md\`), las pruebas de los escenarios (\`integration-tests.md\`) y la infraestructura
  (\`infra-validation.md\`).${techSkillsBullet}

**Un solo actor sobre el proyecto, en todo momento.** Mientras un subagente esté vivo, tú no ejecutas
nada sobre este directorio: el script sobrescribe la evidencia que el árbitro lee y el reset vacía la base
que otro está usando. Y el trabajo de un agente **no lo haces tú aunque sepas hacerlo**: sus restricciones
—el de pruebas sin leer \`src/\`, el árbitro sin corregir, el de calidad sin cambiar comportamiento— son
del agente. Tu trabajo propio es la fase 2a y los pasos 5 a 7.

En corto, de la constitución: el diseño es la única fuente de verdad funcional, los \`code\` de error se
copian exactos, los importes son \`Decimal\` (nunca \`number\`) con escala y redondeo explícitos, y ante
ambigüedad, diseño > conventions > criterio. No des la generación por terminada con la compilación en
rojo o un escenario fallando.
`;
}
