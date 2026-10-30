// Frontera declarada del generador: qué del DSL sabe mapear keel-go.
//
// El DSL es más ancho que cualquier generador, y keel-go se construye por incrementos (PLAN-KEEL-GO.md):
// su frontera AVANZA EN CÓDIGO. Cada capa que todavía no genera se rechaza aquí con el incremento que la
// trae, y cada incremento borra su entrada. Lo que no vale es recibir una construcción que no se sabe
// mapear y producir un proyecto como si nada: el diseñador creería que se generó y nadie se lo desmentiría.
//
// Dos niveles, como en los otros tres generadores:
//   · `errors` impiden generar — la capa entera falta;
//   · `warnings` dejan seguir — la capa se acepta pero lo que el diseño declara en ella todavía no se
//     emite, y el aviso dice cuándo llega.

import { buildModel } from '@keel-system/keel-core/gen/model';
import { resolveStack } from '@keel-system/keel-core/gen/stack';
import { persistedMembers } from '@keel-system/keel-core/gen';
import { GO_PROJECTION } from './go-projection.js';

/** Capas que aún no se generan, con el incremento del plan que las trae. */
const PENDING_LAYERS = {
  security: 'incremento 8',
  messaging: 'incremento 9',
  'http-clients': 'incremento 11',
  dependencies: 'incremento 11',
  storage: 'incremento 13',
  mail: 'incremento 13',
  payments: 'incremento 13'
};

/**
 * Los motores sobre los que keel-go genera la persistencia: PostgreSQL y MySQL (tramo 6d). MongoDB llega en el incremento 12;
 * MariaDB, SQL Server y Oracle se quedan fuera hasta que una red los mida, como en keel-nest y keel-dotnet.
 */
export const SUPPORTED_DATABASES = ['postgresql', 'mysql'];

/** ¿Declara el diseño persistencia DOCUMENTAL? Llega en el incremento 12. */
function documentPersistence(layers) {
  return layers?.persistence?.default?.model === 'document';
}

/**
 * Las capas que keel-go todavía rechaza en ESTE diseño: las pruebas de paridad lo comparan sin ellas. La persistencia
 * solo cuando es documental: la relacional se genera desde el incremento 6.
 */
export function pendingLayers(layers = null) {
  return [...Object.keys(PENDING_LAYERS), ...(documentPersistence(layers) ? ['persistence'] : [])];
}

/**
 * Lo que una operación puede declarar y keel-go todavía no genera: el mensaje y el handler salen, pero no el
 * mecanismo. Se avisa por operación, nombrándolas, como keel-dotnet en su incremento 4.
 */
const PENDING_OPERATION_FEATURES = [
  { key: 'idempotency', what: 'idempotency (el almacén, la firma del comando y el gate check-idempotency.sh)', increment: 'incremento 10' },
  { key: 'schedule', what: 'schedule (el reloj que dispara la operación)', increment: 'incremento 10' },
  { key: 'cache', what: 'cache (la caché de la consulta)', increment: 'incremento 13' }
];

/**
 * Comprueba el diseño contra la frontera de keel-go. Devuelve { errors, warnings } de strings ya redactados
 * para consola.
 */
export function checkSupportedFeatures(manifest, layers) {
  const errors = [];
  const warnings = [];
  const declared = Object.keys(manifest?.layers ?? {});

  for (const layer of declared) {
    if (PENDING_LAYERS[layer]) {
      errors.push(
        `capa ${layer}: keel-go todavía no la genera (llega en el ${PENDING_LAYERS[layer]} de PLAN-KEEL-GO.md). ` +
          'Genera este diseño con keel-spring, keel-nest o keel-dotnet, o espera a que keel-go la cubra.'
      );
    }
  }
  if (declared.includes('persistence') && documentPersistence(layers)) {
    errors.push(
      'capa persistence: keel-go todavía no genera la persistencia documental (llega en el incremento 12 de PLAN-KEEL-GO.md). ' +
        'Genera este diseño con keel-spring, keel-nest o keel-dotnet, o espera a que keel-go la cubra.'
    );
  } else if (declared.includes('persistence')) {
    errors.push(...unmeasuredShapes(manifest, layers));
  }
  const operations = Object.entries(layers?.['use-cases']?.operations ?? {});
  for (const feature of PENDING_OPERATION_FEATURES) {
    const names = operations.filter(([, operation]) => operation?.[feature.key] != null).map(([name]) => name);
    if (names.length === 0) continue;
    // La idempotencia de petición se adelantó al incremento 7 sobre la persistencia relacional: sale el registro, la
    // firma y la cabecera. Queda lo que necesita el reloj y el gate.
    if (feature.key === 'idempotency' && declared.includes('persistence') && !documentPersistence(layers)) {
      warnings.push(
        `use-cases: ${names.join(', ')} declara${names.length === 1 ? '' : 'n'} idempotency; keel-go genera el registro, la firma del ` +
          'mensaje y la cabecera, pero no la purga de las claves caducadas ni el gate check-idempotency.sh (llegan en el incremento 10 de PLAN-KEEL-GO.md).'
      );
      continue;
    }
    warnings.push(
      `use-cases: ${names.join(', ')} declara${names.length === 1 ? '' : 'n'} ${feature.what}; keel-go genera el mensaje y el handler, ` +
        `pero no el mecanismo (llega en el ${feature.increment} de PLAN-KEEL-GO.md).`
    );
  }
  return { errors, warnings };
}

/**
 * Las formas del dominio que el adaptador relacional no persiste, con su motivo: ninguna fixture con persistencia las
 * declara, así que su mapeo no lo mediría ninguna red (keel-dotnet las deja como TODO del agente; aquí no compilaría).
 * Son la relación interna a-uno SIN vuelta (la FK la pondría la dueña sobre la hija), la many-to-many dentro del
 * agregado y el value object persistido con otro value object dentro o con un campo opcional. Se leen del MODELO, que
 * es quien sabe qué relación es interna.
 */
function unmeasuredShapes(manifest, layers) {
  let model;
  try {
    model = buildModel({ manifest, layers, stack: resolveStack(null, layers), projection: GO_PROJECTION });
  } catch {
    // Un diseño que no da modelo lo rechazan las otras puertas, con su mensaje.
    return [];
  }
  const why = 'ninguna fixture con persistencia la declara: sin red que mida su mapeo';
  const errors = [];
  for (const entity of model.entities.filter((candidate) => candidate.persisted)) {
    for (const member of persistedMembers(model, entity)) {
      if (member.kind === 'relationOne' && !member.relation.backReference) {
        errors.push(`persistence: ${entity.name}.${member.name} es una relación interna a-uno sin vuelta; keel-go no la persiste (${why}).`);
      } else if (member.kind === 'relationMany' && member.relation.cardinality === 'many-to-many') {
        errors.push(`persistence: ${entity.name}.${member.name} es una many-to-many dentro del agregado; keel-go no la persiste (${why}).`);
      } else if (member.kind === 'vo' || (member.kind === 'elementCollection' && member.element.kind === 'vo')) {
        const vo = model.valueObjects.find((candidate) => candidate.name === member.field.namedType);
        for (const sub of vo?.fields ?? []) {
          if (sub.kind === 'composite' || !sub.required) {
            errors.push(`persistence: ${entity.name}.${member.name} guarda ${vo.name}, que lleva ${sub.kind === 'composite' ? 'otro value object' : 'un campo opcional'} (${sub.name}); keel-go no lo aplana (${why}).`);
          }
        }
      }
    }
  }
  return errors;
}

/** Lo que el stack pide y keel-go no genera (un motor sin medir, la telemetría): se rechaza en el build en vez de estamparlo sin efecto. */
export function checkSupportedStack(stack) {
  const errors = [];
  // El motor solo importa con persistencia: sin ella, el cuestionario no lo pregunta y no se estampa.
  if (stack?.database && !SUPPORTED_DATABASES.includes(stack.database)) {
    errors.push(
      `database: ${stack.database} — keel-go genera la persistencia sobre ${SUPPORTED_DATABASES.join(', ')} (MongoDB llega en el ` +
        'incremento 12 de PLAN-KEEL-GO.md; MariaDB, SQL Server y Oracle, sin medir en ninguna red). Elige uno de ellos, o genera este diseño con keel-spring, keel-nest o keel-dotnet.'
    );
  }
  if (stack?.telemetry && stack.telemetry !== 'none') {
    errors.push(
      `telemetry: ${stack.telemetry} — keel-go todavía no genera telemetría (llega en el incremento 14 de PLAN-KEEL-GO.md). ` +
        'Genera sin ella (--telemetry none).'
    );
  }
  return { errors };
}
