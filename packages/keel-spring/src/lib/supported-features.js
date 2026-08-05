// Frontera declarada del generador: qué del DSL sabe mapear keel-spring.
//
// El DSL es más ancho que cualquier generador concreto, y eso es correcto: se
// ajusta el generador, nunca el DSL. Lo que no es correcto es *ignorar en
// silencio* algo que el diseño declara — el diseñador cree que se ha generado y
// nadie se lo desmiente. Cada entrada de este módulo es un fallo silencioso
// menos: o el build lo rechaza, o lo avisa diciendo qué se genera en su lugar.
//
// Al añadir soporte para una de estas capacidades, se borra su entrada de aquí.

/**
 * Comprueba el diseño contra la frontera de keel-spring.
 * Devuelve { errors, warnings } de strings ya redactados para consola:
 * `errors` impide generar; `warnings` deja seguir avisando qué se generará.
 */
export function checkSupportedFeatures(manifest, layers) {
  const errors = [];
  const warnings = [];

  // Modelo de almacenamiento: solo el relacional. El scaffolding de persistencia
  // es JPA de arriba abajo (entidades espejo, Flyway, dialectos) y el
  // cuestionario de stack solo ofrece motores relacionales.
  const model = layers?.persistence?.default?.model;
  if (model && model !== 'relational') {
    errors.push(
      `persistence.default.model: ${model} no soportado por keel-spring, que solo genera el modelo relacional (JPA + Flyway; el cuestionario de stack solo ofrece motores relacionales). Ajusta el diseño o usa un generador que cubra ese modelo.`
    );
  }

  // Ubicación del token: solo cabecera. La cadena de seguridad generada resuelve
  // el bearer de Authorization; un token en cookie exigiría otro converter y
  // protección CSRF, que no se generan.
  const tokenLocation = layers?.security?.authentication?.tokenLocation;
  if (tokenLocation && tokenLocation !== 'header') {
    warnings.push(
      `security.authentication.tokenLocation: ${tokenLocation} no se aplica: keel-spring genera la lectura del token en la cabecera Authorization. Si la cookie es un requisito, complétalo a mano tras generar (y revisa la protección CSRF, que tampoco se genera).`
    );
  }

  // Semántica del fallo de audiencia. keel-spring la resuelve como AUTORIZACIÓN
  // (403: el token es legítimo, no está emitido para este servicio), y no genera
  // ninguna distinción entre credencial humana y de máquina más allá de las
  // authorities de scope. Ambas cosas son decisiones del generador que el diseño
  // no puede cambiar hoy, y un escenario escrito esperando 401 falla contra un
  // servidor correcto: se declara aquí para que el hueco se cierre en el diseño
  // antes de generar, no a mitad de la validación funcional.
  if (layers?.security?.authentication?.serviceAuth?.validateAudience) {
    warnings.push(
      'security.authentication.serviceAuth.validateAudience: keel-spring traduce el fallo de audiencia a 403 (autenticado, sin permiso), no a 401, y no distingue credencial humana de credencial de máquina más allá de los scopes: un token de usuario con el scope requerido pasa el filtro de una operación level: service. Revisa que los escenarios de la superficie M2M esperen esos status.'
    );
  }

  // Versión del contrato del proveedor. El diseño la declara para que romperla
  // sea una decisión consciente, pero el servidor generado no la comprueba en
  // runtime: no negocia versión, no manda cabecera de versión y no falla al
  // arrancar si el proveedor ya no la sirve. Un cambio incompatible se descubre
  // en la primera llamada, y el aviso está para que nadie cuente con otra cosa.
  const versioned = Object.entries(layers?.dependencies?.dependencies ?? {})
    .filter(([, dep]) => dep?.contract?.version)
    .map(([id, dep]) => `${id}@${dep.contract.version}`);
  if (versioned.length > 0) {
    warnings.push(
      `dependencies.contract.version (${versioned.join(', ')}): informativo. keel-spring no comprueba en runtime que el proveedor siga sirviendo esa versión — un cambio incompatible aparecerá como fallo de la llamada, no al arrancar. Si el proveedor versiona por ruta o cabecera, ponlo en la llamada de http-clients.`
    );
  }

  // `awaits` describe qué se espera del proveedor, y eso aterriza como
  // instrucción en el stub del handler, no como código: no se genera ninguna
  // espera, correlación ni máquina de estados que ligue la respuesta con la
  // operación. Con `outcome` la diferencia importa —el desenlace depende de lo
  // que devuelva el proveedor— así que se dice en voz alta.
  const awaitingOutcome = [];
  for (const [id, dep] of Object.entries(layers?.dependencies?.dependencies ?? {})) {
    for (const [name, activation] of Object.entries(dep?.activations ?? {})) {
      if (activation?.awaits === 'outcome') awaitingOutcome.push(`${id}.${name}`);
    }
  }
  if (awaitingOutcome.length > 0) {
    warnings.push(
      `dependencies.activations.awaits: outcome (${awaitingOutcome.join(', ')}): keel-spring lo traduce a "usa el cuerpo de la respuesta" como nota en el handler, no a ningún mecanismo de espera ni de correlación. Si el proveedor resuelve de forma asíncrona (responde 202 y avisa después), el diseño necesita además una suscripción a su evento de resultado: la llamada síncrona sola no lo cubre.`
    );
  }

  return { errors, warnings };
}
