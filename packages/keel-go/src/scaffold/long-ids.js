// El id `long` que genera la aplicación (`type: long, id: true, generated: true`), con la forma de keel-core/gen/ids.js:
// 41 bits de milisegundos desde 2020 y 12 aleatorios. Es el gemelo de `LongIds` de keel-spring, keel-nest y keel-dotnet,
// y para un uuid no hace falta nada: `uuid.NewV7()` es de la librería. Salió con shop-api en keel-go (corrida 2.27,
// 2026-11-11): las notas del constructor citaban `NextLongID()` y build no la emitía, así que el agente de código escribió
// la suya, sin la forma neutral.

import { LONG_ID_EPOCH_MS, LONG_ID_RANDOM_BITS, usesGeneratedLongIds } from '@keel-system/keel-core/gen/ids';
import { LONG_ID_CALL } from '../lib/go-projection.js';
import { layout, packageFile } from './render.js';

/** El nombre de la función, sin los paréntesis de la llamada que escribe la proyección. */
export const LONG_ID_FUNC = LONG_ID_CALL.replace(/\(\)$/, '');

export function generate(model) {
  if (!usesGeneratedLongIds(model)) return [];
  const { domain } = layout(model);
  const body = `const (
	longIDEpochMs    = ${LONG_ID_EPOCH_MS}
	longIDRandomBits = ${LONG_ID_RANDOM_BITS}
)

// ${LONG_ID_FUNC} devuelve un id long nuevo, el que la aplicación pone al nacer la raíz, como uuid.NewV7 para un uuid:
// 41 bits de milisegundos desde 2020-01-01 y ${LONG_ID_RANDOM_BITS} aleatorios. Son 53 bits, así que el id cabe en un number de
// JavaScript y ningún cliente del JSON lo trunca, y van ordenados por tiempo: cada alta cae al final del índice de la PK.
// Dos altas del mismo milisegundo en réplicas distintas chocan con probabilidad 1/${2 ** LONG_ID_RANDOM_BITS}: la clave primaria lo
// convierte en un conflicto de unicidad, nunca en una fila pisada.
func ${LONG_ID_FUNC}() int64 {
	var random [2]byte
	// Desde Go 1.24, crypto/rand.Read no devuelve error: si el sistema no da aleatoriedad, el programa termina.
	_, _ = rand.Read(random[:])
	return (time.Now().UnixMilli()-longIDEpochMs)<<longIDRandomBits | int64(binary.BigEndian.Uint16(random[:])&(1<<longIDRandomBits-1))
}`;
  return [{ path: `${domain.dir}/long_ids.go`, content: packageFile(model, domain, { imports: ['crypto/rand', 'encoding/binary', 'time'], body }) }];
}
