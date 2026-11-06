// La escritura condicional (DSL 2.25, api.concurrency) contra el adaptador emitido: CW-1 a CW-5 de
// keel-core/gen/conditional-writes.js, el MISMO texto para las dos ramas (db-check y doc-check), con los ids de los casos
// que ejecutan los otros generadores. `sample` es el agregado de muestra ya renderizado; `check` y `translatePersistenceError`
// son los del script de cada red.

import { loadsExpecting, PRECONDITION_FAILED_TS } from '../../src/scaffold/conditional-writes.js';

export function conditionalWriteBlock(model, root, ctx, sample) {
  if (!loadsExpecting(model, root)) return '';
  ctx.imports.add(`PreconditionFailedException|${PRECONDITION_FAILED_TS}`);
  const name = root.name;
  const idName = root.idField?.name ?? 'id';
  return `
  // ─── La escritura condicional (api.concurrency): CW-1 a CW-5 ───
  {
    const saved = await repository.save(${sample});
    const version = Number(saved.lockVersion);
    const current = await repository.loadExpecting(saved.${idName}, [version]);
    check('${name} CW-1: cargar con la versión vigente devuelve el agregado', current != null && differences(snapshot(saved), snapshot(current)).length === 0);
    try {
      await repository.loadExpecting(saved.${idName}, [version + 1]);
      check('${name} CW-2: cargar con otra versión es la precondición', false, 'cargó');
    } catch (error) {
      check('${name} CW-2: cargar con otra versión es la precondición', error instanceof PreconditionFailedException && error.httpStatus === 412, error?.message);
    }
    const untouched = await repository.findById(saved.${idName});
    check('${name} CW-2: y no toca la fila', Number(untouched?.lockVersion) === version && differences(snapshot(saved), snapshot(untouched)).length === 0, untouched?.lockVersion);
    await repository.save(current);
    const unchecked = await repository.loadExpecting(saved.${idName}, null);
    const reread = await repository.findById(saved.${idName});
    check('${name} CW-3: cargar sin versión esperada no compara', unchecked != null && Number(unchecked.lockVersion) === Number(reread?.lockVersion), unchecked?.lockVersion);
    const before = Number(reread?.lockVersion);
    const mine = await repository.loadExpecting(saved.${idName}, [before]);
    const second = await repository.save(mine);
    const after = await repository.findById(saved.${idName});
    check('${name} CW-4: save devuelve la versión nueva, la que ve una lectura posterior', Number(second.lockVersion) === before + 1 && Number(after?.lockVersion) === before + 1, \`\${second.lockVersion} / \${after?.lockVersion}\`);
    const late = await repository.loadExpecting(saved.${idName}, [before + 1]);
    const theirs = await repository.findById(saved.${idName});
    await repository.save(theirs);
    try {
      await repository.save(late);
      check('${name} CW-5: otra escritura entre la carga y el guardado es el 409, no el 412', false, 'se guardó');
    } catch (error) {
      const translated = translatePersistenceError(error);
      check('${name} CW-5: otra escritura entre la carga y el guardado es el 409, no el 412', translated?.httpStatus === 409, translated?.code ?? error?.message);
    }
  }`;
}
