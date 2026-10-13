// La política de la transacción del caso de uso que no depende del lenguaje (incremento 1d de
// PLAN-KEEL-DOTNET.md). Su tope de duración es una variable de entorno y vive en `runtime-env.js`
// (`DB_TRANSACTION_TIMEOUT`); reconocer un conflicto transitorio sí es de cada plataforma —Spring traduce
// excepciones, el driver de Node da códigos—.

/**
 * Intentos de una transacción de escritura que pierde un conflicto transitorio: un interbloqueo en un motor
 * relacional, o dos transacciones sobre el mismo documento en MongoDB, donde el motor aborta a la segunda en
 * vez de hacerla esperar. Agotados, el conflicto es un 409.
 */
export const WRITE_CONFLICT_ATTEMPTS = 3;
