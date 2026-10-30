// Conocimiento del generador dentro del proyecto: la skill orquestadora `keel-generate-go` (la ÚNICA del flujo: no
// se siembra ninguna en el workspace de diseño), los cinco agentes de la orquestación, las skills por tecnología del
// stack y las docs de apoyo. Junto con el snapshot de specs/, hace el repo autosuficiente: quien lo clone puede
// completar la generación sin el workspace.
//
// Dos destinos, igual que en los otros tres generadores:
//   · lo que el harness CARGA —skills, agentes, el archivo de contexto— se PROYECTA a la convención de cada harness
//     soportado (HARNESSES de keel-core) desde una fuente neutral;
//   · lo que solo es markdown que un agente lee por ruta —architecture, constitution, orchestration, conventions— va
//     a `docs/keel/`, UNA sola copia, y no puede citar rutas de harness.

import fs from 'node:fs';
import path from 'node:path';
import { HARNESSES, applyTokens, emitHarnessFiles } from '@keel-system/keel-core';
import { contractDocs } from '@keel-system/keel-core/gen/contract-docs';
import { describeStack } from '@keel-system/keel-core/gen/stack';
import { assetsDir, SKILL } from '../lib/assets.js';
import { layout } from './render.js';
import { usesRelational } from './persistence.js';
import { usesRequestIdempotency } from './request-idempotency.js';
import { storeDir } from '../lib/relational-engine.js';

const generatorDir = path.join(assetsDir, 'generators', 'go');
const agentsSourceDir = path.join(assetsDir, 'agents');

/** Raíz de las docs de apoyo en el proyecto generado; es también el valor del token {{keel:docs}}. */
export const DOCS_DIR = 'docs/keel';

/** Docs de primer nivel del generador, junto a conventions/ bajo DOCS_DIR. */
export const GUIDES = ['architecture.md', 'constitution.md', 'orchestration.md'];

/**
 * Las convenciones: el único punto de instalación (un archivo nuevo de conventions/ va aquí). Las seis primeras son
 * las reglas de Go del § 3 del plan; las tres últimas, las del pipeline (la auditoría de cada handler, las pruebas de
 * los escenarios y la infraestructura).
 */
export const CONVENTIONS = ['naming.md', 'errors.md', 'context.md', 'concurrency.md', 'http.md', 'testing.md', 'flow-fidelity.md', 'integration-tests.md', 'infra-validation.md'];

/** Los subagentes de la orquestación. Son HOJAS (`spawns: false`): el único orquestador es la skill. */
export const AGENTS = ['keel-go-code.md', 'keel-go-infra.md', 'keel-go-tests.md', 'keel-go-validate.md', 'keel-go-quality.md'];

/** Skills por tecnología aplicables al servicio: hoy, la de la base relacional. */
export function stackSkills(model) {
  return usesRelational(model) ? ['keel-go-database'] : [];
}

export function generate(model) {
  const files = [];
  for (const name of GUIDES) files.push({ path: `${DOCS_DIR}/${name}`, content: docContent(path.join(generatorDir, name)) });
  for (const name of CONVENTIONS) {
    files.push({ path: `${DOCS_DIR}/conventions/${name}`, content: docContent(path.join(generatorDir, 'conventions', name)) });
  }
  // Los documentos de contrato del método, los mismos que instalan los otros tres (keel-core/gen/contract-docs.js).
  for (const doc of contractDocs()) files.push({ path: `${DOCS_DIR}/${doc.name}`, content: doc.content });
  for (const harness of HARNESSES) files.push(...harnessArtifacts(model, harness));
  return files;
}

// El archivo de contexto de cada harness tiene otro nombre en el otro: en material compartido sería tan mentira
// como una ruta `.claude/`.
const CONTEXT_FILES = new RegExp(`\\b(${HARNESSES.map((h) => h.contextFile.replace('.', '\\.')).join('|')})`, 'g');

/**
 * Las docs viven en un único sitio, compartido por todos los harnesses: solo se resuelve `{{keel:docs}}`, y
 * cualquier token de harness o nombre de archivo de contexto es un error de la fuente.
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

/** Un flujo de integración suelto: la función `Test<Flujo>` con la restricción `integration` y sin la caché de go test. */
export function flowCommand(test) {
  return `go test -tags integration -count=1 -run '^${test}$' ./tests/integration/`;
}

function contextMd(model) {
  const { service } = model;
  const pkgs = layout(model);
  const layers = Object.keys(model.layersPresent).filter((layer) => model.layersPresent[layer]);
  const persistence = usesRelational(model);
  return `# ${service.projectName}

Servicio Go generado por \`keel-go build\` desde \`specs/${service.name}\` v${service.version}. Es el equivalente de
los servidores de keel-spring, keel-nest y keel-dotnet del mismo diseño: mismo contrato HTTP, mismo cable, mismo
esquema. Equivalente por fuera, Go por dentro.

- **Diseño**: \`specs/\` es un snapshot del diseño Keel; el canónico vive en el workspace de diseño. No se edita aquí.
- **Capas declaradas**: ${layers.length > 0 ? layers.join(', ') : '(ninguna)'}.
- **Stack** (\`keel-stack.json\`): ${describeStack(model.stack)}.
- **Arquitectura**: hexagonal + CQRS (\`{{keel:docs}}/architecture.md\`), un módulo con un paquete por capa
  (\`${pkgs.domain.dir}\`, \`${pkgs.application.dir}\`, \`${pkgs.httpapi.dir}\`, \`internal/infrastructure/*\`,
  \`internal/platform/*\`). La frontera la ejecuta \`${pkgs.architecture.dir}\`.
- **Reglas inviolables**: \`{{keel:docs}}/constitution.md\`, y las de Go en \`{{keel:docs}}/conventions/\`.
- **Código generado**: un archivo con \`// Code generated by keel-go. DO NOT EDIT.\` lo escribe \`keel-go build\` y no
  se toca a mano. Lo que no la lleva es del agente: el comportamiento de cada entidad
  (\`${pkgs.domain.dir}/<entidad>_behavior.go\`) y la lógica de cada operación
  (\`${pkgs.application.dir}/<operación>_{command,query}_handler.go\`, que nace devolviendo \`ErrNotImplemented\`).
- **Casos de uso**: un mensaje y un handler por operación, despachados por \`UseCases\` (\`use_cases.go\`), que abre
  la transacción y escribe el log de frontera de cada uno.${
    persistence
      ? `\n- **Esquema**: la migración de goose embebida en el binario (\`${storeDir(model)}/migrations/\`), que el servidor aplica al arrancar en todos los perfiles.`
      : ''
  }${
    usesRequestIdempotency(model)
      ? '\n- **Idempotencia de petición**: el registro, la firma y el ámbito de cada operación que la declara ya están generados; el handler los usa (`{{keel:docs}}/conventions/flow-fidelity.md` § La idempotencia de petición).'
      : ''
  }
- **Módulos**: solo con licencia permisiva (MIT, Apache-2.0, BSD, ISC); nada GPL, AGPL, BUSL ni SSPL, tampoco
  como herramienta (golangci-lint es GPL-3.0: el lint es \`go vet\` + staticcheck).

## Completar el servicio

\`/${SKILL}\`, sin argumentos y con el cwd en esta raíz: orquesta los agentes de código, infraestructura, pruebas,
arbitraje y calidad hasta el 100% de los escenarios \`FL-*\`. El pipeline: \`{{keel:docs}}/orchestration.md\`.

## Verificación

\`\`\`bash
go mod tidy                 # la primera vez: escribe go.sum (commitéalo)
go build ./... && go vet ./... && go tool staticcheck ./...
gofmt -l .                  # vacío
go test ./...               # las pruebas de build (perfil test, sin infraestructura), la frontera incluida
bash infra/up.sh && bash infra/validate-infra.sh   # la infraestructura de prueba
bash infra/score-scenarios.sh                      # compila + humo del arnés + flujos FL-* + matriz
\`\`\`
${
    (model.formatTypes ?? []).length > 0
      ? '\n`infra/check-domain-guards.sh` sale en ROJO recién generado a propósito: el formato de los value types escalares lo hace cumplir `<Tipo>Format.Validate(...)`, y esa llamada es del agente.\n'
      : ''
  }`;
}

function skillMd(model) {
  const { service } = model;
  const persistence = usesRelational(model);
  const techSkills = stackSkills(model);
  const techSkillsBullet = techSkills.length
    ? `\n- Skills por tecnología (\`{{keel:skills}}\`, hermanas de esta), instaladas solo las aplicables a este servicio: ${techSkills.map((s) => `\`${s}\``).join(', ')}. Cada una trae \`references/\` que se leen bajo demanda.`
    : '';
  return `---
name: ${SKILL}
description: Completa la generación de este microservicio Go a partir del diseño Keel incluido en specs/, orquestando los subagentes de código, infraestructura, pruebas de integración, arbitraje y calidad. Usar dentro de este proyecto, sin argumentos.
---

# /${SKILL} — completar ${service.projectName}

Este proyecto lo generó \`keel-go build\` desde \`specs/${service.name}\` v${service.version} y es **autosuficiente**.
Se invoca **sin argumentos, con el cwd en esta raíz**; todas las rutas son relativas a ella. Tú eres el
**orquestador**: el trabajo lo hacen los subagentes de \`{{keel:agents}}\`. El pipeline completo, con sus porqués:
\`{{keel:docs}}/orchestration.md\`.

## Proceso

0. **Precondiciones.** \`specs/\` es un snapshot que \`keel-go build\` ya validó: no lo revalides ni lo edites
   —el canónico es \`specs/${service.name}/\` del workspace, y un cambio funcional lo hace **el diseñador** allí y
   re-ejecuta \`keel-go build\`—. **Tú no editas ni este snapshot ni el workspace.** Un escenario que contradice al
   diseño es un \`culprit: design\`: se **propone** en \`design-gaps.yaml\`, no se aplica (\`infra/score-scenarios.sh\`
   comprueba el sello de \`specs/\` y sale con \`2\` si cambió). Comprueba solo: que existe
   \`specs/validation-scenarios.md\` (sin escenarios no hay contra qué validar: detente y pide cerrar el diseño con
   \`/keel-design\`), que esta raíz es un repo git (si no, \`git init -b main\`), que está Go (\`go version\`: el
   toolchain que fija \`go.mod\` se descarga solo) y que el módulo resuelve con \`go mod tidy\`, que escribe
   \`go.sum\` sin mover ningún requisito directo de \`go.mod\` (\`git diff go.mod\` solo puede mostrar indirectos; si
   mueve un directo, es un defecto del generador: detente). El stack está en \`keel-stack.json\`: respétalo.

   **Modo evolución.** Si existe \`build/keel-refresh/EVOLUTION.md\`, este proyecto ya estaba completado y algo
   cambió desde entonces —el diseño, el stack o el generador—: léelo entero antes de lanzar nada. Es el mismo
   pipeline con el trabajo acotado: a \`keel-go-code\` le pasas la ruta de ese documento; a \`keel-go-tests\`, la ruta
   y **solo su sección 4** (los \`FL-*\` añadidos, cambiados y quitados); \`keel-go-infra\` hace lo de siempre. La
   puntuación, el arbitraje y la calidad **no cambian**. Hasta cerrar, nadie borra \`build/\`.
1. **Fase 1 — en paralelo** (los tres lanzados a la vez, en un único mensaje):
   - \`keel-go-code\`: «Completa el proyecto en \`.\`. Tu proceso, tu alcance y tu criterio de terminado son los de tu
     archivo de agente; \`{{keel:context}}\` es el contexto del repo, no tu lista de tareas.» — hasta \`go build\`,
     \`go vet\`, staticcheck y gofmt limpios y la frontera en verde.
   - \`keel-go-infra\`: «Levanta y valida la infraestructura de \`.\` (\`infra/\`). Déjala arriba y reporta.»
   - \`keel-go-tests\`: «Traduce los escenarios \`FL-*\` de \`specs/validation-scenarios.md\` a pruebas en
     \`tests/integration/\` de \`.\`.» — una función por flujo, en caja negra y **sin leer \`internal/\`**, hasta
     \`bash infra/check-flows.sh\` en verde.

   **Espera a los tres sin hacer nada más.** Gating sobre su bloque estructurado: sin docker/podman
   (\`infra status: PENDIENTE\`) → **detente** (compilado pero NO validado). Infra KO corregible → relanza infra una
   vez. \`code\` con \`compiles: false\` o \`lint: KO\` → relánzalo con sus \`failures\` (máx. 2 ciclos). \`tests\` en KO
   por causa propia → relánzalo; si su KO viene de \`internal/\`, no es suyo. \`blockers\` en cualquiera → detente y
   repórtalo.
2. **Fase 2a — puntuación mecánica (tú, sin agente).** Con los tres en OK: \`bash infra/score-scenarios.sh\`. Compila
   el servicio y las pruebas, arranca por el **humo del arnés** y solo con él en verde ejecuta la suite y compone la
   matriz \`FL-* → OK | FALLO | OMITIDO | NO_EJERC\` desde el XML JUnit de gotestsum. La salida de \`go test\` va a
   \`build/keel-scenarios/run.log\` y la del servidor a \`build/keel-scenarios/server.log\`: no las vuelques en tu
   contexto salvo para diagnosticar. Según el código: \`0\` → fase 3 **sin invocar a nadie**; \`1\` → fase 2b; \`2\` →
   **nada que arbitrar**: con \`BUILD: KO\`, relanza a quien sea dueño de los errores que imprime (\`internal/\` o
   \`cmd/\` → \`keel-go-code\`, \`tests/integration/\` → \`keel-go-tests\`); con el humo rojo, la matriz vacía, la suite
   en rojo por pruebas que no son escenarios o un flujo que no arrancó, relanza \`keel-go-tests\` (no consume cupo)
   — salvo que el defecto esté fuera de \`tests/integration/\` (\`infra/\`, \`go.mod\`): eso es de build, lo corriges tú
   y va al informe como fix del generador.
3. **Fase 2b — arbitraje.** Lanza \`keel-go-validate\` con la matriz y, por cada fallo, su función de flujo y su
   volcado de \`build/keel-failures/\`, y **espera sin ejecutar nada** (una pasada tuya del script le borraría la
   evidencia). Según \`culprit\`: \`code\` → \`keel-go-code\` con **exactamente** sus \`failures\` (con \`evidence\`);
   \`test\` → \`keel-go-tests\`; \`harness\` → \`keel-go-tests\` exigiendo verificación amplia y \`harnessPatches\`;
   \`design\` → detente y propón el cambio. Tras cualquier ciclo de fix se vuelve **siempre** a
   \`bash infra/score-scenarios.sh\`. Mezcla de \`code\` con \`test\`/\`harness\` → **en serie**, primero \`code\`
   (comparten la base de prueba). Cupo de ciclos \`blocking: scoped\`, por número de flujos \`FL-*\`: hasta 10, 2 (tope
   4); de 11 a 20, 3 (tope 5); más de 20, 4 (tope 6). No lo consumen los \`systemic\` ni los \`test\`/\`harness\`.
   Alcanzado el tope, reporta la matriz y detente.
4. **Fase 3 — calidad.** Solo con **todos** los escenarios OK: lanza \`keel-go-quality\` y **espera sin tocar el
   proyecto**. Hace el pase no-conductual con las herramientas de la red del generador (\`go vet\`, staticcheck,
   gofmt, \`go mod tidy -diff\`, govulncheck), comprueba la no-regresión (la suite al 100%) y \`go test ./...\`${
     persistence ? ', y que el esquema sigue siendo la migración de build (`schema: OK`)' : ''
   }. \`status: KO\` o \`scenarios: KO\` → revierte o reporta; nunca hagas commit con algo en rojo. Al terminar, baja
   la infraestructura: \`bash infra/down.sh\`.
5. **Guía de despliegue.** Con todo en verde y **antes** del commit, añade al \`README.md\` una sección
   \`## Despliegue en producción\` con los pasos y la tabla de parámetros obligatorios: todo \`\${VAR}\` sin default de
   \`config/parameters/production/*.yaml\`${persistence ? ', y que el esquema lo aplica goose al arrancar' : ''}.
   No inventes parámetros.
6. **Informe de generación.** Escribe \`INFORME-GENERACION.md\`, que **abre con la matriz final de
   \`infra/score-scenarios.sh\` y su código de salida, literales**, y sigue con lo que es del generador
   (\`harnessPatches\`, fixes de \`infra/\` o de \`go.mod\`, \`culprit: harness\`, \`probes[].verdict: FALSO-NEGATIVO\`),
   cada entrada diciendo de quién es. Y \`design-gaps.yaml\` con **cada** \`designGap\` (schema
   \`design-gaps.schema.json\` de keel-core, con el \`service\` y la \`version\` de \`specs/service.keel.yaml\` y
   \`generator: keel-go\`): \`keel-go check\` lo imprime desde el workspace. Antes de escribir un hueco, búscalo en
   \`specs/gaps.yaml\` y \`specs/decisions.yaml\`: si ya está ahí aceptado (\`state: accepted\`), es una decisión tomada
   por escrito y no se reporta. Sin huecos, no se escribe; sin nada que reportar, dilo en una línea.
7. **Cerrar.** Commit (\`Generado desde specs/${service.name} v${service.version}\`; \`go.sum\` incluido) y resumen:
   matriz, estado de cada agente, ajustes de calidad y huecos del diseño. **En modo evolución**, antes del commit:
   quita de \`pendingMerge\` en \`keel-generated.json\` las rutas que se fusionaron —mientras quede una,
   \`keel-go build --check\` sale en rojo—, borra \`build/keel-refresh/\` entero y añade al resumen el delta aplicado.

## Conocimiento local

- \`{{keel:context}}\` — contexto del repo (diseño, stack, verificación).
- \`{{keel:docs}}/orchestration.md\` — el pipeline: fases, códigos, agentes, handoffs y ciclos.
- \`{{keel:docs}}/architecture.md\` y \`{{keel:docs}}/constitution.md\` — la arquitectura y sus reglas inviolables.
- \`{{keel:docs}}/conventions/\` — las reglas de Go (\`naming.md\`, \`errors.md\`, \`context.md\`, \`concurrency.md\`,
  \`http.md\`, \`testing.md\`), la auditoría de cada handler y dónde va cada cosa (\`flow-fidelity.md\`), las pruebas de
  los escenarios (\`integration-tests.md\`) y la infraestructura (\`infra-validation.md\`).
- \`{{keel:docs}}/framework-errors.md\` y \`{{keel:docs}}/wire-contract.md\` — los \`code\` que pone el generador y cómo
  viaja cada tipo en JSON: contrato, el mismo de los otros tres servidores.${techSkillsBullet}
- Un flujo suelto: \`${flowCommand('Test<Flujo>')}\`; el humo, \`${flowCommand('TestHarnessSmoke')}\`.

**Un solo actor sobre el proyecto, en todo momento.** Mientras un subagente esté vivo, tú no ejecutas nada sobre
este directorio: el script sobrescribe la evidencia que el árbitro lee, el reset vacía la base que otro está
usando, y en Windows el servidor de los flujos retiene su binario. Y el trabajo de un agente **no lo haces tú
aunque sepas hacerlo**: sus restricciones —el de pruebas sin leer \`internal/\`, el árbitro sin corregir, el de
calidad sin cambiar comportamiento— son del agente. Tu trabajo propio es la fase 2a y los pasos 5 a 7.

En corto, de la constitución: el diseño es la única fuente de verdad funcional, los \`code\` de error se copian
exactos, los importes son \`wire.Decimal\` (nunca \`float64\`) con escala y redondeo explícitos, ningún módulo con
licencia no permisiva, ningún archivo con la cabecera de código generado editado a mano, y ante ambigüedad,
diseño > conventions > criterio. No des la generación por terminada con la compilación en rojo o un escenario
fallando.
`;
}
