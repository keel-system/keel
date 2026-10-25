// Las sondas del orden por un enum y de la lectura por la FK inversa, compartidas por db-check y doc-check: la misma
// pregunta sobre el almacén relacional y sobre el documental. Salieron con la fixture shop-api (2026-10-23); son las
// gemelas de `rankProbes` e `inverseFinderProbes` del db-check de keel-dotnet. Se ejecutan dentro del bloque de la
// raíz, donde `repository` es su adaptador.

import { persistedMembers } from 'keel-core/gen';
import { inverseFindersOf } from 'keel-core/gen/inverse-collections';
import { classPath, DIRS } from '../../src/scaffold/render.js';
import { freshIdLiteral } from './samples.js';

/**
 * El orden por un enum: va por la posición en que el diseño declara sus valores (la sombra de rango de keel-core,
 * `rankShadow`), no por su nombre. Una muestra por valor, guardadas en el orden INVERSO de la declaración, y la página
 * pedida por la sombra las devuelve en el de la declaración. La misma sonda que el db-check de keel-dotnet (rankProbes).
 */
export function rankBlock(model, root, index, ctx, { paginated, sampleEntity }) {
  if (!paginated) return '';
  const member = persistedMembers(model, root).find((candidate) => candidate.kind === 'scalar' && candidate.ranked);
  const enumDef = member && model.enums.find((candidate) => candidate.name === member.field.namedType);
  if (!enumDef || enumDef.values.length < 2) return '';
  ctx.imports.add(`${enumDef.name}|${classPath(DIRS.enums, enumDef.name)}`);
  const idName = root.idField?.name ?? 'id';
  const samples = enumDef.values.map((_, k) => sampleEntity(model, root, ctx, `${index}r${k}`));
  return `  {
    const declared = Object.values(${enumDef.name});
    const samples = [${samples.join(', ')}];
    const mine = [];
    for (const [k, value] of [...declared].reverse().entries()) {
      const sample = new ${root.name}({ ...stateOf(samples[k]), ${member.name}: value });
      await repository.save(sample);
      mine.push(String(sample.${idName}));
    }
    const page = await repository.list({ page: 0, size: 1000, sort: [{ property: '${member.ranked.name}', direction: 'asc' }] });
    const got = page.items.filter((item) => mine.includes(String(item.${idName}))).map((item) => item.${member.name});
    check('${root.name}: ordena por ${member.name} en el orden de su declaración y no por su nombre', JSON.stringify(got) === JSON.stringify(declared), JSON.stringify(got));
  }`;
}

/**
 * La lectura por la FK inversa (`findAllBy<Inversa>Id`): un dueño nuevo con exactamente dos filas, y el finder devuelve
 * esas dos y ninguna más; para un id que no existe, nada. La misma sonda que el db-check de keel-dotnet.
 */
export function inverseBlock(model, root, index, ctx, { sampleEntity, adapterOf }) {
  const idName = root.idField?.name ?? 'id';
  return inverseFindersOf(model, root.name).map((inverse, k) => {
    const owner = model.entities.find((entity) => entity.name === inverse.owner);
    const ownerId = owner.idField?.name ?? 'id';
    const row = (salt) => `new ${root.name}({ ...stateOf(${sampleEntity(model, root, ctx, `${index}i${k}${salt}`)}), ${inverse.relation}Id: owner.${ownerId} })`;
    return `  {
    const owner = ${sampleEntity(model, owner, ctx, `${index}o${k}`)};
    await ${adapterOf(owner)}.save(owner);
    const a = ${row('a')};
    const b = ${row('b')};
    await repository.save(a);
    await repository.save(b);
    const found = await repository.${inverse.finder}(owner.${ownerId});
    const got = found.map((item) => String(item.${idName})).sort();
    check('${root.name}: ${inverse.finder} devuelve las filas de su ${inverse.owner} y ninguna más', JSON.stringify(got) === JSON.stringify([String(a.${idName}), String(b.${idName})].sort()), JSON.stringify(got));
    check('${root.name}: ${inverse.finder} con un id que no existe no devuelve nada', (await repository.${inverse.finder}(${freshIdLiteral(owner.idField)})).length === 0);
    // Lo que creó la sonda, fuera: el dueño es de OTRA raíz, y su bloque lee el primer documento de la colección.
    await repository.deleteById(a.${idName});
    await repository.deleteById(b.${idName});
    await ${adapterOf(owner)}.deleteById(owner.${ownerId});
  }`;
  }).join('\n');
}
