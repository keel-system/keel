// .claude/ del proyecto generado: CLAUDE.md + architecture.md + constitution.md
// + orchestration.md de primer nivel, skill propia orquestadora (la ÚNICA: no se
// siembra ninguna en el workspace de diseño) + agentes de la orquestación +
// conventions completas + solo las skills por tecnología del stack elegido
// (keel-spring-<tech>, hermanas de la orquestadora en .claude/skills/). Cada
// skill por tecnología se instala como directorio completo (SKILL.md +
// references/ que el agente lee bajo demanda). Junto con el snapshot de
// specs/, hace el repo autosuficiente: quien lo clone puede finalizar la
// generación sin el workspace Keel. Misma regeneración segura que el resto
// del scaffolding.

import fs from 'node:fs';
import path from 'node:path';
import { assetsDir, SKILL } from '../lib/assets.js';

const generatorDir = path.join(assetsDir, 'generators', 'spring');
const skillDir = `.claude/skills/${SKILL}`;

const CONVENTIONS = [
  'mapping.md',
  'project-layout.md',
  'infra-validation.md',
  'flow-fidelity.md',
  'domain-modeling.md',
  'domain-services.md',
  'dependencies.md',
  'virtual-threads.md'
];

// Subagentes de la orquestación (misma fuente que instala build en el workspace).
const AGENTS = ['keel-spring-code.md', 'keel-spring-infra.md', 'keel-spring-validate.md', 'keel-spring-quality.md'];

// Skills por tecnología aplicables al servicio (mismo mapeo que skills/README.md):
// una por categoría de stack elegida (minio/s3 comparten keel-spring-s3,
// redis/valkey keel-spring-redis, los seis dialectos de BD keel-spring-database
// —tuning/validación: el código JPA lo genera build—) más las gateadas por
// presencia de capa, no por stack: keel-spring-httpclient acompaña a la capa
// http-clients (integraciones HTTP salientes, no es una elección de stack).
export function stackSkills(model) {
  const { layersPresent, stack } = model;
  const skills = [];
  if (layersPresent.persistence && stack.database) skills.push('keel-spring-database');
  if (layersPresent.messaging && stack.broker) skills.push(`keel-spring-${stack.broker}`);
  if (layersPresent.storage && stack.storage) skills.push('keel-spring-s3');
  if (layersPresent.httpClients) skills.push('keel-spring-httpclient');
  if (stack.cache) skills.push('keel-spring-redis');
  if (stack.auth && stack.auth !== 'none') skills.push(`keel-spring-${stack.auth}`);
  return skills;
}

export function generate(model) {
  const files = [
    { path: `${skillDir}/SKILL.md`, content: skillMd(model) },
    { path: '.claude/architecture.md', sourceFile: path.join(generatorDir, 'architecture.md') },
    { path: '.claude/constitution.md', sourceFile: path.join(generatorDir, 'constitution.md') },
    { path: '.claude/orchestration.md', sourceFile: path.join(generatorDir, 'orchestration.md') }
  ];
  for (const name of AGENTS) {
    files.push({
      path: `.claude/agents/${name}`,
      sourceFile: path.join(assetsDir, '.claude', 'agents', name)
    });
  }
  for (const name of CONVENTIONS) {
    files.push({
      path: `.claude/conventions/${name}`,
      sourceFile: path.join(generatorDir, 'conventions', name)
    });
  }
  for (const name of stackSkills(model)) {
    files.push(...skillFiles(name));
  }
  return files;
}

// Archivos de una skill por tecnología: directorio completo (SKILL.md +
// references/), enumerado con recursión manual (engines declara Node >=18 y
// readdirSync({ recursive }) exige 18.17+). Rutas destino en POSIX, como el
// resto del scaffolding.
function skillFiles(name) {
  const skillRoot = path.join(generatorDir, 'skills', name);
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        files.push({ path: `.claude/skills/${name}/${rel}`, sourceFile: path.join(dir, entry.name) });
      }
    }
  };
  walk(skillRoot, '');
  return files;
}

// Skill del proyecto: la única del generador, y delgada a propósito. El proceso
// especializado (capas declaradas, stack, verificación) vive en .claude/CLAUDE.md
// y el detalle de gating en .claude/orchestration.md; aquí el arranque, las rutas
// locales (siempre relativas a esta raíz) y la orquestación de los subagentes.
function skillMd(model) {
  const { service } = model;
  const techSkills = stackSkills(model);
  const techSkillsBullet = techSkills.length
    ? `\n- Skills por tecnología (\`.claude/skills/\`, hermanas de esta) — guía de implementación, instaladas solo las aplicables a este servicio (del stack de \`keel-stack.json\` y de las capas de diseño presentes): ${techSkills.map((s) => `\`${s}\``).join(', ')}. Cada una trae \`references/\` (configuración, implementación, troubleshooting) que se leen bajo demanda según la tabla de su SKILL.md.`
    : '';
  return `---
name: ${SKILL}
description: Completa la generación de este microservicio Spring Boot a partir del diseño Keel incluido en specs/, orquestando los subagentes de código, infraestructura, validación funcional y calidad. Usar dentro de este proyecto, sin argumentos.
---

# /${SKILL} — completar ${service.projectName}

Este proyecto fue generado por \`keel-spring build\` desde \`specs/${service.name}\` v${service.version} y es **autosuficiente**: todo lo necesario para finalizar la generación está en este repo. Se invoca **sin argumentos, con el cwd en esta raíz**; todas las rutas de abajo son relativas a ella. Tú eres el **orquestador**: el trabajo lo hacen los subagentes de \`.claude/agents/\`.

## Proceso

0. **Precondiciones.** \`specs/\` es un snapshot del diseño que \`keel-spring build\` ya validó (schemas, referencias cruzadas y frontera del generador) y que refresca en cada build: no lo revalides ni lo edites — el canónico es \`specs/${service.name}/\` del workspace de diseño, y un cambio funcional se hace allí y se re-ejecuta \`keel-spring build specs/${service.name}\`. Comprueba solo dos cosas antes de arrancar: que existe \`specs/validation-scenarios.md\` (sin escenarios no hay contra qué validar el servidor: detente y pide cerrar el diseño con \`/keel-design\`) y que esta raíz es un repo git (si no, \`git init -b main\`). El stack ya lo eligió el diseñador y está en \`keel-stack.json\`: respétalo; para cambiarlo hay que borrarlo y re-ejecutar \`keel-spring build --force\` en el workspace. Solo pregunta al usuario decisiones que el scaffolding no cubre, y regístralas en el \`README.md\`.
1. **Fase 1 — en paralelo** (dos Task en un único mensaje):
   - \`keel-spring-code\`: «Completa el proyecto en \`.\` (esta raíz). Sigue su \`CLAUDE.md\`.» — TODOs, lógica de negocio y adaptadores del stack hasta \`./gradlew build -x test\` en verde. **Sin pruebas unitarias**: no las escribe ni las ejecuta.
   - \`keel-spring-infra\`: «Levanta y valida la infraestructura de \`.\` (\`infra/docker-compose.yaml\`). Déjala arriba y reporta.»

   Espera a ambos. Cada agente cierra su reporte con un bloque estructurado (\`status\`, \`blockers\`, \`failures\`…): el gating se decide sobre esos campos. Sin docker/podman (\`infra status: PENDIENTE\`) → **detente**: sin infraestructura no hay validación end-to-end y, al no haber suite unitaria, la generación queda sin red de seguridad; reporta el código como compilado pero NO validado e indica cómo levantar la infraestructura. Infra KO corregible → relanza \`keel-spring-infra\` una vez con el diagnóstico. \`code\` con \`compiles: false\` → relanza \`keel-spring-code\` pasándole sus \`failures\` (máx. 2 ciclos). \`blockers\` no vacío en cualquiera → detente y repórtalo al usuario.
2. **Fase 2 — validación funcional (el gate de la generación: exige el 100% de los escenarios en OK).** Solo con código OK e infra OK: lanza \`keel-spring-validate\` con la raíz \`.\` y el reporte de infraestructura; ejecuta los flujos \`FL-*\` de \`specs/validation-scenarios.md\` contra el servidor real, secuencialmente y reseteando datos antes de cada flujo (\`bash infra/reset-db.sh\`; los ciclos de fix re-resetean). Escenarios en FALLO → ciclo \`keel-spring-code\` → \`keel-spring-validate\` pasando **exactamente** sus \`failures\` como evidencia. **Cómo contar los ciclos**: el cupo cuenta solo los ciclos por fallos puntuales (\`blocking: scoped\`) y **escala con el número de flujos \`FL-*\`** del diseño — hasta 10 flujos, 2 ciclos (tope duro 4); de 11 a 20, 3 (tope 5); más de 20, 4 (tope 6). Un ciclo que cerró un **bloqueo sistémico** (\`blocking: systemic\`: una causa transversal —seguridad, arranque, infraestructura— que impedía ejercitar prácticamente cualquier escenario) **no consume cupo**, porque destrabarlo es lo que hace visibles por primera vez los fallos de negocio finos. Alcanzado el tope que aplique, reporta la matriz y detente. \`blockers\` no vacío, o un escenario que contradice el diseño → el hueco es del diseño: detente y propón el cambio a los artefactos, no acomodes el código en silencio. Detalle completo en \`.claude/orchestration.md\`.
3. **Fase 3 — calidad${model.layersPresent.persistence ? ' + baseline de migraciones' : ''} + re-validación.** Solo con **todos** los escenarios OK: lanza \`keel-spring-quality\` sobre la raíz \`.\`. Aplica solo cambios no-conductuales y cierra con \`./gradlew build -x test\` en verde; si reporta \`status: KO\`, revierte/reporta — nunca hagas commit con la compilación en rojo.${model.layersPresent.persistence ? ' El mismo agente produce el **baseline de migraciones** (`db/migration/V1__baseline_schema.sql`, exportado de las entidades ya finales con `infra/export-schema.sh`) y lo prueba arrancando con `PROFILE=local,migrations` sobre una BD sin esquema: exige `baseline: OK`, porque sin él el servicio compila y valida pero no es desplegable (en production Hibernate solo valida el esquema). `baseline: KO` → relánzalo una vez con su error exacto.' : ''} Después, con la infraestructura aún arriba, relanza \`keel-spring-validate\` una vez para confirmar que la matriz sigue 100% OK (única comprobación de que la higiene no cambió comportamiento); si falla, revierte el pase de calidad y reporta. Consolida sus \`remaining\` en el resumen. Al terminar, baja la infraestructura (\`docker compose -f infra/docker-compose.yaml down\`, o \`podman compose\`).
4. **Guía de despliegue productivo.** Con la re-validación en 100% OK y **antes** del commit, completa la sección \`## Despliegue en producción\` del \`README.md\` para que enumere todos los pasos y todos los parámetros necesarios para levantar el servidor en producción. El scaffolding dejó un baseline (pasos + tabla de parámetros obligatorios); tu trabajo es reconciliarlo con lo que los agentes realmente cablearon: si al implementar los adaptadores del stack (publishers/listeners del broker, adaptador de storage, auth saliente de los clientes HTTP) aparecieron parámetros nuevos, añádelos. Fuente de verdad: \`src/main/resources/parameters/production/*.yaml\` (todo \`\${VAR}\` sin default es obligatorio) + \`keel-stack.json\` + el código final. No inventes parámetros: si un \`\${VAR}\` no aparece en \`parameters/production/\`, no va en la guía.
5. **Cerrar.** Commit (\`Generado desde specs/${service.name} v${service.version}\`) y resumen: decisiones, matriz escenario → resultado, estado de cada agente, ajustes de calidad aplicados/pendientes y huecos del diseño detectados (\`designGaps\` consolidados).

## Conocimiento local

\`.claude/CLAUDE.md\` contiene el contexto completo (fuente de verdad del diseño, stack elegido, orden capa por capa y verificación); los agentes lo consumen. Este directorio aporta el apoyo:

- \`.claude/orchestration.md\` — el pipeline completo: fases, diagrama, responsabilidades y límites de cada agente, tabla de handoffs y reglas de conteo de ciclos. Consúltalo ante cualquier duda de gating.
- \`.claude/architecture.md\` — arquitectura hexagonal + CQRS y función de cada paquete. Léelo antes de tocar código si no conoces ya la estructura.
- \`.claude/constitution.md\` — reglas inviolables (frontera hexagonal, transaccionalidad, contratos públicos, precisión numérica). Ninguna implementación puede romperlas.
- \`specs/\` (raíz del proyecto) — snapshot del diseño Keel (manifiesto + un artefacto por capa + \`validation-scenarios.md\`), refrescado en cada \`keel-spring build\`. El canónico es \`specs/${service.name}/\` del workspace de diseño: los cambios funcionales se hacen allí y se re-ejecuta el build, nunca se editan aquí.
- \`.claude/conventions/\` — mapeo DSL → código (\`mapping.md\`, síguelo estrictamente), estructura del proyecto (\`project-layout.md\`), sondeo y reset de infraestructura (\`infra-validation.md\`), auditoría de fidelidad al flujo (\`flow-fidelity.md\`), modelado del dominio (\`domain-modeling.md\`: agregados ricos, invariantes y reparto de la validación) y guías de handler (\`domain-services.md\`, \`virtual-threads.md\`).${techSkillsBullet}

Reglas inviolables completas en \`.claude/constitution.md\`; en corto: el diseño es la única fuente de verdad funcional, los \`code\` de error y nombres de evento se copian exactos, todo importe o magnitud científica se opera con \`BigDecimal\` con escala y redondeo explícitos (nunca \`double\`/\`float\`; comparaciones con \`compareTo\`), y ante ambigüedad, diseño > conventions > tu criterio (documentado en el README). No des la generación por terminada con la compilación en rojo o algún escenario fallando. Las pruebas unitarias no forman parte de este flujo: son un proceso independiente y posterior a la validación del diseñador.
`;
}
