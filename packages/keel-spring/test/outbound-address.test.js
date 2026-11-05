// El filtro anti-SSRF de los clientes salientes (OutboundAddressPolicy, inc. 2 de
// PLAN-KEEL-SPRING-BOOT41.md): una sola pieza construye el HttpClient de todo cliente que emite
// build —los de http-clients con sus cuatro formas de auth y el de la pasarela de pago—, la
// dependencia que la trae entra solo si hay alguno, y la lista de denegación extra tiene su
// gradiente.
//
// Lo que se afirma aquí es lo que build EMITE. Que el filtro rechace de verdad, sin abrir conexión
// y con qué excepción, lo mide `payment-check` (`elEndpointDeMetadatosDeLaNubeSeRechazaSinQuedarEnDuda`,
// `unaDireccionDenegadaPorConfiguracionSeRechazaSinAbrirConexion`; `--sabotage=filter`).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from '@keel-system/keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { ALWAYS_DENIED, DENIED_ADDRESSES_ENV, DENIED_ADDRESSES_PROPERTY } from '../src/scaffold/outbound-address.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function generate(fixture, stack) {
  const { manifest, layers, errors } = loadService(path.join(FIXTURES_DIR, fixture));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-outbound-');
  scaffoldService({ manifest, layers, workspace, force: true, acceptUnready: true, ...(stack ? { stack } : {}) });
  const root = path.join(workspace, 'services', `${manifest.service.name}-spring`);
  const all = fs.readdirSync(root, { recursive: true }).map((file) => file.split(path.sep).join('/'));
  const read = (suffix) => {
    const found = all.find((file) => file.endsWith(suffix));
    return found ? fs.readFileSync(path.join(root, found), 'utf8') : null;
  };
  return { read, all };
}

const HTTP_DEPENDENCY = "implementation 'org.springframework.boot:spring-boot-http-client'";

test('la política deniega lo fijo, añade la lista configurable, no sigue redirecciones y fija HTTP/1.1', () => {
  const policy = generate('catalog-extended').read('/infrastructure/http/OutboundAddressPolicy.java');
  assert.ok(policy, 'sin OutboundAddressPolicy');
  for (const { cidr } of ALWAYS_DENIED) assert.ok(policy.includes(`"${cidr}"`), `no deniega ${cidr}`);
  assert.ok(policy.includes('.or(InetAddressFilter.multicast())'), 'no deniega multicast');
  // javac rechaza una coma final en los argumentos, y java-syntax no lo ve (medido).
  assert.doesNotMatch(policy, /,\s*\/\/[^\n]*\n\s*\)\.or\(/, 'coma tras el último CIDR');
  assert.ok(policy.includes(`@Value("\${${DENIED_ADDRESSES_PROPERTY}:}") List<String> extraDenied`));
  // El filtro de Boot es de PERMITIDAS: lo denegado va negado.
  assert.ok(policy.includes('this.allowed = InetAddressFilter.not(denied);'));
  assert.ok(policy.includes('.withInetAddressFilter(allowed)'));
  assert.ok(policy.includes('.withRedirects(HttpRedirects.DONT_FOLLOW)'), 'los defaults de Boot siguen redirecciones');
  assert.ok(policy.includes('builder.version(HttpClient.Version.HTTP_1_1)'), 'sin HTTP/1.1 el upgrade h2c pierde el cuerpo');
});

test('cada forma de auth de http-clients construye su HttpClient con la política', () => {
  const { read, all } = generate('catalog-extended');
  const configs = all.filter((file) => /\/infrastructure\/http\/[A-Za-z]+ClientConfig\.java$/.test(file));
  assert.ok(configs.length >= 4, `se esperaban los clientes de las cuatro auth: ${configs}`);
  const auths = new Set();
  for (const file of configs) {
    const config = read(file);
    assert.ok(config.includes('OutboundAddressPolicy outboundAddressPolicy'), `${file}: sin la política`);
    assert.ok(config.includes('outboundAddressPolicy.httpClient(Duration.ofSeconds(5))'), `${file}: HttpClient construido a mano`);
    assert.ok(!config.includes('HttpClient.newBuilder()'), `${file}: HttpClient construido a mano`);
    if (config.includes('"Bearer "')) auths.add('bearer-static');
    else if (config.includes('setBasicAuth')) auths.add('basic');
    else if (config.includes('OAuth2ClientHttpRequestInterceptor')) auths.add('oauth2-client-credentials');
    else if (config.includes('String apiKey')) auths.add('api-key');
  }
  assert.deepEqual([...auths].sort(), ['api-key', 'basic', 'bearer-static', 'oauth2-client-credentials']);
});

for (const gateway of ['stripe', 'mercadopago']) {
  test(`la pasarela (${gateway}) sale por el cliente del JDK con la política, no por el Simple`, () => {
    const { read } = generate('payment-checkout', { paymentGateway: gateway, broker: 'rabbitmq' });
    const config = read('/infrastructure/payment/PaymentGatewayHttpConfig.java');
    // El cliente Simple no admite el filtro: Boot lanza al pedírselo.
    assert.ok(!config.includes('SimpleClientHttpRequestFactory'), config);
    assert.ok(config.includes('new JdkClientHttpRequestFactory(outboundAddressPolicy.httpClient(properties.connectTimeout()))'));
    assert.ok(config.includes('requestFactory.setReadTimeout(properties.readTimeout())'));
    assert.ok(config.includes('.infrastructure.http.OutboundAddressPolicy;'), 'sin el import de la política');
    assert.ok(read('build.gradle').includes(HTTP_DEPENDENCY));
  });
}

test('la lista de denegación extra tiene su gradiente, y el perfil test arranca sin ella', () => {
  const { read } = generate('stock-reservation');
  assert.match(read('parameters/local/outbound.yaml'), /^ {2}denied-addresses: ""$/m);
  for (const profile of ['develop', 'production']) {
    const yaml = read(`parameters/${profile}/outbound.yaml`);
    assert.ok(yaml.includes(`denied-addresses: "\${${DENIED_ADDRESSES_ENV}:}"`), `${profile}: ${yaml}`);
  }
  assert.ok(read('application-local.yaml').includes('outbound'), 'el perfil no importa el fragmento');
  assert.ok(read('build.gradle').includes(HTTP_DEPENDENCY));
});

test('sin clientes salientes no hay política, ni dependencia, ni fragmento', () => {
  const { read, all } = generate('notification-mailer');
  assert.equal(read('/OutboundAddressPolicy.java'), null);
  assert.ok(!all.some((file) => file.endsWith('/outbound.yaml')));
  assert.ok(!read('build.gradle').includes(HTTP_DEPENDENCY));
});
