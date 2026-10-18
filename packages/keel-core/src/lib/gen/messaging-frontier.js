// La mensajería que un generador NO puede generar: la de un servicio sin persistencia.
//
// Los eventos los levanta el agregado y los drena el adaptador de repositorio al guardarlo, y es ese adaptador quien
// los entrega al puente (directo tras el commit con `best-effort`, o a la fila del outbox en la misma transacción). Sin
// persistencia no hay adaptador ni transacción, así que nadie los publica; y el consumo pierde el registro de mensajes
// procesados. Medido el 2026-10-18 (incremento 16 de keel-dotnet): keel-spring emitía un puente que espera un
// AFTER_COMMIT que nadie dispara, y keel-nest ni puente ni publisher; los dos generaban, sin decirlo, un servicio que no
// publica. La pregunta es neutral: los tres generadores la rechazan en build con el mismo mensaje.

/** El rechazo de build, redactado igual para los tres generadores; vacío si el diseño no lo pide. */
export function messagingWithoutPersistenceErrors(manifest, layers, generator) {
  const declared = Object.keys(manifest?.layers ?? {});
  if (!declared.includes('messaging') || layers?.persistence) return [];
  return [
    'capa messaging sin persistence — los eventos del agregado los drena el adaptador de repositorio al guardarlo, y sin persistencia ' +
      `nadie los publicaría (ni hay registro de mensajes procesados): ${generator} generaría un servicio que no publica sin decirlo. Declara la persistencia.`
  ];
}
