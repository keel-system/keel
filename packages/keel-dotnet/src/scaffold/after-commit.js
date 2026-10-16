// El puerto `IAfterCommit`: programar un efecto que SALE del proceso (llamar a un proveedor, borrar un binario) para
// DESPUÉS de que confirme la transacción del caso de uso.
//
// Es el gemelo de `keel-spring/src/scaffold/after-commit.js` y `keel-nest/src/scaffold/after-commit.js`, que lo emiten
// porque sus corridas de asset-vault y catalog lo escribieron a mano. keel-dotnet no lo emitía, y su corrida de catalog
// (2026-10-16) se paró en `removeProductImage`: la regla «el binario se borra tras confirmar» solo tenía como vía
// `PersistenceTransactions.AfterCommit`, que vive en Infrastructure y un handler de Application no puede referenciar
// —la frontera la pone el compilador con las referencias entre proyectos—. El agente borró el binario dentro de la
// transacción, ANTES del commit: si la escritura revertía, la imagen quedaba en la fila y sin binario.
//
// El adaptador delega en `AfterCommitOrNow`, no en `AfterCommit`: sin transacción abierta, el efecto ocurre ANTES de
// volver (como el `run` de keel-nest), en vez de lanzarse sin esperar. Sin persistencia no hay transacción que esperar y
// no se emite nada.

import { csFile, located, namespaceOf } from './render.js';
import { usesPersistence } from './persistence.js';

export const AFTER_COMMIT_PORT = 'IAfterCommit';
export const AFTER_COMMIT_ADAPTER = 'AfterCommitAdapter';

/** ¿Emite build el puerto? Con persistencia, de cualquier modelo: las dos ramas tienen PersistenceTransactions. */
export const usesAfterCommit = (model) => usesPersistence(model);

/** La línea de AddPersistence que lo registra (en las dos ramas, junto a la transacción). */
export const AFTER_COMMIT_REGISTRATION = `        // Lo que un handler programa para después del commit (IAfterCommit), sobre ESTA transacción.
        services.AddScoped<${AFTER_COMMIT_PORT}, ${AFTER_COMMIT_ADAPTER}>();`;

export function generate(model) {
  if (!usesAfterCommit(model)) return [];
  const port = located(model, 'ports', AFTER_COMMIT_PORT);
  const adapter = located(model, 'persistence', AFTER_COMMIT_ADAPTER);
  return [
    { path: port.path, content: csFile({ namespace: port.namespace, body: PORT_BODY }) },
    { path: adapter.path, content: csFile({ namespace: adapter.namespace, usings: [namespaceOf(model, 'ports')], body: ADAPTER_BODY }) }
  ];
}

const PORT_BODY = `/// <summary>
/// Programa un efecto que sale del proceso (llamar a un proveedor ajeno, borrar un binario) para DESPUÉS de que confirme
/// la transacción del caso de uso. Si la transacción revierte —o pierde una carrera de concurrencia—, el efecto no ocurre
/// nunca; sin transacción abierta, ocurre ya, antes de volver. Un fallo del efecto se registra y no deshace lo
/// confirmado, porque la transacción ya no existe.
/// </summary>
/// <remarks>
/// Es la herramienta de una regla del diseño que dice «después de confirmar»: dentro de la transacción, la copia que
/// pierde una carrera ya habría llamado al proveedor, y la que revierte ya habría borrado el binario.
/// </remarks>
public interface ${AFTER_COMMIT_PORT}
{
    Task Run(Func<Task> action);
}`;

const ADAPTER_BODY = `/// <summary>El adaptador de ${AFTER_COMMIT_PORT}: delega en la transacción que abrió el UseCaseMediator.</summary>
public sealed class ${AFTER_COMMIT_ADAPTER}(PersistenceTransactions transactions) : ${AFTER_COMMIT_PORT}
{
    public Task Run(Func<Task> action) => transactions.AfterCommitOrNow(action);
}`;
