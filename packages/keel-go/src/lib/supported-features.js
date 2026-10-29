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

/** Capas que aún no se generan, con el incremento del plan que las trae. */
const PENDING_LAYERS = {
  persistence: 'incremento 6 (relacional sobre database/sql) y 12 (documental)',
  security: 'incremento 8',
  messaging: 'incremento 9',
  'http-clients': 'incremento 11',
  dependencies: 'incremento 11',
  storage: 'incremento 13',
  mail: 'incremento 13',
  payments: 'incremento 13'
};

/** Las capas que keel-go todavía rechaza: las pruebas de paridad comparan el diseño sin ellas. */
export function pendingLayers() {
  return Object.keys(PENDING_LAYERS);
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
  const operations = Object.entries(layers?.['use-cases']?.operations ?? {});
  for (const feature of PENDING_OPERATION_FEATURES) {
    const names = operations.filter(([, operation]) => operation?.[feature.key] != null).map(([name]) => name);
    if (names.length === 0) continue;
    warnings.push(
      `use-cases: ${names.join(', ')} declara${names.length === 1 ? '' : 'n'} ${feature.what}; keel-go genera el mensaje y el handler, ` +
        `pero no el mecanismo (llega en el ${feature.increment} de PLAN-KEEL-GO.md).`
    );
  }
  return { errors, warnings };
}

/** La telemetría todavía no se genera: se rechaza en el build en vez de estamparla sin efecto. */
export function checkSupportedStack(stack) {
  const errors = [];
  if (stack?.telemetry && stack.telemetry !== 'none') {
    errors.push(
      `telemetry: ${stack.telemetry} — keel-go todavía no genera telemetría (llega en el incremento 14 de PLAN-KEEL-GO.md). ` +
        'Genera sin ella (--telemetry none).'
    );
  }
  return { errors };
}
