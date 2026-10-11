// El puerto `AfterCommit`: programar un efecto que SALE del proceso (llamar a un proveedor, borrar
// un binario) para DESPUÉS de que confirme la transacción del caso de uso.
//
// Lo emite build porque las dos corridas de keel-spring que lo necesitaron (asset-vault y catalog,
// 2026-10-11) lo escribieron cada una por su cuenta, puerto y adaptador idénticos salvo el nombre,
// igual que las dos de keel-nest del día anterior. Una regla del diseño decía «se encarga tras
// confirmar» y la única vía es `TransactionSynchronizationManager`, que es Spring: un handler de
// `application` no puede importarlo. Sin persistencia no hay transacción que esperar y no se emite.
// Es el gemelo de `keel-nest/src/scaffold/after-commit.js`.

import { javaFile, javaPath, subPackage } from './render.js';

export const PORT_PKG = 'application.support';
export const ADAPTER_PKG = 'infrastructure.configurations.transaction';

export function generate(model) {
  if (!model.layersPresent?.persistence) return [];
  return [renderPort(model), renderAdapter(model)];
}

function renderPort(model) {
  const body = `/**
 * Programa un efecto que sale del proceso (llamar a un proveedor ajeno, borrar un binario) para
 * DESPUÉS de que confirme la transacción del caso de uso.
 *
 * <p>Si la transacción revierte —o pierde una carrera de concurrencia—, el efecto no ocurre nunca;
 * sin transacción abierta, ocurre ya. Un fallo del efecto se registra y no deshace lo confirmado,
 * porque la transacción ya no existe.
 *
 * <p>Es la herramienta de una regla del diseño que dice «después de confirmar»: dentro de la
 * transacción, la copia que pierde una carrera ya habría llamado al proveedor.
 */
public interface AfterCommit {

    void run(Runnable action);
}`;
  return {
    path: javaPath(model, PORT_PKG, 'AfterCommit'),
    content: javaFile(subPackage(model, PORT_PKG), [], body)
  };
}

function renderAdapter(model) {
  const body = `/**
 * Adaptador de {@link AfterCommit}: engancha la acción al commit de la transacción que abrió el
 * UseCaseMediator. Si esa transacción revierte, la acción no se ejecuta.
 */
@Component
public class TransactionAfterCommit implements AfterCommit {

    private static final Logger log = LoggerFactory.getLogger(TransactionAfterCommit.class);

    @Override
    public void run(Runnable action) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            execute(action);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                execute(action);
            }
        });
    }

    /**
     * El commit ya ocurrió: un fallo aquí no puede deshacerlo ni debe convertir en error una
     * operación que se confirmó. Se registra, con su pila, y se sigue.
     */
    private static void execute(Runnable action) {
        try {
            action.run();
        } catch (RuntimeException failure) {
            log.warn("Efecto posterior a la confirmación fallido; la operación ya estaba confirmada", failure);
        }
    }
}`;
  return {
    path: javaPath(model, ADAPTER_PKG, 'TransactionAfterCommit'),
    content: javaFile(
      subPackage(model, ADAPTER_PKG),
      [
        `${subPackage(model, PORT_PKG)}.AfterCommit`,
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory',
        'org.springframework.stereotype.Component',
        'org.springframework.transaction.support.TransactionSynchronization',
        'org.springframework.transaction.support.TransactionSynchronizationManager'
      ],
      body
    )
  };
}
