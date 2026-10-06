// Arranque del servicio: main.ts, el módulo raíz y la plataforma HTTP (Fastify).
//
// La configuración se carga y se valida ANTES de crear la aplicación: un servicio mal configurado
// tiene que morir en el arranque, no en la primera petición que lea el valor que falta. El módulo
// raíz la recibe ya resuelta (`AppModule.register`) y es el único sitio que cablea controladores y
// proveedores.
//
// Fastify y no Express: más rendimiento con el mismo código de Nest, y sobre todo UN punto de
// lectura de cuerpos y UN punto de escritura de respuestas, que es donde se cumple el contrato del
// cable (los decimales con su escala, los enteros de 64 bits). La configuración HTTP vive en
// `http-platform.ts` y la usan igual `main.ts` y las pruebas: si cada uno montara la suya, las
// pruebas medirían otro servidor.

export const HTTP_PLATFORM_TS = 'src/infrastructure/http/http-platform.ts';

export function generate() {
  return [
    { path: 'src/main.ts', content: mainTs() },
    { path: 'src/app.module.ts', content: appModuleTs() },
    { path: HTTP_PLATFORM_TS, content: httpPlatformTs() }
  ];
}

function mainTs() {
  return `import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { loadConfiguration } from './infrastructure/config/configuration.js';
import { HTTP_APPLICATION_OPTIONS, configureHttp, createHttpAdapter } from './infrastructure/http/http-platform.js';

const configuration = loadConfiguration();
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule.register(configuration),
  createHttpAdapter(),
  HTTP_APPLICATION_OPTIONS
);
configureHttp(app);
// SIGTERM/SIGINT cierran la aplicación de forma ordenada (ver GracefulShutdown).
app.enableShutdownHooks();
// Fastify escucha por defecto solo en 127.0.0.1: dentro de un contenedor nadie llegaría.
await app.listen(configuration.server.port, configuration.server.address);
`;
}

function appModuleTs() {
  return `import { Module, type DynamicModule } from '@nestjs/common';
import { CONFIGURATION, type Configuration } from './infrastructure/config/configuration.js';
import { HealthController } from './infrastructure/health/health.controller.js';
import { GracefulShutdown } from './infrastructure/health/graceful-shutdown.js';

@Module({})
export class AppModule {
  static register(configuration: Configuration): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: CONFIGURATION, useValue: configuration }, GracefulShutdown]
    };
  }
}
`;
}

function httpPlatformTs() {
  return `import { BadRequestException } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { parseWireJson, toWireJson } from '../../application/support/wire.js';

/** El adaptador HTTP del servicio. */
export function createHttpAdapter(): FastifyAdapter {
  return new FastifyAdapter();
}

/**
 * Opciones de creación de la aplicación. Sin el parser de cuerpos de Nest: el JSON lo lee el
 * contrato del cable (\`configureHttp\`), que no pierde la precisión de los números.
 */
export const HTTP_APPLICATION_OPTIONS = { bodyParser: false } as const;

/**
 * Conecta el contrato del cable a Fastify: el lector de \`application/json\` y el serializador de
 * TODAS las respuestas. Se llama antes de \`init()\`/\`listen()\`, en el arranque y en las pruebas.
 */
export function configureHttp(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance();
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, parseWireJson(body as string));
    } catch {
      // Una excepción HTTP de Nest y no un Error con statusCode: con Nest delante, cualquier otro
      // error de Fastify se trata como interno y sale como 500.
      done(new BadRequestException('El cuerpo de la petición no es JSON válido'), undefined);
    }
  });
  fastify.setReplySerializer((payload) => toWireJson(payload));
}
`;
}
