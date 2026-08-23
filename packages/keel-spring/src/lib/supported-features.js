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

  // Modelo de almacenamiento: relacional (JPA + Flyway sobre los seis dialectos) y
  // documental (Spring Data MongoDB, con el agregado como documento). El modelo lo
  // elige el diseño y el cuestionario de stack solo ofrece los motores de ESE
  // modelo. `key-value` no tiene scaffolding: no hay repositorio por agregado que
  // generar sobre un almacén de pares clave/valor.
  const model = layers?.persistence?.default?.model;
  if (model && model !== 'relational' && model !== 'document') {
    errors.push(
      `persistence.default.model: ${model} no soportado por keel-spring, que genera el modelo relacional (JPA + Flyway) y el documental (Spring Data MongoDB). Ajusta el diseño o usa un generador que cubra ese modelo.`
    );
  }

  // Estilo de paginación. El sobre canónico del método (`items`/`page`/`size`/
  // `totalElements`/`totalPages`) es el de offset, y es el único que keel-spring
  // materializa: `cursor` no cambia nada del código generado. Sin esta entrada, un
  // diseño que lo declara recibe paginación por offset y nadie se lo desmiente — y el
  // hueco no aflora hasta que un integrador pide la página siguiente con un cursor que
  // el servidor no emite.
  const paginationStyle = layers?.api?.pagination?.style;
  if (paginationStyle && paginationStyle !== 'offset') {
    warnings.push(
      `api.pagination.style: ${paginationStyle} no se aplica: keel-spring genera paginación por offset con el sobre canónico { items, page, size, totalElements, totalPages } y los query params 'page'/'size'. Escribe los escenarios contra ese sobre, o cambia el estilo a 'offset' para que el diseño diga lo que se genera.`
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

  // Las dos patas de la robustez que NO aterrizan en una clase. Los otros tres ejes de
  // repetición sí lo hacen entero —`idempotency_record` con su store, `processed_event`
  // con su guard, `OutboundIdempotency` cableada en el adaptador—, y por eso no están
  // aquí. Compensación y reconciliación son distintas: build sabe todo lo necesario y aun
  // así lo único que produce es doctrina (javadoc y notas de stub), porque el trabajo real
  // es lógica de negocio. Se dice en voz alta por lo mismo que `awaits: outcome`: quien
  // declara el campo tiene derecho a saber qué recibe de vuelta.
  const compensated = [];
  const reconciled = [];
  for (const [id, dep] of Object.entries(layers?.dependencies?.dependencies ?? {})) {
    for (const compensation of dep?.compensations ?? []) {
      compensated.push(`${id}.${compensation.onEvent}${compensation.undoes ? ` → ${compensation.undoes}` : ''}`);
    }
    for (const [name, activation] of Object.entries(dep?.activations ?? {})) {
      if (activation?.reconciledBy) reconciled.push(`${id}.${name} → ${activation.reconciledBy}`);
    }
  }
  // `onUnavailable: lastKnown` sobre una llamada que el diseño solo describe en prosa.
  // El almacén se alimenta del camino FELIZ del adaptador, y ese camino, sin method/path,
  // es un TODO que el agente escribe: si no añade el `remember(...)`, el `recall(...)` del
  // fallback no encuentra nunca nada y la política degrada en silencio a «fallar siempre»,
  // que es justo lo que el diseño quiso evitar declarándola.
  const untypedLastKnown = [];
  for (const [id, dep] of Object.entries(layers?.dependencies?.dependencies ?? {})) {
    for (const [name, need] of Object.entries(dep?.needs ?? {})) {
      if (need?.onUnavailable?.action !== 'lastKnown' || !need.fetchedFrom) continue;
      const call = layers?.['http-clients']?.clients?.[need.fetchedFrom.client]?.calls?.[need.fetchedFrom.call];
      if (call && !call.method) untypedLastKnown.push(`${id}.${name}`);
    }
  }
  if (untypedLastKnown.length > 0) {
    warnings.push(
      `dependencies.needs.onUnavailable: lastKnown (${untypedLastKnown.join(', ')}): la llamada que resuelve el dato no declara method/path, así que su camino feliz queda como TODO y build no puede insertar el remember(...) que alimenta el almacén. El rescate del fallback se genera igual, pero no encontrará nada hasta que el agente recuerde el resultado: declara method/path en la llamada, o revisa el adaptador antes de dar la política por aplicada.`
    );
  }

  if (compensated.length > 0) {
    warnings.push(
      `dependencies.compensations (${compensated.join(', ')}): keel-spring no genera ninguna clase propia — una compensación es una suscripción normal, y lo que build garantiza es su guarda (la transición del agregado o el IdempotencyGuard del listener) más la doctrina en el javadoc del <Evento>Message y en la nota del handler. Deshacer el trabajo, y devolver el estado que movió, lo escribe el agente de código y lo verifica el de calidad.`
    );
  }
  if (reconciled.length > 0) {
    warnings.push(
      `dependencies.activations.reconciledBy (${reconciled.join(', ')}): build genera el @Scheduled con su cron, la nota de qué barrer y los tres números del barrido en parameters/<perfil>/reconciliation.yaml (el umbral sale del diseño, 'unansweredAfterSeconds'; la caducidad del reclamo y el tamaño de lote los pone el generador), pero la consulta de candidatos y la decisión (reintentar el encargo o compensarlo) las escribe el agente, que debe LEER esos parámetros en vez de elegir constantes. Y queda fuera del gate CONDUCTUAL: el arnés de integración es caja negra y un cron no es alcanzable desde fuera, así que ningún escenario FL-* lo ejercita. Lo cubre infra/check-idempotency.sh en estático, y la prueba en vivo es del diseñador.`
    );
  }

  // Capa mail. El transporte SMTP es el único que keel-spring genera, y el schema
  // ya lo acota; lo que sí queda fuera de la generación es el ORIGEN del cuerpo:
  // con `bundled` haría falta empaquetar los recursos, resolverlos por clave y
  // decidir su ciclo de vida, y nada de eso existe. Generar la rama `data` en su
  // lugar dejaría al diseñador creyendo que sus plantillas del repositorio se
  // despliegan, cuando el servicio esperaría encontrarlas en la base de datos.
  const templatingSource = layers?.mail?.templating?.source;
  if (templatingSource && templatingSource !== 'data') {
    errors.push(
      `mail.templating.source: '${templatingSource}' no soportado por keel-spring, que genera el cuerpo como DATO del servicio (motor sin lógica sobre lo que la BD guarda). Con 'bundled' harían falta los recursos empaquetados y su resolución, que no se generan: usa 'data', o completa esa mitad a mano tras generar.`
    );
  }

  // Una operación interna a la que NO llega ningún disparador generado: ni `schedule`,
  // ni endpoint (el schema ya lo prohíbe con `internal: true`), ni ninguna suscripción
  // que la dispare. Solo puede ejecutarla otro handler llamándola, y ese enlace hoy vive
  // en la prosa de `rules`: build no lo ve, así que hay tres cosas que NO puede hacer por
  // el llamante, y las tres fallan en silencio con varias réplicas.
  //
  // Se avisa aquí y no se infiere quién llama a quién: adivinarlo sacaría de la
  // transacción a barridos (purgas, cierres diarios) que sí la necesitan.
  const triggeredBySubscription = new Set(
    Object.values(layers?.messaging?.subscriptions ?? {})
      .map((sub) => sub?.triggers)
      .filter(Boolean)
  );
  const orphanInternal = [];
  for (const [opName, op] of Object.entries(layers?.['use-cases']?.operations ?? {})) {
    if (op?.internal !== true) continue;
    if (op.schedule !== undefined) continue;
    if (triggeredBySubscription.has(opName)) continue;
    orphanInternal.push(opName);
  }
  // La consecuencia cara solo existe si entre reclamar y actuar hay I/O externo: es lo
  // que hace que el commit del reclamo tenga que caer ANTES, y lo que convierte una
  // transacción abarcadora en correo ya enviado que la base de datos deshace.
  const sentBy = new Set(layers?.mail?.sentBy ?? []);
  const externalIo = orphanInternal.filter(
    (opName) => sentBy.has(opName) || layers?.['http-clients'] !== undefined || layers?.storage !== undefined
  );
  if (orphanInternal.length > 0) {
    warnings.push(
      `use-cases (${orphanInternal.join(', ')}): operación interna sin ningún disparador generado (ni schedule, ni endpoint, ni subscription). ` +
        `La invoca otro handler, y ese enlace solo existe en la prosa de 'rules': build no lo ve, así que no enruta la transacción del llamante ` +
        `ni sabe dónde vive su reclamo — el gate 'sweepClaim' de infra/check-idempotency.sh lo busca en todo el árbol por eso.` +
        (externalIo.length > 0
          ? ` Y con I/O externo de por medio (${externalIo.join(', ')}) eso no es un detalle: si quien la invoca es un barrido, build lo despacha ` +
            `con mediator.dispatch(...) —transacción única sobre el lote entero—, y ahí el reclamo NO confirma hasta el final, así que ninguna ` +
            `réplica lo ve, la llamada externa cae dentro de la transacción y el estado intermedio no llega a existir para nadie (con lo que un ` +
            `rescate por marca de tiempo no encuentra nunca a sus candidatos). Si ese barrido llama de verdad a un tercero, el llamante va por ` +
            `mediator.dispatchWithoutTransaction(...) y el reclamo confirma antes: ver docs/keel/conventions/concurrency.md § El reclamo con una ` +
            `llamada externa en medio.`
          : '')
    );
  }

  return { errors, warnings };
}
