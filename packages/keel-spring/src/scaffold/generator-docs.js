// .claude/ del proyecto generado: skill propia orquestadora + agentes de la
// orquestación + conventions completas + solo las skills por tecnología del
// stack elegido (keel-spring-<tech>, hermanas de la orquestadora en
// .claude/skills/). Junto con el CLAUDE.md de la raíz y el snapshot de specs/,
// hace el repo autosuficiente: quien lo clone puede finalizar la generación sin
// el workspace Keel. Misma regeneración segura que el resto del scaffolding.

import path from 'node:path';
import { assetsDir, SKILL } from '../lib/assets.js';

const generatorDir = path.join(assetsDir, 'generators', 'spring');
const skillDir = `.claude/skills/${SKILL}`;

const CONVENTIONS = ['mapping.md', 'project-layout.md', 'infra-validation.md'];

// Subagentes de la orquestación (misma fuente que instala build en el workspace).
const AGENTS = ['keel-spring-code.md', 'keel-spring-infra.md', 'keel-spring-validate.md'];

// Skills por tecnología aplicables al stack resuelto (mismo mapeo que
// skills/README.md): una por categoría elegida; minio/s3 comparten
// keel-spring-s3 y redis/valkey keel-spring-redis.
export function stackSkills(model) {
  const { layersPresent, stack } = model;
  const skills = [];
  if (layersPresent.messaging && stack.broker) skills.push(`keel-spring-${stack.broker}`);
  if (layersPresent.storage && stack.storage) skills.push('keel-spring-s3');
  if (stack.cache) skills.push('keel-spring-redis');
  if (stack.auth && stack.auth !== 'none') skills.push(`keel-spring-${stack.auth}`);
  return skills;
}

export function generate(model) {
  const files = [{ path: `${skillDir}/SKILL.md`, content: skillMd(model) }];
  for (const name of AGENTS) {
    files.push({
      path: `.claude/agents/${name}`,
      sourceFile: path.join(assetsDir, '.claude', 'agents', name)
    });
  }
  for (const name of CONVENTIONS) {
    files.push({
      path: `${skillDir}/conventions/${name}`,
      sourceFile: path.join(generatorDir, 'conventions', name)
    });
  }
  for (const name of stackSkills(model)) {
    files.push({
      path: `.claude/skills/${name}/SKILL.md`,
      sourceFile: path.join(generatorDir, 'skills', name, 'SKILL.md')
    });
  }
  return files;
}

// Skill del proyecto: delgada a propósito. El proceso especializado (capas
// declaradas, stack, verificación) vive en el CLAUDE.md de la raíz; aquí el
// arranque, las rutas locales y la orquestación de los subagentes.
function skillMd(model) {
  const { service } = model;
  const techSkills = stackSkills(model);
  const techSkillsBullet = techSkills.length
    ? `\n- Skills por tecnología (\`.claude/skills/\`, hermanas de esta) — guía de implementación por tecnología, instaladas solo las del stack de \`keel-stack.json\`: ${techSkills.map((s) => `\`${s}\``).join(', ')}.`
    : '';
  return `---
name: ${SKILL}
description: Completa la generación de este microservicio Spring Boot a partir del diseño Keel incluido en specs/, orquestando los subagentes de código, infraestructura y validación funcional. Usar dentro de este proyecto.
---

# /${SKILL} — completar ${service.projectName}

Este proyecto fue generado por \`keel-spring build\` desde \`specs/${service.name}\` v${service.version} y es **autosuficiente**: todo lo necesario para finalizar la generación está en este repo. Tú eres el **orquestador**: el trabajo lo hacen los subagentes de \`.claude/agents/\`.

## Proceso

1. **Fase 1 — en paralelo** (dos Task en un único mensaje):
   - \`keel-spring-code\`: «Completa el proyecto en \`.\` (esta raíz). Sigue su \`CLAUDE.md\`.» — TODOs, lógica de negocio, adaptadores del stack y tests hasta \`./gradlew test\` en verde.
   - \`keel-spring-infra\`: «Levanta y valida la infraestructura de \`.\` (\`infra/docker-compose.yaml\`). Déjala arriba y reporta.»

   Espera a ambos. Sin docker/podman disponibles → continúa solo con código, omite la fase 2 y reporta la validación funcional como PENDIENTE. Infra KO corregible → relanza \`keel-spring-infra\` una vez con el diagnóstico. Tests en rojo → relanza \`keel-spring-code\` con el reporte (máx. 2 ciclos).
2. **Fase 2 — validación funcional.** Solo con código OK e infra OK: lanza \`keel-spring-validate\` con la raíz \`.\` y el reporte de infraestructura; ejecuta los escenarios \`FL-*\` de \`specs/validation-scenarios.md\` contra el servidor real. Escenarios en FALLO → ciclo \`keel-spring-code\` → \`keel-spring-validate\` (máx. 2). Al terminar, baja la infraestructura (\`docker compose -f infra/docker-compose.yaml down\`, o \`podman compose\`).
3. **Cerrar.** Commit (\`Generado desde specs/${service.name} v${service.version}\`) y resumen: decisiones, matriz escenario → resultado, estado de cada agente y huecos del diseño detectados.

## Conocimiento local

El \`CLAUDE.md\` de la raíz contiene el contexto completo (fuente de verdad del diseño, stack elegido, orden capa por capa y verificación); los agentes lo consumen. Este directorio aporta el apoyo:

- \`specs/\` (raíz del proyecto) — snapshot del diseño Keel (manifiesto + un artefacto por capa + \`validation-scenarios.md\`). Si trabajas dentro del workspace Keel, el canónico es \`../../specs/${service.name}/\`; el snapshot se refresca en cada \`keel-spring build\`.
- \`conventions/\` — mapeo DSL → código (\`mapping.md\`, síguelo estrictamente), estructura del proyecto (\`project-layout.md\`) y sondeo de infraestructura (\`infra-validation.md\`).${techSkillsBullet}

Reglas: el diseño es la única fuente de verdad funcional; los \`code\` de error y nombres de evento se copian exactos; ante ambigüedad, diseño > conventions > tu criterio (documentado en el README). No des la generación por terminada con tests o escenarios fallando.
`;
}
