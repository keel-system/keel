// Arranque del servicio: main.ts y el módulo raíz.
//
// La configuración se carga y se valida ANTES de crear la aplicación: un servicio mal
// configurado tiene que morir en el arranque, no en la primera petición que lea el valor que
// falta. El módulo raíz la recibe ya resuelta (`AppModule.register`) y es el único sitio que
// cablea controladores y proveedores.

export function generate() {
  return [
    { path: 'src/main.ts', content: mainTs() },
    { path: 'src/app.module.ts', content: appModuleTs() }
  ];
}

function mainTs() {
  return `import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfiguration } from './infrastructure/config/configuration.js';

const configuration = loadConfiguration();
const app = await NestFactory.create(AppModule.register(configuration));
// SIGTERM/SIGINT cierran la aplicación de forma ordenada (ver GracefulShutdown).
app.enableShutdownHooks();
await app.listen(configuration.server.port);
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
