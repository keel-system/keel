// La AUTORÍA de las escrituras de keel-dotnet (incremento 13h), sobre el texto emitido:
//
//   · AuditActor sigue la regla del AuditorAware de keel-spring y del currentActor() de keel-nest: con seguridad, el `sub`
//     del token (el nombre si no lo trae) o el cliente de la clave de API; sin petición autenticada, el centinela con la
//     correlación, también la que abre un listener en un servicio sin API;
//   · la prueba emitida AuditActorTests recorre los casos que el servicio tiene;
//   · los dos adaptadores estampan created_by solo al nacer y updated_by en cada escritura, en la raíz y en sus hijas.
// Lo que EJECUTA el C#: AuditActorTests en `cs-check` (asset-vault), y la autoría contra la base real en `db-check` (el
// sujeto derivado product-catalog-authorship) y `doc-check` (asset-vault).

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/workspace.js';

const withAuthorship = (manifest, layers) => {
  layers.persistence.audit = { ...(layers.persistence.audit ?? {}), authorship: 'all' };
};
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

test('con seguridad, el actor es el sujeto del token (el nombre si no lo trae) o el cliente de la clave; si no, el sistema con la correlación', async () => {
  const { files } = await planFixture('asset-vault');
  const actor = content(files, '/Persistence/AuditActor.cs');
  assert.match(actor, /SecurityContext\.Get\(\) is \{ \} principal/);
  assert.match(actor, /principal\.Kind == PrincipalKind\.Token && ClaimValues\.Text\(principal\.Claims, "sub"\) is \{ Length: > 0 \} subject \? subject : principal\.Name/);
  assert.match(actor, /CorrelationContext\.Get\(\) is \{ \} correlationId \? \$"\{System\}:\{correlationId\}" : System/);
  assert.match(actor, /public const string System = "system";/);
  const tests = content(files, '/AuditActorTests.cs');
  for (const name of ['ConUnTokenEsElSujetoNoElNombre', 'ConUnTokenSinSujetoEsElNombre', 'ConUnaClaveDeApiEsElCliente', 'SinPrincipalEsElSistemaConLaCorrelacion', 'SinPrincipalNiCorrelacionEsElSistemaNuncaVacio']) {
    assert.match(tests, new RegExp(`public void ${name}\\(`), name);
  }
});

test('sin seguridad no hay principal que mirar: el sistema, con la correlación de la API o la de un listener', async () => {
  for (const name of ['product-catalog', 'metering-digest']) {
    const { files, model } = await planFixture(name, { mutate: withAuthorship });
    assert.ok(!model.layersPresent.security, name);
    const actor = content(files, '/Persistence/AuditActor.cs');
    assert.ok(actor, `${name}: sin AuditActor`);
    assert.doesNotMatch(actor, /SecurityContext/, name);
    assert.match(actor, /public static string Current\(\) => CorrelationContext\.Get\(\) is \{ \} correlationId/, name);
    const tests = content(files, '/AuditActorTests.cs');
    assert.doesNotMatch(tests, /ConUnToken/, name);
    assert.match(tests, /SinPrincipalEsElSistemaConLaCorrelacion/, name);
  }
});

test('sin autoría no hay actor ni prueba', async () => {
  const { files } = await planFixture('product-catalog');
  assert.ok(!files.some((file) => /AuditActor/.test(file.path)));
});

test('la rama relacional estampa created_by solo al nacer y updated_by siempre, en la raíz y en sus hijas', async () => {
  const { files } = await planFixture('catalog-extended', { mutate: withAuthorship });
  const repository = content(files, '/Repositories/ProductRepository.cs');
  assert.match(repository, /var actor = AuditActor\.Current\(\);/);
  assert.match(repository, /if \(string\.IsNullOrEmpty\(row\.CreatedBy\)\) \{ row\.CreatedBy = actor; \}\s+row\.UpdatedBy = actor;/);
  assert.match(repository, /foreach \(var child in row\.Images\) \{ if \(string\.IsNullOrEmpty\(child\.CreatedBy\)\) \{ child\.CreatedBy = actor; \} child\.UpdatedBy = actor; \}/);
  for (const row of ['ProductRow.cs', 'ProductImageRow.cs']) {
    assert.match(content(files, `/Rows/${row}`), /HasColumnName\("created_by"\)\.HasMaxLength\(255\)\.IsRequired\(\)/, row);
  }
});

test('la rama documental estampa updated_by en cada escritura y created_by solo al nacer', async () => {
  const { files } = await planFixture('asset-vault');
  for (const file of files.filter((f) => /\/Persistence\/Repositories\/\w+Repository\.cs$/.test(f.path))) {
    assert.match(file.content, /var actor = BsonValues\.Of\(AuditActor\.Current\(\)\);/, file.path);
    assert.match(file.content, /fields\["updated_by"\] = actor;/, file.path);
    // created_by solo en la rama del alta (o en el $setOnInsert de un upsert), nunca junto a updated_by.
    assert.doesNotMatch(file.content, /fields\["updated_by"\] = actor;\s*fields\["created_by"\]/, file.path);
    assert.match(file.content, /fields\["created_by"\] = actor;|\{ "created_by", actor \}/, file.path);
  }
});
