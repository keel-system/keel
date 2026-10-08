// Núcleo NEUTRAL de los generadores: lo que interpreta el diseño sin saber en qué lenguaje
// se va a escribir. Se importa como `keel-core/gen`.
//
// Existe para que dos generadores del mismo diseño (keel-spring, keel-nest) tomen cada
// decisión en UN sitio: el nombre físico de una cola, el `code` que sustituye a un canónico,
// la cadencia de un barrido. Escrita dos veces, una decisión diverge al primer matiz, y dos
// servidores del mismo diseño dejan de ser equivalentes sin que ningún test lo note.
// Regla: nada de aquí nombra un tipo, una anotación ni una librería de un lenguaje concreto
// (lo vigila test/gen-neutral.test.js).

export { pascalCase, camelCase, kebabCase, snakeCase, screamingSnake, pluralize, brokerSafeName } from './naming.js';
export {
  declaredErrorFor,
  effectiveErrorCode,
  declaredUniquenessErrorFor,
  declaredReferenceError,
  namedUniquenessError,
  errorByCode
} from './declared-errors.js';
export {
  deadLetterName,
  subscriptionGroupId,
  subscriptionKey,
  subscriptionDestination,
  publishedDestination,
  deadLetterDestination,
  usesDeadLetter,
  deadLetterSubscriptions,
  retryMaxAttempts,
  retryInitialDelayMs,
  retryMaxDelayMs,
  rabbitListenerRetry,
  kafkaListenerRetry
} from './dead-letter.js';
export { cronPeriodSeconds, fastestSchedulePeriod } from './cron-period.js';
export { CONTRACT_DOCS, contractDocs } from './contract-docs.js';
export {
  HTTP_STUB_ADMIN,
  HTTP_STUB_ENDPOINTS,
  HTTP_STUB_FAULT,
  HTTP_STUB_INITIAL_STATE,
  stubOkResponse,
  stubSlowResponse,
  stubFaultResponse,
  stubMapping,
  stubSequenceMappings,
  stubCriterion
} from './http-stub-probes.js';
export {
  PROVIDER_FAILURES,
  fallbackFailures,
  recordedFailures,
  retriedFailures,
  neverRetriedFailures,
  DEFAULT_RETRY_ON,
  RESILIENCE_DEFAULTS,
  resiliencePolicy,
  retryWaitMs,
  circuitBreakerReference
} from './outbound-resilience.js';
export {
  RECONCILIATION_CLAIM,
  RECONCILIATION_PURGE,
  reconciliationClaimDocumentId,
  DEFAULT_UNANSWERED_AFTER_SECONDS,
  RECONCILIATION_BATCH_SIZE,
  reconciliationClaimTimeoutMs,
  reconciliationParameters,
  reconciledActivations,
  reconciliationClaims,
  reconciliationWindow,
  reconciliationClaimReference
} from './reconciliation-stores.js';
export {
  scheduledOperations,
  hasScheduledOperations,
  scheduleSeconds,
  scheduleCron,
  feedsGuardedEffect,
  scheduleDispatch,
  BATCHED_PURGE,
  batchedPurgeParameters,
  batchedPurgeReference,
  SWEEP_BATCH_DEFAULT,
  sweepClaims,
  claimsForEntity,
  claimOrderField,
  sweepConfig,
  rescueShape,
  stallSql,
  missingClockCountSql,
  rescueProbes
} from './scheduling.js';
export {
  FORMAT_TEXT_BASES,
  numericConstraints,
  inheritedTypePattern,
  inheritedFormat,
  textConstraints,
  validationRules,
  DECIMAL_PRECISION
} from './constraints.js';
export { guardedFields } from './domain-guards.js';
export { physicalBucketName, declaredBuckets, isPublicBucket } from './buckets.js';
export {
  isReservedSqlWord,
  quoteIdentifierFor,
  columnSpec,
  foldedShadow,
  LOCK_VERSION,
  AUDIT_COLUMNS,
  usesAuditableEntity,
  persistedMembers,
  elementTable,
  joinColumnOf,
  parentColumnOf,
  orderingFieldOf,
  backReferenceTo,
  collectInternalEntities,
  collectionBatchSize,
  tableOf,
  uniqueFields,
  indexName,
  foreignKeyName,
  foreignKeyIndexName,
  partialUniqueIndexes,
  storedWhenValue,
  crossAggregateForeignKeys,
  uniqueConstraints,
  columnsFor,
  collectionIndexesOf,
  foreignKeyIndexColumns,
  sqlLiteral,
  discriminatorColumn,
  partialIndexSpecs,
  relievingOperations
} from './relational.js';
export {
  DOCUMENT_STORAGE,
  DOCUMENT_ID,
  storageOf,
  documentValueObjects,
  valueObjectShape,
  documentShape,
  documentPathsFor,
  naturalKeyIndexName,
  documentIndexSpecs,
  partialDocumentIndexSpecs,
  nestedIndexWarnings,
  storeDocumentIndexes,
  documentIndexes,
  INDEX_EXPORT_FILE,
  exportIndexesScript,
  storeDocumentKey,
  storeDocumentFields
} from './document.js';
export {
  constraintErrors,
  raceOnlyConstraint,
  declaredConcurrencyError,
  CONCURRENT_MODIFICATION_MESSAGE,
  UNKNOWN_INTEGRITY_MESSAGE,
  TRANSACTION_TIMEOUT_MESSAGE
} from './constraint-errors.js';
export {
  GATEWAY_STATES,
  GATEWAY_REQUIREMENTS,
  gatewayRequirements,
  checkGatewaySupport,
  gatewayCoverage,
  PAYMENT_NOTICE_PATH,
  PAYMENT_TEST_SECRETS,
  paymentIdempotencyKey,
  PAYMENT_ACTIONS,
  savedMethodIdempotencyKey,
  SAVED_METHOD_SEPARATOR,
  GATEWAY_TRANSLATIONS,
  gatewayTranslation,
  CURRENCY_MINOR_UNITS
} from './payment-gateways.js';
