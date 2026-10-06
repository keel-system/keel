// Frontera declarada del generador: qué del DSL sabe mapear keel-nest.
//
// El DSL es más ancho que cualquier generador, y keel-nest se construye por incrementos
// (PLAN-KEEL-NEST.md): su frontera AVANZA EN CÓDIGO. Cada capa que todavía no genera se rechaza
// aquí con el incremento que la trae, y cada incremento borra su entrada. Lo que no vale es
// recibir una construcción que no se sabe mapear y producir un proyecto como si nada: el
// diseñador creería que se generó y nadie se lo desmentiría.
//
// Hay dos niveles, como en keel-spring:
//   · `errors` impiden generar — la capa entera falta;
//   · `warnings` dejan seguir — la capa se acepta pero lo que el diseño declara en ella todavía
//     no se emite, y el aviso dice cuándo llega.

/** Capas que aún no se generan, con el incremento del plan que las trae. */
const PENDING_LAYERS = {
  persistence: 'incremento 6 (relacional con TypeORM) y 12 (documental)',
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
  domain: 'incremento 4 (dominio y aplicación)',
  'use-cases': 'incremento 4 (dominio y aplicación)',
  api: 'incremento 5 (API REST)'
};

/**
 * Comprueba el diseño contra la frontera de keel-nest. Devuelve { errors, warnings } de strings
 * ya redactados para consola.
 */
export function checkSupportedFeatures(manifest, layers) {
  const errors = [];
  const warnings = [];
  const declared = Object.keys(manifest?.layers ?? {});

  for (const layer of declared) {
    if (PENDING_LAYERS[layer]) {
      errors.push(
        `capa ${layer}: keel-nest todavía no la genera (llega en el ${PENDING_LAYERS[layer]} de PLAN-KEEL-NEST.md). ` +
          'Genera este diseño con keel-spring, o espera a que keel-nest la cubra.'
      );
    }
  }
  for (const layer of declared) {
    if (ACCEPTED_NOT_EMITTED[layer] && layers?.[layer]) {
      warnings.push(
        `capa ${layer}: se acepta, pero keel-nest aún no emite su código (llega en el ${ACCEPTED_NOT_EMITTED[layer]}): ` +
          'el proyecto generado arranca y responde a sus sondas, sin nada de esta capa.'
      );
    }
  }
  return { errors, warnings };
}

/** La telemetría todavía no se genera: se rechaza en el build en vez de estamparla sin efecto. */
export function checkSupportedStack(stack) {
  const errors = [];
  if (stack?.telemetry && stack.telemetry !== 'none') {
    errors.push(
      `telemetry: ${stack.telemetry} — keel-nest todavía no genera telemetría (llega en el incremento 14 de PLAN-KEEL-NEST.md). ` +
        'Genera sin ella (--telemetry none).'
    );
  }
  return { errors };
}
