// Las pruebas que build deja escritas en el proyecto: el equivalente del `contextLoads()` de
// keel-spring más las dos piezas transversales que el servidor no puede tener mal.
//
//   · application.test.ts — TODOS los proveedores se resuelven bajo el perfil `test`, y las sondas
//     cumplen su contrato, también la de drenaje (`/readyz` → 503), que no depende de una señal y
//     por eso se puede medir en cualquier sistema;
//   · configuration.test.ts — el cargador de configuración: el gradiente de placeholders y que una
//     variable obligatoria sin valor impida arrancar, nombrándolas todas.
//
// No sustituyen a los escenarios `FL-*` (llegan en el incremento 7): dicen que el servidor arranca
// y se configura como el de keel-spring del mismo diseño.

import { usesTestCredential } from './test-credential.js';

export function generate(model) {
  return [
    { path: 'test/application.test.ts', content: applicationTestTs(usesTestCredential(model)) },
    { path: 'test/configuration.test.ts', content: configurationTestTs() }
  ];
}

function applicationTestTs(secured = false) {
  // Con seguridad, las sondas del cable llevan la credencial de la prueba: sin ella serían un 401 y
  // medirían la autorización en vez del contrato del cable.
  const credentialImport = secured ? "\nimport { testCredential } from './support/test-credential.js';" : '';
  const probeHeaders = secured ? '...CREDENTIAL, ' : '';
  return `import 'reflect-metadata';
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { loadConfiguration } from '../src/infrastructure/config/configuration.js';
import { GracefulShutdown } from '../src/infrastructure/health/graceful-shutdown.js';
import { HTTP_APPLICATION_OPTIONS, configureHttp, createHttpAdapter } from '../src/infrastructure/http/http-platform.js';
import { Decimal } from '../src/domain/support/decimal.js';
import { RawJson } from '../src/domain/support/raw-json.js';
import { toDecimal, toLong } from '../src/application/support/wire.js';${credentialImport}

/**
 * Sonda del contrato del cable a través del servidor REAL: si Fastify no usara el lector y el
 * serializador del contrato, un decimal llegaría y saldría como 2.5 y un long perdería dígitos.
 */
@Controller('wire-probe')
class WireProbeController {
  @Get()
  out() {
    return {
      amount: Decimal.parse('2.50'),
      big: 9007199254740993n,
      at: new Date('2026-03-14T09:21:07.482Z'),
      doc: RawJson.of('{"a":[1,2]}')
    };
  }

  @Post()
  @HttpCode(200)
  echo(@Body() body: Record<string, unknown>) {
    return { amount: toDecimal(body.amount), big: toLong(body.big) };
  }
}

describe('aplicación', () => {
  let app: NestFastifyApplication;${secured ? '\n  let CREDENTIAL: Readonly<Record<string, string>> = {};' : ''}

  beforeAll(async () => {
${
      secured
        ? `    const credential = await testCredential();
    CREDENTIAL = credential.headers;
    const configuration = loadConfiguration({ ...process.env, PROFILE: 'test', ...credential.env });`
        : "    const configuration = loadConfiguration({ ...process.env, PROFILE: 'test' });"
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(configuration)],
      controllers: [WireProbeController]
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(), HTTP_APPLICATION_OPTIONS);
    configureHttp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('arranca bajo el perfil test y está viva', async () => {
    const response = await app.inject({ method: 'GET', url: '/livez' });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toBe('{"status":"UP"}');
  });

  it('acepta tráfico mientras no drena', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toBe('{"status":"UP"}');
  });

  it('las respuestas salen con el contrato del cable', async () => {
    const response = await app.inject({ method: 'GET', url: '/wire-probe'${secured ? ', headers: CREDENTIAL' : ''} });
    expect(response.payload).toBe('{"amount":2.50,"big":9007199254740993,"at":"2026-03-14T09:21:07.482Z","doc":{"a":[1,2]}}');
  });

  it('los cuerpos se leen sin perder precisión', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/wire-probe',
      headers: { ${probeHeaders}'content-type': 'application/json' },
      payload: '{"amount":2.50,"big":9007199254740993}'
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toBe('{"amount":2.50,"big":9007199254740993}');
  });

  it('un cuerpo que no es JSON es un 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/wire-probe',
      headers: { ${probeHeaders}'content-type': 'application/json' },
      payload: '{"amount":'
    });
    expect(response.statusCode).toBe(400);
  });

  // Va el último: drenar no tiene vuelta atrás.
  it('al empezar a drenar deja de aceptar tráfico, pero sigue viva', async () => {
    app.get(GracefulShutdown).startDraining();
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.payload).toBe('{"status":"OUT_OF_SERVICE"}');
    const live = await app.inject({ method: 'GET', url: '/livez' });
    expect(live.statusCode).toBe(200);
  });
});
`;
}

function configurationTestTs() {
  return `import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfiguration, toMillis } from '../src/infrastructure/config/configuration.js';

describe('configuración', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'config-'));
    mkdirSync(join(root, 'config', 'parameters', 'production'), { recursive: true });
    writeFileSync(
      join(root, 'config', 'application.yaml'),
      'application:\\n  name: demo\\nserver:\\n  port: \${SERVER_PORT:8080}\\n  shutdown-timeout: \${SHUTDOWN_TIMEOUT:30s}\\n'
    );
    writeFileSync(join(root, 'config', 'parameters', 'production', 'secrets.yaml'), 'api:\\n  key: \${API_KEY}\\n  url: \${API_URL}\\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sin variables, cada placeholder toma su default', () => {
    const configuration = loadConfiguration({ PROFILE: 'local' }, root);
    expect(configuration.server.port).toBe(8080);
    expect(configuration.server.shutdownTimeoutMs).toBe(30_000);
    expect(configuration.application.name).toBe('demo');
  });

  it('la variable de entorno gana al default', () => {
    const configuration = loadConfiguration({ PROFILE: 'local', SERVER_PORT: '9090' }, root);
    expect(configuration.server.port).toBe(9090);
  });

  it('una variable obligatoria sin valor no deja arrancar, y se nombran TODAS las que faltan', () => {
    expect(() => loadConfiguration({ PROFILE: 'production' }, root)).toThrow(/API_KEY \\(api\\.key\\).*API_URL \\(api\\.url\\)/);
  });

  it('con las obligatorias puestas, el perfil arranca', () => {
    const configuration = loadConfiguration({ PROFILE: 'production', API_KEY: 'k', API_URL: 'http://x' }, root);
    expect(configuration.get('api.key')).toBe('k');
  });

  it('duraciones con unidad', () => {
    expect(toMillis('500ms')).toBe(500);
    expect(toMillis('2m')).toBe(120_000);
    expect(() => toMillis('treinta')).toThrow();
  });
});
`;
}
