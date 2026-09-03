// ¿Puede compilar el `main` recién generado, antes de que el agente escriba nada?
//
// Durante mucho tiempo la respuesta se dio por «no» y `compile-check` compilaba solo el
// source set `integrationTest`. Es falso en general: build deja TODOs, pero un stub que
// termina en `throw new UnsupportedOperationException(...)` COMPILA —un `throw` satisface
// cualquier tipo de retorno—, así que los huecos del agente no impiden javac por sí solos.
//
// Lo que sí lo impide es un hueco de otra clase: código generado que LLAMA a un método que
// el agente todavía tiene que escribir. Hoy hay uno solo, y es la RÉPLICA: el projector que
// emite `dependencies.js` invoca `<Entidad>.projectionOf(...)` y `existing.applySnapshot(...)`,
// que el dominio no trae porque no tiene setters y la política de proyección es del agente.
// Ahí javac dice `cannot find symbol` y tiene razón.
//
// La diferencia importa porque el reclamo —el `@Modifying` con su JPQL, el `findAndModify`
// con su `Criteria`— vive en `main` y en ninguna otra parte. Mientras `main` quedó fuera,
// ese Java no lo compilaba nadie: los tests comparan cadenas y `java-syntax` solo tokeniza.
//
// Se deriva del diseño y no se escribe a mano en el script por lo de siempre: una lista de
// fixtures «que compilan» se desincroniza en silencio, y perder la compilación del `main` no
// se ve —la pasada sigue en verde compilando la mitad de antes.

/**
 * Decide si el `main` de este diseño compila recién generado.
 *
 * @param {object} layers capas del diseño ya cargadas
 * @returns {{ compilable: boolean, motivo: string|null }} `motivo` explica el `false`
 */
export function mainCompilable(layers) {
  const replicas = [];
  for (const [depId, dep] of Object.entries(layers?.dependencies?.dependencies ?? {})) {
    for (const [needName, need] of Object.entries(dep?.needs ?? {})) {
      if (need?.strategy === 'replicated' && need?.replica?.entity) {
        replicas.push(`${depId}.${needName} → ${need.replica.entity}`);
      }
    }
  }
  if (replicas.length === 0) return { compilable: true, motivo: null };
  return {
    compilable: false,
    motivo:
      `declara una réplica (${replicas.join(', ')}): el projector generado llama a ` +
      `projectionOf(...) y applySnapshot(...), que escribe el agente en la entidad`
  };
}
