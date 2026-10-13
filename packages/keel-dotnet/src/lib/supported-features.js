// Frontera declarada del generador: qué del DSL sabe mapear keel-dotnet.
//
// El DSL es más ancho que cualquier generador, y keel-dotnet se construye por incrementos
// (PLAN-KEEL-DOTNET.md): su frontera AVANZA EN CÓDIGO. Cada capa que todavía no genera se rechaza aquí
// con el incremento que la trae, y cada incremento borra su entrada. Lo que no vale es recibir una
// construcción que no se sabe mapear y producir un proyecto como si nada: el diseñador creería que se
// generó y nadie se lo desmentiría.
//
// Dos niveles, como en keel-spring y keel-nest:
//   · `errors` impiden generar — la capa entera falta;
//   · `warnings` dejan seguir — la capa se acepta pero lo que el diseño declara en ella todavía no se
//     emite, y el aviso dice cuándo llega.

/** Capas que aún no se generan, con el incremento del plan que las trae. */
const PENDING_LAYERS = {
  persistence: 'incremento 6 (relacional con EF Core) y 12 (documental)',
  security: 'incremento 8',
  messaging: 'incremento 9',
  'http-clients': 'incremento 11',
  dependencies: 'incremento 11',
  storage: 'incremento 13',
  mail: 'incremento 13',
  payments: 'incremento 13'
};

/** Capas aceptadas cuyo código todavía no se emite: el proyecto arranca, pero sin ellas. */
const ACCEPTED_NOT_EMITTED = {
  api: 'incremento 5 (API REST)'
};

/**
 * Lo que una operación de use-cases puede declarar y keel-dotnet aún no genera: el mensaje y el handler sí
 * salen, el mecanismo no. Se avisa, porque el handler sin él compila y responde como si nada.
 */
const PENDING_OPERATION_FEATURES = [
  { key: 'idempotency', what: 'idempotency (el almacén, la firma del comando y el gate check-idempotency.sh)', increment: 'incremento 10' },
  { key: 'schedule', what: 'schedule (el reloj que dispara la operación)', increment: 'incremento 10' },
  { key: 'cache', what: 'cache (la caché de la consulta)', increment: 'incremento 13' }
];

/**
 * Comprueba el diseño contra la frontera de keel-dotnet. Devuelve { errors, warnings } de strings ya
 * redactados para consola.
 */
export function checkSupportedFeatures(manifest, layers) {
  const errors = [];
  const warnings = [];
  const declared = Object.keys(manifest?.layers ?? {});

  for (const layer of declared) {
    if (PENDING_LAYERS[layer]) {
      errors.push(
        `capa ${layer}: keel-dotnet todavía no la genera (llega en el ${PENDING_LAYERS[layer]} de PLAN-KEEL-DOTNET.md). ` +
          'Genera este diseño con keel-spring o keel-nest, o espera a que keel-dotnet la cubra.'
      );
    }
  }
  for (const layer of declared) {
    if (ACCEPTED_NOT_EMITTED[layer] && layers?.[layer]) {
      warnings.push(
        `capa ${layer}: se acepta, pero keel-dotnet aún no emite su código (llega en el ${ACCEPTED_NOT_EMITTED[layer]}): ` +
          'el proyecto generado arranca y responde a sus sondas, sin nada de esta capa.'
      );
    }
  }
  const operations = Object.entries(layers?.['use-cases']?.operations ?? {});
  for (const feature of PENDING_OPERATION_FEATURES) {
    const names = operations.filter(([, operation]) => operation?.[feature.key] != null).map(([name]) => name);
    if (names.length === 0) continue;
    warnings.push(
      `use-cases: ${names.join(', ')} declara${names.length === 1 ? '' : 'n'} ${feature.what}; keel-dotnet genera el mensaje y el handler, ` +
        `pero no el mecanismo (llega en el ${feature.increment} de PLAN-KEEL-DOTNET.md).`
    );
  }
  return { errors, warnings };
}

/** La telemetría todavía no se genera: se rechaza en el build en vez de estamparla sin efecto. */
export function checkSupportedStack(stack) {
  const errors = [];
  if (stack?.telemetry && stack.telemetry !== 'none') {
    errors.push(
      `telemetry: ${stack.telemetry} — keel-dotnet todavía no genera telemetría (llega en el incremento 14 de PLAN-KEEL-DOTNET.md). ` +
        'Genera sin ella (--telemetry none).'
    );
  }
  return { errors };
}
