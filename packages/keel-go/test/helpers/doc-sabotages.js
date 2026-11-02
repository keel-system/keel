// Los sabotajes de doc-check: cada uno rompe UN mecanismo de la persistencia documental en el Go emitido conservando que
// compile, y dice qué sondas de scripts/lib/doc-probes.js tienen que salir en rojo (`expect`) y cuáles pueden caer con
// ellas por una dependencia legítima (`also`). Se aplican EN MEMORIA, antes de escribir lo emitido: una red que
// reconstruye lo que mide no lo falsa. test/doc-sabotages.test.js comprueba sin Go que cada uno se sigue aplicando.

const STORE = String.raw`^internal\/infrastructure\/mongo\/`;
const file = (name) => new RegExp(`${STORE}${name}$`);
const REPOSITORY = new RegExp(`${STORE}\\w+_repository\\.go$`);

export const DOC_SABOTAGES = {
  // El decimal se guarda como texto: hace ida y vuelta con el propio adaptador si también lo lee así, pero no es un
  // Decimal128. Solo lo ve el documento crudo (la lectura, que exige Decimal128, cae con él).
  'decimal-as-text': {
    files: file('bson_values\\.go'),
    from: '\tvalue, err := bson.ParseDecimal128(d.String())\n',
    to: '\tvalue, err := d.String(), error(nil)\n',
    expect: /_RawDocumentIsTheContract/,
    also: /_RoundTrip|_Stale|_PageAndDelete|_FindAllByID|_FindBy|_SaveMerges|Clash|Transaction_|_ClaimFor|_Rank|_Inverse/
  },
  // El uuid se guarda con el subtipo 3 heredado: la ida y vuelta lo rechaza al leer, el documento crudo lo dice.
  'uuid-legacy': {
    files: file('bson_values\\.go'),
    from: 'return bson.Binary{Subtype: bson.TypeBinaryUUID, Data: id[:]}',
    to: 'return bson.Binary{Subtype: bson.TypeBinaryUUIDOld, Data: id[:]}',
    expect: /_RawDocumentIsTheContract|_RoundTrip/,
    also: /./
  },
  // La versión sale del filtro: la lectura obsoleta pisa a la otra en vez de ser el 409.
  version: {
    files: REPOSITORY,
    from: /, \{Key: "lock_version", Value: \*version\}\}, bson\.D\{\{Key: "\$set"/g,
    to: '}, bson.D{{Key: "$set"',
    expect: /_StaleVersion/
  },
  // El traductor no reconoce ningún índice: el choque sale como el 409 sin code.
  translator: { files: file('errors\\.go'), from: 'at := strings.Index(text, "index: "+name)', to: 'at := strings.Index(text, "index: "+name+"-")', expect: /Clash/ },
  // El clasificador no reconoce el conflicto transitorio: no se repite y uno de los dos escritores falla, y el conflicto
  // agotado sale como el error del driver.
  transient: {
    files: file('transactions\\.go'),
    from: 'return errors.As(err, &server) && (server.HasErrorLabel("TransientTransactionError") || server.HasErrorCode(112))',
    to: 'return errors.As(err, &server) && server.HasErrorCode(-1)',
    expect: /Transaction_/
  },
  // El relay reclama sin orden: con más pendientes que el lote, los más antiguos podrían no salir nunca.
  'outbox-order': { files: file('outbox\\.go'), from: 'SetSort(bson.D{{Key: "created_at", Value: 1}, {Key: "_id", Value: 1}})', to: 'SetSort(bson.D{{Key: "_id", Value: 1}})', expect: /Outbox_/ },
  // La guarda del consumidor escribe en la transacción del caso de uso: el handler que falla se lleva el registro.
  'guard-in-session': { files: file('processed_events\\.go'), from: 'documents.InsertOne(outside(ctx),', to: 'documents.InsertOne(ctx,', expect: /ProcessedEvents_/ },
  // El reclamo de barrido no comprueba el estado de partida: la pasada siguiente vuelve a llevarse lo reclamado.
  claim: { files: REPOSITORY, from: 'Value: bson.D{{Key: "$in", Value: bson.A{', to: 'Value: bson.D{{Key: "$nin", Value: bson.A{', expect: /_ClaimFor/ },
  // La lectura de candidatos no excluye los de marca viva: la cabeza de la cola, reclamada y sin resolver, ocupa el lote.
  'reconciliation-held': { files: file('reconciliation\\.go'), from: 'held = append(held, uuidValue(id))', to: '_ = uuidValue(id)', expect: /_ClaimFor\w+_TheNextPass/ },
  // El reclamo se lleva también lo recién encargado: el umbral del diseño deja de contar.
  'reconciliation-threshold': { files: REPOSITORY, from: 'instantValue(unansweredBefore)', to: 'instantValue(unansweredBefore.Add(window.UnansweredAfter() + time.Hour))', expect: /_ClaimFor\w+_TakesOnlyWhatOutlived/ },
  // La marca caduca con < y no con el <= de keel-core.
  'reconciliation-expiry': { files: file('reconciliation\\.go'), from: '{Key: "$lte", Value: instantValue(expiredBefore)}', to: '{Key: "$lt", Value: instantValue(expiredBefore)}', expect: /TestReconciliationStore_RenewsTheExpiredMarkAtTheLimit/ },
  // Una marca por entidad y no por activación: el encargo de otra activación se queda sin reclamar.
  'reconciliation-key': { files: file('reconciliation\\.go'), from: 'Value: activation + "|" + entityID.String()}', to: 'Value: entityID.String()}', expect: /TestReconciliationStore_(InsertsTheContract|RenewsTheExpired|TheMarkIsPerActivation)/, also: /_ClaimFor\w+_TheNextPass/ },
  // La guarda del envío escribe en la sesión del caso de uso: abortado este, la marca desaparece y el correo se repetiría.
  'send-guard': { files: REPOSITORY, from: 'raw, err := documents.FindOneAndUpdate(outside(ctx), filter, update, options.FindOneAndUpdate().SetReturnDocument(options.After)).Raw()', to: 'raw, err := documents.FindOneAndUpdate(ctx, filter, update, options.FindOneAndUpdate().SetReturnDocument(options.After)).Raw()', expect: /TakesItOnceAndSurvivesTheRollback/ },
  // El registro de idempotencia no se une a la transacción del caso de uso: abortado el comando, la clave queda marcada.
  'idempotency-outside': { files: file('idempotency_store\\.go'), from: '\t\t_, err = documents.InsertOne(ctx, bson.D{', to: '\t\t_, err = documents.InsertOne(outside(ctx), bson.D{', expect: /IdempotencyStore_/ },
  // La autoría declarada viaja en el $set: si el guardado no conserva la que el agregado leyó, created_by cambia al reescribir.
  'created-by-rewritten': { files: file('audit_actor\\.go'), from: 'if current == "" {', to: 'if current != "-" {', expect: /_Authorship/, also: /TestCreatedAuthor/ },
  // El actor deja de leer el `sub`: queda el nombre del principal, que es para mostrar.
  'actor-subject': { files: file('audit_actor\\.go'), from: 'principal.Kind == security.TokenPrincipal && found', to: 'principal.Kind == 0 && found', expect: /_Authorship/, also: /TestAuditActor/ }
};

/** Aplica un sabotaje a los archivos emitidos: `{ files, changed }` (cuántos archivos tocó). */
export function applyDocSabotage(sabotage, files) {
  let changed = 0;
  const out = files.map((emitted) => {
    if (!sabotage.files.test(emitted.path) || typeof emitted.content !== 'string') return emitted;
    const content = typeof sabotage.from === 'string' ? emitted.content.replaceAll(sabotage.from, sabotage.to) : emitted.content.replace(sabotage.from, sabotage.to);
    if (content === emitted.content) return emitted;
    changed += 1;
    return { ...emitted, content };
  });
  return { files: out, changed };
}
