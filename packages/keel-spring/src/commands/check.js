// `keel-spring check` — ¿es factible generar este diseño, y qué va a costar?
//
// Se ejecuta DESDE EL WORKSPACE DE DISEÑO y no escribe nada. Existe por una asimetría
// cara: todo lo que este generador sabe decir sobre un diseño lo decía solo `build`, o
// sea cuando el diseño ya se había dado por cerrado, el stack ya se había elegido y el
// proyecto ya estaba sembrado. Un hueco descubierto ahí no cuesta una corrección: cuesta
// volver al YAML, reabrir la sesión de diseño, regenerar los derivados y rehacer el
// camino — y si no se descubre ahí, lo descubre un agente dentro del proyecto, que es un
// ciclo entero de cinco agentes y una suite contra infraestructura real.
//
// Lo que NO es: no es `keel validate --for spring`. keel-core sigue sin saber que Spring
// existe; es el generador el que viene al workspace a opinar, no el núcleo el que
// pregunta por un generador.
//
// Y no se confunde con `build --check`, que opina sobre otra cosa: aquel mira si un
// proyecto YA GENERADO se quedó atrás respecto al generador instalado. Este mira si un
// DISEÑO puede generarse, y corre cuando todavía no hay proyecto ninguno.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import pc from 'picocolors';
import { isKeelWorkspace, resolveServiceDir, loadService, validateService } from 'keel-core';
import { SUPPORTED_DSL } from '../lib/assets.js';
import { checkSupportedFeatures } from '../lib/supported-features.js';
import { planService } from '../scaffold/index.js';
import { DATABASES } from '../lib/stack-catalog.js';

// El archivo que el cierre del pipeline escribe en la raíz del proyecto generado.
const DESIGN_GAPS_FILE = 'design-gaps.yaml';

const bullet = (color, message) => console.log(`  ${pc[color]('•')} ${message}`);

function heading(title) {
  console.log();
  console.log(pc.bold(title));
}

export function check(inputPath, { database = null, strict = false } = {}) {
  const workspace = process.cwd();
  if (!isKeelWorkspace(workspace)) {
    console.error(pc.red('Este directorio no es un workspace Keel (falta schema/service.schema.json).'));
    console.error(`Ejecuta primero ${pc.cyan('keel init')}.`);
    process.exitCode = 1;
    return;
  }
  if (!inputPath) {
    console.error(pc.red('Falta el servicio a comprobar: keel-spring check specs/<servicio>'));
    process.exitCode = 1;
    return;
  }
  if (database && !DATABASES[database]) {
    console.error(pc.red(`✘ El motor '${database}' no está en el catálogo: ${Object.keys(DATABASES).join(', ')}.`));
    process.exitCode = 1;
    return;
  }

  const { dir, error: resolveError } = resolveServiceDir(inputPath);
  if (resolveError) {
    console.error(pc.red(resolveError));
    process.exitCode = 1;
    return;
  }

  const { manifest, layers, errors: loadErrors } = loadService(dir);
  if (!manifest) {
    for (const message of loadErrors) console.error(pc.red(`✘ ${message}`));
    process.exitCode = 1;
    return;
  }
  if (!SUPPORTED_DSL.includes(manifest.keel)) {
    console.error(
      pc.red(`✘ DSL keel ${manifest.keel ?? '(sin declarar)'} no soportado por keel-spring (soporta: ${SUPPORTED_DSL.join(', ')}).`)
    );
    process.exitCode = 1;
    return;
  }

  let blocking = 0;
  let notices = 0;

  // 1 — La frontera del generador: lo que el diseño declara y keel-spring no materializa.
  const features = checkSupportedFeatures(manifest, layers);
  heading('Frontera del generador');
  if (features.errors.length === 0 && features.warnings.length === 0) {
    console.log(pc.dim('  Todo lo que declara el diseño tiene traducción en keel-spring.'));
  }
  for (const message of features.errors) {
    bullet('red', message);
    blocking += 1;
  }
  for (const message of features.warnings) {
    bullet('yellow', message);
    notices += 1;
  }

  // 2 — El diseño contra sí mismo. Estricta, sin --wip: un diseño en progreso no se
  // genera, y esta comprobación existe precisamente para el momento de cerrarlo.
  const validation = validateService(dir, { wip: false });
  heading('Diseño');
  const designProblems = [
    ...validation.loadErrors,
    ...validation.schemaErrors.map(({ file }) => `${file}: no cumple su schema (detalle en keel validate)`),
    ...validation.crossRefErrors,
    ...validation.pending.map((message) => `pendiente: ${message}`),
    ...validation.obligations.errors,
    ...[...validation.obligations.open, ...validation.obligations.stale].map(
      (item) => `${item.id} ${item.scope}: ${item.message}`
    )
  ];
  if (designProblems.length === 0) {
    console.log(pc.dim('  keel validate en verde, decisiones de diseño cerradas.'));
  }
  for (const message of designProblems) {
    bullet('red', message);
    blocking += 1;
  }
  for (const message of validation.warnings) {
    bullet('yellow', message);
    notices += 1;
  }

  // 3 — El modelo: lo que solo se ve al traducir el diseño a código. Aquí viven las
  // familias que han costado una corrida cada una (el rescate sin reloj, la
  // reconciliación con dos entidades en espera, la llamada sin method/path, la clave
  // natural que nombra un campo inexistente). Solo tiene sentido si el diseño es
  // consistente: sobre uno roto, buildModel hablaría de referencias que no existen.
  heading('Traducción a código');
  if (blocking > 0) {
    console.log(pc.dim('  (no se intenta: primero hay que cerrar lo de arriba)'));
  } else {
    let plan;
    try {
      plan = planService({ manifest, layers, workspace, stack: database ? { database } : null });
    } catch (error) {
      bullet('red', `el generador no puede construir el proyecto: ${error.message}`);
      blocking += 1;
    }
    if (plan) {
      if (plan.model.warnings.length === 0) {
        console.log(pc.dim(`  Sin avisos. ${plan.files.length} archivos se generarían sin intervención.`));
      }
      for (const message of plan.model.warnings) {
        bullet('yellow', message);
        notices += 1;
      }
      // El motor no lo elige el diseño, así que un aviso de dialecto puede depender de
      // una decisión que todavía no se ha tomado. Decirlo es la diferencia entre un
      // informe y un informe en el que se puede confiar.
      if (!database && plan.stack.database) {
        console.log(
          pc.dim(
            `  Supuesto: ${plan.stack.database} (default del modelo '${layers.persistence?.default?.model ?? 'relational'}'). ` +
              `Con --database <motor> se comprueba el que vayas a usar.`
          )
        );
      }
    }
  }

  // 4 — Lo que la generación ya encontró y volvía al diseñador a mano.
  //
  // El pipeline de agentes escribe sus `designGaps` en la raíz del proyecto generado, y
  // hasta aquí morían en un informe en prosa: alguien tenía que acordarse de abrirlo y de
  // traerlos de vuelta al YAML. Como este comando corre DESDE el workspace y el proyecto
  // vive en services/<servicio>-<tech>/, leerlo no cuesta ningún comando nuevo.
  //
  // Se cuentan como avisos, no como bloqueos: son propuestas del generador sobre el
  // diseño, y quien decide es el diseñador.
  const gaps = readDesignGaps(workspace, manifest, layers);
  if (gaps.entries.length > 0 || gaps.error) {
    heading('Huecos que reportó la generación');
    if (gaps.error) {
      bullet('yellow', gaps.error);
      notices += 1;
    }
    if (gaps.stale) {
      console.log(
        pc.dim(
          `  Son de la v${gaps.version} y el diseño va por v${manifest.service?.version}: reléelos antes de darlos por vigentes.`
        )
      );
    }
    for (const gap of gaps.entries) {
      const donde = gap.unit ? `${gap.layer}.${gap.unit}` : gap.layer;
      bullet('yellow', `${pc.cyan(donde)} [${gap.kind}] ${gap.proposal}`);
      notices += 1;
    }
  }

  // 5 — El veredicto.
  heading('Resumen');
  if (blocking > 0) {
    console.log(pc.red(`  ${blocking} bloqueo(s) y ${notices} aviso(s). El diseño todavía no es generable.`));
    process.exitCode = 1;
    return;
  }
  if (notices > 0 && strict) {
    console.log(pc.red(`  ${notices} aviso(s), y --strict los trata como bloqueo.`));
    process.exitCode = 1;
    return;
  }
  console.log(
    notices > 0
      ? pc.yellow(`  Factible con ${notices} aviso(s). Cada uno dice qué se genera en su lugar: léelos antes de cerrar.`)
      : pc.green('  Factible, sin avisos.')
  );
  console.log(pc.dim(`  Siguiente paso: ${pc.cyan(`keel-spring build ${path.relative(workspace, dir).split(path.sep).join('/')}`)}`));
}


/**
 * Los `designGaps` que dejó la última generación de este servicio, si el proyecto existe.
 *
 * Tolerante a propósito: un archivo ausente, mal formado o de otra versión no puede
 * impedir que se compruebe el diseño — lo que aporta es contexto, no veredicto. Un YAML
 * roto se dice en voz alta y se sigue; callarlo dejaría al diseñador creyendo que la
 * generación no encontró nada.
 */
function readDesignGaps(workspace, manifest, layers) {
  const empty = { entries: [], stale: false, version: null, error: null };
  const service = manifest?.service?.name;
  if (!service) return empty;

  const file = path.join(workspace, 'services', `${service}-spring`, DESIGN_GAPS_FILE);
  if (!fs.existsSync(file)) return empty;

  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ...empty, error: `${DESIGN_GAPS_FILE}: YAML inválido — ${error.message}` };
  }
  if (!doc || !Array.isArray(doc.gaps)) return empty;

  return {
    entries: doc.gaps,
    version: doc.version ?? null,
    stale: Boolean(doc.version) && doc.version !== manifest.service?.version,
    error: null
  };
}
