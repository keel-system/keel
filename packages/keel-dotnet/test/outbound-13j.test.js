// El último valor conocido (`onUnavailable: lastKnown`) y la concesión OAuth2 client-credentials de keel-dotnet
// (incremento 13j), sobre el texto emitido de catalog-extended, que declara las dos. Lo que EJECUTA el C# —la ventana, la
// clave, el tope, el adaptador que sirve el último valor y se rinde; la concesión que reutiliza el token, una sola petición
// en vuelo, la renovación, el Bearer obligatorio y la llamada que no sale sin token— lo mide OutboundClientsTests en
// `npm run cs-check`, falsado con lastknown-window, lastknown-key, oauth-reuse y oauth-bearer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/workspace.js';

const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

test('lastKnown: el camino feliz recuerda con la clave de los parámetros, el fallback sirve dentro de la ventana y se rinde', async () => {
  const { files } = await planFixture('catalog-extended');
  const adapter = content(files, '/Clients/PricingHttpAdapter.cs');
  assert.match(adapter, /LastKnownValues lastKnown\) : IPricingClient/);
  assert.match(adapter, /lastKnown\.Remember\("getPrice", LastKnownValues\.Key\(sku\), result\);/);
  assert.match(adapter, /lastKnown\.Recall<GetPriceResult>\("getPrice", LastKnownValues\.Key\(sku\), 900\) is \{ \} remembered/);
  assert.match(adapter, /return remembered\.AsStale\(\);\s+\}\s+throw new PriceUnavailableError\(/);
  assert.match(content(files, '/Clients/GetPriceResult.cs'), /public sealed record GetPriceResult\(decimal\? Amount, string\? Currency, bool Stale = false\)/);
  assert.match(content(files, '/Clients/LastKnownValues.cs'), /public const int MaxEntries = 10000;/);
  assert.match(content(files, '/Clients/HttpClientsRegistration.cs'), /services\.AddSingleton\(_ => new LastKnownValues\(\)\);/);
  // Las demás llamadas no recuerdan nada.
  assert.doesNotMatch(content(files, '/Clients/ComplianceHttpAdapter.cs'), /LastKnownValues/);
});

test('OAuth2: la concesión se lee de http-clients.yaml con las claves de keel-spring y el intercambio pone su Bearer', async () => {
  const { files } = await planFixture('catalog-extended');
  const settings = content(files, '/Clients/HttpClientsSettings.cs');
  assert.match(settings, /Authorization: new ClientCredentials\(new ClientCredentialsSettings\(\s+"partner-catalog",\s+BaseUrl\(get, "http-clients:partner-catalog:auth:token-uri"\),\s+Text\(get, "http-clients:partner-catalog:auth:client-id"\),\s+Text\(get, "http-clients:partner-catalog:auth:client-secret"\),\s+\["catalog\.write"\]/);
  assert.match(settings, /key\.EndsWith\(":token-uri", StringComparison\.Ordinal\)/);
  const local = content(files, 'config/parameters/local/http-clients.yaml');
  assert.match(local, /token-uri: /);
  assert.match(content(files, '/Clients/HttpExchange.cs'), /if \(client\.Authorization is \{ \} authorize\)/);
  const grant = content(files, '/Clients/ClientCredentials.cs');
  assert.match(grant, /public static readonly TimeSpan ClockSkew = TimeSpan\.FromSeconds\(60\);/);
  assert.match(grant, /ProviderFailureKind\.AuthGrant/);
  // El fallback de las llamadas de ese cliente atiende el AuthGrant.
  assert.match(content(files, '/Clients/PartnerCatalogHttpAdapter.cs'), /ProviderFailureKind\.AuthGrant/);
});

test('sin lastKnown ni OAuth2 no se emite nada de ellos', async () => {
  const { files } = await planFixture('stock-reservation');
  assert.ok(!files.some((file) => /LastKnownValues|ClientCredentials/.test(file.path)));
  assert.doesNotMatch(content(files, '.UnitTests/OutboundClientsTests.cs'), /ManualClock|FakeIssuer/);
});
