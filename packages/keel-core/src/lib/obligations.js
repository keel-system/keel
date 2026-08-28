// Las decisiones que un diseño ABRE al declarar algo, y que nadie echa de menos si no se cierran.
//
// Por qué existe este módulo. El método ya tiene el modelo entero —las 17 clases de
// `assets/skills/keel-design/references/gap-analysis.md`, con su disparador, su severidad y su
// cierre— pero vive en la conversación: no deja artefacto, nada comprueba que se ejecutara, y la
// propia clase 16 admite que con el contexto compactado el registro desaparece. En paralelo,
// `crossrefs.js` detecta decenas de estas decisiones y las emite como avisos que `keel validate`
// imprime justo antes de escribir «✔ Servicio válido». El resultado es el que documentan las
// corridas de `info/`: el mismo hueco reportado como `designGap` cuatro corridas seguidas, ya con
// un agente escribiendo Java.
//
// Una obligación es eso mismo con un **id estable**. El id es lo que hace posibles las tres cosas
// que faltaban: exentarla por escrito (`decisions.yaml`), contarla en el catálogo de diseños, y
// seguirle la pista entre corridas.
//
// Esto es doctrina del MÉTODO, no de un generador concreto: por eso vive en core, igual que
// `framework-errors.js`. La prosa que acompaña a esta tabla está en
// `assets/core/docs/design-obligations.md`, y `test/obligations.test.js` comprueba que las dos
// digan lo mismo.

/**
 * `kind` — de dónde sale la respuesta, que decide quién puede comprobarla:
 *
 *   decision  un dato que el diseño podía declarar y no declaró. Derivable del YAML, así que lo
 *             emite `crossrefs.js`.
 *   scenario  un `FL-*` que `validation-scenarios.md` debe contener. Se detecta leyendo el
 *             documento, con las limitaciones de leer texto: por eso el mensaje dice «no
 *             encuentro», nunca «no existe».
 *   review    lo que solo un lector puede juzgar (prosa que promete un estado que la entidad no
 *             puede representar). NO se mecaniza: la fila existe para que `/keel-validate` la
 *             recorra y dé veredicto por id, que es lo que hoy no hace.
 *
 * `waivable: false` recoge la regla dura que ya está escrita en gap-analysis.md § severidades:
 * hay clases que no admiten «aceptado» porque ahí no existe default seguro, y aceptarlas
 * significaría dejárselo al generador.
 */
export const OBLIGATIONS = {
  'OBL-IDEM-RACE-CODE': {
    gapClass: 4,
    when: 'use-cases: alguna operación declara `idempotency`',
    kind: 'decision',
    waivable: true,
    title: 'la carrera de la clave de idempotencia no tiene `code` nombrado',
    closes: 'un `code` de la familia KEY_IN_PROGRESS en `errors`, con status 409, o exención razonada',
    doc: 'framework-errors.md'
  },

  'OBL-IDEM-REUSE-CODE': {
    gapClass: 4,
    when: 'use-cases: alguna operación declara `idempotency`',
    kind: 'decision',
    waivable: true,
    title: 'el desenlace «misma clave, otro cuerpo» no tiene `code` nombrado',
    closes: 'un `code` de la familia KEY_REUSED en `errors`, con status 409, o exención razonada',
    doc: 'framework-errors.md'
  },

  'OBL-RESOURCE-SCOPE': {
    gapClass: 9,
    when: 'use-cases: una operación protegida por rol declara un error 403',
    kind: 'decision',
    // La única no exentable del catálogo, y la razón es la que da gap-analysis para toda la
    // clase 9: aquí no existe un default seguro. «Aceptado» significaría que el generador
    // decide quién alcanza qué, y lo que decide por omisión es que todo el mundo alcanza
    // todo — un servidor que sirve a cualquier titular del rol los recursos de todos los
    // inquilinos, con el 403 de su contrato sin que nada lo produzca.
    waivable: false,
    title: 'un 403 que nada de lo declarado puede producir',
    closes:
      '`authentication.scoping` con el claim que acota, o retirar ese 403 si el permiso no se acota por recurso',
    doc: 'dsl/security.md'
  },

  'OBL-ENTITY-UNREACHABLE': {
    gapClass: 14,
    when: 'domain: una raíz de agregado a la que ninguna operación se refiere',
    kind: 'decision',
    // Exentable, y la razón importa: «se aprovisiona fuera de banda» es una respuesta legítima
    // —datos de referencia, un seed de despliegue— y aquí SÍ hay un default seguro, porque el
    // generador no inventa nada: se limita a no generar alta. Lo que no es legítimo es no
    // haberlo decidido, que es lo que esto persigue.
    waivable: true,
    title: 'una raíz de agregado que ninguna operación puede crear',
    closes:
      'una operación que la produzca, o la exención razonada diciendo quién la aprovisiona fuera del servicio',
    doc: 'dsl/use-cases.md'
  },

  'OBL-CONCURRENCY-CODE': {
    gapClass: 4,
    when: 'persistence: `consistency.optimisticLocking` es `all` o `declared`',
    kind: 'decision',
    waivable: true,
    title: 'el conflicto de escritura concurrente no tiene `code` nombrado',
    closes:
      'un `code` de la familia CONCURRENT_MODIFICATION en `errors`, con status 409, o exención razonada',
    doc: 'framework-errors.md'
  }
};

/** Los ids del catálogo, en orden de declaración. */
export function obligationIds() {
  return Object.keys(OBLIGATIONS);
}

/**
 * La entrada de un id, o `undefined`.
 *
 * Quien emite una obligación pasa por aquí en vez de escribir el id a mano: un id que no está en
 * el catálogo no tiene doc, no se puede exentar y no se puede contar, así que emitirlo sería
 * abrir un hueco nuevo en el sitio pensado para cerrarlos.
 */
export function obligationFor(id) {
  return OBLIGATIONS[id];
}
