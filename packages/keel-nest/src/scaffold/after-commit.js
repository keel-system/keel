// El puerto `AfterCommit`: programar un efecto que SALE del proceso (llamar a un proveedor, borrar un binario)
// para DESPUÉS de que confirme la transacción del caso de uso.
//
// Lo emite build porque las dos corridas que lo necesitaron (asset-vault y catalog, 2026-10-10) lo escribieron
// cada una por su cuenta, idéntico: una regla del diseño decía «la retirada se encarga tras confirmar» y la
// única vía era `TransactionContext.afterCommit`, que vive en infrastructure y un handler no puede importar. Es
// el AFTER_COMMIT de Spring (`TransactionSynchronization`), y keel-spring emite el mismo puerto
// (`keel-spring/src/scaffold/after-commit.js`): allí tampoco un handler puede importar el framework, y sus dos
// corridas del 2026-10-11 lo escribieron a mano. Sin persistencia no hay transacción que esperar, así que no se emite.

import { DIRS, classPath, tsModule } from './render.js';
import { TRANSACTION_CONTEXT_TS } from './repositories.js';

export const AFTER_COMMIT_TS = classPath(DIRS.portOut, 'AfterCommit');
export const AFTER_COMMIT_ADAPTER_TS = 'src/infrastructure/persistence/after-commit-adapter.ts';

/** Los dos archivos: el puerto de application y su adaptador sobre la transacción del mediator. */
export function afterCommitFiles() {
  return [
    {
      path: AFTER_COMMIT_TS,
      content: tsModule(
        AFTER_COMMIT_TS,
        [],
        `/**
 * Programa un efecto que sale del proceso (llamar a un proveedor ajeno, borrar un binario) para DESPUÉS de que
 * confirme la transacción del caso de uso. Si la transacción revierte —o pierde una carrera de concurrencia—, el
 * efecto no ocurre nunca; sin transacción abierta, ocurre ya. Un fallo del efecto se registra y no deshace lo
 * confirmado, porque la transacción ya no existe.
 *
 * Es la herramienta de una regla del diseño que dice «después de confirmar»: dentro de la transacción, la copia que
 * pierde una carrera ya habría llamado al proveedor. Clase abstracta y no interfaz porque es también el token de
 * inyección.
 */
export abstract class AfterCommit {
  abstract run(action: () => Promise<void>): Promise<void>;
}`
      )
    },
    {
      path: AFTER_COMMIT_ADAPTER_TS,
      content: tsModule(
        AFTER_COMMIT_ADAPTER_TS,
        [
          { symbol: 'Inject', from: '@nestjs/common' },
          { symbol: 'Injectable', from: '@nestjs/common' },
          { symbol: 'AfterCommit', from: AFTER_COMMIT_TS },
          { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS }
        ],
        `/** El adaptador de AfterCommit: delega en la transacción que abrió el UseCaseMediator. */
@Injectable()
export class AfterCommitAdapter extends AfterCommit {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {
    super();
  }

  run(action: () => Promise<void>): Promise<void> {
    return this.transactions.afterCommit(action);
  }
}`
      )
    }
  ];
}

/** Lo que el módulo de persistencia registra y exporta para que los handlers lo inyecten. */
export function afterCommitBinding() {
  return {
    imports: [
      { symbol: 'AfterCommit', from: AFTER_COMMIT_TS },
      { symbol: 'AfterCommitAdapter', from: AFTER_COMMIT_ADAPTER_TS }
    ],
    binding: '    { provide: AfterCommit, useClass: AfterCommitAdapter }',
    export: 'AfterCommit'
  };
}
