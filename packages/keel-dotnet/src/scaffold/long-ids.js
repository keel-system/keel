// El id `long` que genera la aplicación (`type: long, id: true, generated: true`), con la forma de keel-core/gen/ids.js:
// 41 bits de milisegundos desde 2020 y 12 aleatorios. Es el gemelo de `LongIds` de keel-spring y keel-nest, y para un
// uuid no hace falta nada: `Guid.CreateVersion7()` es de la librería base. Salió con shop-api (2026-10-23), donde el
// agente de código escribió a mano un `Identifiers.NextLong()` porque la raíz nacía con 0.

import { LONG_ID_EPOCH_MS, LONG_ID_RANDOM_BITS, usesGeneratedLongIds } from '@keel-system/keel-core/gen/ids';
import { csFile, located } from './render.js';

export const LONG_IDS_CLASS = 'LongIds';

export function generate(model) {
  if (!usesGeneratedLongIds(model)) return [];
  const { namespace, path } = located(model, 'domainSupport', LONG_IDS_CLASS);
  const body = `/// <summary>
/// Identificadores <c>long</c> que crea la aplicación al nacer la raíz, como <c>Guid.CreateVersion7()</c> para un uuid:
/// 41 bits de milisegundos desde 2020-01-01 y ${LONG_ID_RANDOM_BITS} aleatorios. Son 53 bits, así que el id cabe en un
/// number de JavaScript y ningún cliente del JSON lo trunca, y van ordenados por tiempo: cada alta cae al final del índice
/// de la PK. Dos altas del mismo milisegundo en réplicas distintas chocan con probabilidad 1/${2 ** LONG_ID_RANDOM_BITS}: la
/// clave primaria lo convierte en un conflicto de unicidad, nunca en una fila pisada.
/// </summary>
public static class ${LONG_IDS_CLASS}
{
    private const long EpochMs = ${LONG_ID_EPOCH_MS}L;
    private const int RandomBits = ${LONG_ID_RANDOM_BITS};

    // El aleatorio pasa por uint: un int en un OR con long se extiende con signo y el compilador lo rechaza (CS0675).
    /// <summary>Un id nuevo.</summary>
    public static long Next() =>
        ((DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - EpochMs) << RandomBits) | (uint)System.Security.Cryptography.RandomNumberGenerator.GetInt32(1 << RandomBits);
}`;
  return [{ path, content: csFile({ namespace, body }) }];
}
