// El proyecto Node del servicio: package.json, TypeScript, Nest CLI y Vitest.
//
// Calcado de la plantilla ESM de `nest new` (@nestjs/schematics 12), que es lo que Nest considera
// un proyecto bien formado, con tres decisiones propias:
//   · `strict: true` siempre: el código lo escribe un agente, y lo que el compilador no le exige
//     no lo comprueba nadie más;
//   · sin linter ni formateador de la plantilla (oxlint, prettier): no son parte del servidor; el
//     gate de calidad que importa es la frontera hexagonal (dependency-cruiser, `check:architecture`);
//   · la inyección de dependencias NO depende de `emitDecoratorMetadata`: todo el código generado
//     inyecta con `@Inject(<token>)` explícito, así el arranque no cambia según qué herramienta
//     transforme el TypeScript (tsc al compilar, el transformador de Vitest en las pruebas).

import {
  NODE_VERSION,
  NODE_ENGINE,
  NEST_VERSION,
  NEST_CLI_VERSION,
  NEST_SCHEMATICS_VERSION,
  REFLECT_METADATA_VERSION,
  RXJS_VERSION,
  YAML_VERSION,
  TYPESCRIPT_VERSION,
  VITEST_VERSION,
  VITE_VERSION,
  TYPES_NODE_VERSION,
  DECIMAL_JS_VERSION,
  DEPENDENCY_CRUISER_VERSION,
  FASTIFY_VERSION,
  TYPEORM_VERSION,
  MONGODB_VERSION,
  HANDLEBARS_VERSION,
  NODEMAILER_VERSION,
  REDIS_CLIENT_VERSION,
  FASTIFY_MULTIPART_VERSION,
  PG_VERSION,
  MYSQL2_VERSION,
  JOSE_VERSION,
  AMQPLIB_VERSION,
  KAFKA_JAVASCRIPT_VERSION,
  AWS_SDK_VERSION,
  CRON_VERSION
} from '../lib/assets.js';
import { usesJwt } from './security.js';
import { usesRelational, usesDocument, engineOf } from './persistence-entities.js';
import { usesMail } from './mail.js';
import { usesCache } from './cache.js';
import { usesStorage, usesMultipart } from './storage.js';
import { usesKafka, usesRabbitMq, usesSnsSqs } from './messaging.js';
import { usesScheduling } from './scheduling.js';

export function generate(model) {
  return [
    { path: 'package.json', content: packageJson(model) },
    { path: 'tsconfig.json', content: tsconfig() },
    { path: 'tsconfig.build.json', content: tsconfigBuild() },
    { path: 'nest-cli.json', content: nestCli() },
    { path: 'vitest.config.ts', content: vitestConfig() },
    { path: '.nvmrc', content: `${NODE_VERSION}\n` },
    { path: '.gitignore', content: gitignore() }
  ];
}

function packageJson(model) {
  const { service } = model;
  const pkg = {
    name: service.artifactId,
    version: service.version,
    description: service.description,
    private: true,
    license: 'UNLICENSED',
    type: 'module',
    engines: { node: NODE_ENGINE },
    scripts: {
      build: 'nest build',
      start: 'node dist/main.js',
      'start:dev': 'nest start --watch',
      typecheck: 'tsc -p tsconfig.json --noEmit',
      test: 'vitest run',
      // Los flujos FL-* contra la infraestructura de infra/ (bash infra/up.sh); para puntuarlos,
      // bash infra/score-scenarios.sh.
      'test:integration': 'vitest run --config vitest.integration.config.ts',
      // La frontera hexagonal (.dependency-cruiser.json): dominio y aplicación sin framework.
      'check:architecture': 'depcruise src test/integration --config .dependency-cruiser.json'
    },
    dependencies: {
      '@nestjs/common': NEST_VERSION,
      '@nestjs/core': NEST_VERSION,
      '@nestjs/platform-fastify': NEST_VERSION,
      // El cliente de RabbitMQ del broker del stack (incremento 9).
      ...(usesRabbitMq(model) ? { amqplib: AMQPLIB_VERSION } : {}),
      ...(usesKafka(model) ? { '@confluentinc/kafka-javascript': KAFKA_JAVASCRIPT_VERSION } : {}),
      ...(usesSnsSqs(model) ? { '@aws-sdk/client-sns': AWS_SDK_VERSION, '@aws-sdk/client-sqs': AWS_SDK_VERSION } : {}),
      // El almacenamiento (incremento 13g): el SDK de S3 para el adaptador que escribe el agente (también MinIO), con
      // el firmante de URLs para los buckets privados, y el lector de la entrada multipart.
      ...(usesStorage(model) && model.stack?.storage ? { '@aws-sdk/client-s3': AWS_SDK_VERSION } : {}),
      ...(usesStorage(model) && model.stack?.storage && model.storage.hasPrivateBucket ? { '@aws-sdk/s3-request-presigner': AWS_SDK_VERSION } : {}),
      ...(usesMultipart(model) ? { '@fastify/multipart': FASTIFY_MULTIPART_VERSION } : {}),
      // El reloj: los barridos del diseño y las purgas de las tablas del generador (incremento 10b).
      ...(usesScheduling(model) ? { cron: CRON_VERSION } : {}),
      'decimal.js': DECIMAL_JS_VERSION,
      fastify: FASTIFY_VERSION,
      // La validación del JWT de la capa security contra el JWKS del proveedor.
      ...(usesJwt(model) ? { jose: JOSE_VERSION } : {}),
      'reflect-metadata': REFLECT_METADATA_VERSION,
      rxjs: RXJS_VERSION,
      yaml: YAML_VERSION,
      // La persistencia relacional: TypeORM y el driver del motor del stack.
      ...(usesRelational(model) ? { typeorm: TYPEORM_VERSION, ...(engineOf(model) === 'mysql' ? { mysql2: MYSQL2_VERSION } : { pg: PG_VERSION }) } : {}),
      // La persistencia documental: el driver oficial, sin ODM.
      ...(usesDocument(model) ? { mongodb: MONGODB_VERSION } : {}),
      // El correo (incremento 12e): el transporte SMTP y, con plantillas, el motor sin lógica.
      ...(usesMail(model) ? { nodemailer: NODEMAILER_VERSION } : {}),
      // La caché de lectura (incremento 13f): el cliente oficial de Redis, que también habla con Valkey.
      ...(usesCache(model) ? { '@redis/client': REDIS_CLIENT_VERSION } : {}),
      ...(usesMail(model) && model.mail.templating ? { handlebars: HANDLEBARS_VERSION } : {})
    },
    devDependencies: {
      '@nestjs/cli': NEST_CLI_VERSION,
      '@nestjs/schematics': NEST_SCHEMATICS_VERSION,
      '@nestjs/testing': NEST_VERSION,
      '@types/node': TYPES_NODE_VERSION,
      'dependency-cruiser': DEPENDENCY_CRUISER_VERSION,
      typescript: TYPESCRIPT_VERSION,
      vite: VITE_VERSION,
      vitest: VITEST_VERSION
    }
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function tsconfig() {
  const config = {
    compilerOptions: {
      module: 'nodenext',
      moduleResolution: 'nodenext',
      resolvePackageJsonExports: true,
      esModuleInterop: true,
      isolatedModules: true,
      declaration: true,
      removeComments: true,
      emitDecoratorMetadata: true,
      experimentalDecorators: true,
      allowSyntheticDefaultImports: true,
      target: 'ES2023',
      sourceMap: true,
      outDir: './dist',
      rootDir: '.',
      incremental: true,
      skipLibCheck: true,
      strict: true,
      strictPropertyInitialization: false,
      noImplicitOverride: true,
      types: ['vitest/globals', 'node']
    },
    include: ['src', 'test', 'vitest.config.ts', 'vitest.integration.config.ts']
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function tsconfigBuild() {
  const config = {
    extends: './tsconfig.json',
    compilerOptions: { rootDir: './src' },
    include: ['src'],
    exclude: ['node_modules', 'test', 'dist']
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function nestCli() {
  const config = {
    $schema: 'https://json.schemastore.org/nest-cli',
    collection: '@nestjs/schematics',
    sourceRoot: 'src',
    compilerOptions: { deleteOutDir: true, tsConfigPath: 'tsconfig.build.json' }
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function vitestConfig() {
  return `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.test.ts'],
    // Los flujos FL-* necesitan la infraestructura: van en su propia configuración.
    exclude: ['test/integration/**', 'node_modules/**'],
    // Las pruebas arrancan la aplicación bajo el perfil \`test\`, sin infraestructura externa.
    env: { PROFILE: 'test' }
  }
});
`;
}

function gitignore() {
  return `node_modules/
dist/
coverage/
*.log
.env
# Salida de build que no es del servidor: la versión nueva de un conflicto de --refresh,
# la base congelada del delta de diseño y las evidencias de los escenarios.
build/
`;
}
