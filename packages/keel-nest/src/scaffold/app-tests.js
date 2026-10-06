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

export function generate() {
  return [
    { path: 'test/application.test.ts', content: applicationTestTs() },
    { path: 'test/configuration.test.ts', content: configurationTestTs() }
  ];
}

function applicationTestTs() {
  return `import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { loadConfiguration } from '../src/infrastructure/config/configuration.js';
import { GracefulShutdown } from '../src/infrastructure/health/graceful-shutdown.js';

describe('aplicación', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const configuration = loadConfiguration({ ...process.env, PROFILE: 'test' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(configuration)] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('arranca bajo el perfil test y está viva', async () => {
    await request(app.getHttpServer()).get('/livez').expect(200, { status: 'UP' });
  });

  it('acepta tráfico mientras no drena', async () => {
    await request(app.getHttpServer()).get('/readyz').expect(200, { status: 'UP' });
  });

  it('al empezar a drenar deja de aceptar tráfico, pero sigue viva', async () => {
    app.get(GracefulShutdown).startDraining();
    await request(app.getHttpServer()).get('/readyz').expect(503, { status: 'OUT_OF_SERVICE' });
    await request(app.getHttpServer()).get('/livez').expect(200, { status: 'UP' });
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
