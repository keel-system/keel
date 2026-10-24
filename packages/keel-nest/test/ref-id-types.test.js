// La referencia a OTRA raíz (`<relación>Id`) es del tipo del id de esa raíz, en el dominio y en la columna de TypeORM.
//
// Hasta la fixture shop-api (2026-10-23) keel-nest la tipaba siempre `string`, el uuid de un diseño hacia delante, y un
// diseño recuperado de un legacy trae ids `long`: el dominio decía `cartId: string` donde el DTO y el comando ya decían
// `bigint`, y la columna se creaba `uuid`. Ninguna red sin contenedores lo veía —ts-syntax no comprueba tipos—: lo
// destapó db-check. keel-spring y keel-dotnet ya lo tipaban por el id de la raíz destino.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { domainMembers } from '../src/scaffold/entities.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const relational = fs.readdirSync(FIXTURES_DIR).filter((name) => {
  const file = path.join(FIXTURES_DIR, name, 'persistence.keel.yaml');
  return fs.existsSync(file) && !/model:\s*document/.test(fs.readFileSync(file, 'utf8'));
});

const idTypeOf = (model, entityName) => model.entities.find((entity) => entity.name === entityName)?.fields.find((field) => field.isId)?.tsType;

const checked = [];
for (const name of relational) {
  test(`${name}: toda referencia a otra raíz lleva el tipo de su id, en el dominio y en la columna`, () => {
    const { model, files } = planFixture(name);
    for (const entity of model.entities) {
      for (const member of domainMembers(model, entity).filter((candidate) => candidate.kind === 'externalRef')) {
        const expected = idTypeOf(model, member.relation.entity);
        assert.ok(expected, `${entity.name}.${member.name}: ${member.relation.entity} no tiene id`);
        assert.equal(member.type.replace(/ \| null$/, ''), expected, `${entity.name}.${member.name} en el dominio`);
        const orm = files.find((file) => file.path.endsWith('.ts') && file.content.includes(`@Entity({ name: '${entity.tableName}' })`));
        assert.ok(orm, `${entity.name}: sin entidad de TypeORM`);
        assert.match(orm.content, new RegExp(`\\b${member.name}[!?]?: ${expected}\\b`), `${entity.name}.${member.name} en ${orm.path}`);
        checked.push(`${name}:${entity.name}.${member.name}:${expected}`);
      }
    }
  });
}

test('la red no es vacía: hay referencias a una raíz con id que no es uuid', () => {
  assert.ok(checked.some((entry) => !entry.endsWith(':string')), checked.join(', '));
});
