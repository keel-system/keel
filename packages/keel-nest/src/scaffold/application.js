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

import { usesMediator } from './mediator.js';
import { usesApi } from './rest-support.js';
import { controllerClasses } from './controllers.js';
import { relativeSpecifier } from './render.js';
import { usesPersistence } from './persistence-entities.js';
import { usesIdempotencyHeader } from './request-idempotency.js';
import { usesHttpSecurity, usesCallerScope, usesSecurityModule } from './security.js';
import { usesMessaging } from './messaging.js';
import { usesScheduling } from './scheduling.js';
import { usesServiceParameters } from './service-parameters.js';
import { usesHttpClients } from './http-clients.js';
import { usesMail } from './mail.js';
import { paymentControllers, usesPayments } from './payments.js';
import { PAYMENT_NOTICE_PATH } from 'keel-core/gen/payment-gateways';

export function generate(model) {
  return [
    { path: 'src/main.ts', content: mainTs() },
    { path: 'src/app.module.ts', content: appModuleTs(usesMediator(model), [...controllerClasses(model), ...paymentControllers(model)], usesPersistence(model), usesSecurityModule(model), usesMessaging(model) && usesPersistence(model), usesScheduling(model), usesServiceParameters(model), usesHttpClients(model), usesMail(model), usesPayments(model)) },
    { path: HTTP_PLATFORM_TS, content: httpPlatformTs(usesApi(model), usesApi(model) && usesIdempotencyHeader(model), usesHttpSecurity(model), usesPayments(model)) }
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

function appModuleTs(withUseCases, controllers, withPersistence, withCallerScope = false, withMessaging = false, withScheduling = false, withParameters = false, withHttpClients = false, withMail = false, withPayments = false) {
  // Los casos de uso del diseño entran por su módulo (infrastructure/usecase), que es el único que
  // cablea handlers y mappers; los controladores REST los despachan por el mediator que exporta. La
  // persistencia y el alcance por recurso (globales) van antes: son dependencias de los handlers.
  const useCaseImport =
    (withParameters ? "\nimport { ServiceParametersModule } from './infrastructure/config/service-parameters-module.js';" : '') +
    (withPersistence ? "\nimport { PersistenceModule } from './infrastructure/persistence/persistence-module.js';" : '') +
    (withMessaging
      ? "\nimport { MessagingModule } from './infrastructure/messaging/messaging-module.js';" +
        "\nimport { MessageListenersModule } from './infrastructure/messaging/message-listeners-module.js';"
      : '') +
    (withHttpClients ? "\nimport { HttpClientsModule } from './infrastructure/clients/http-clients-module.js';" : '') +
    (withMail ? "\nimport { MailModule } from './infrastructure/mail/mail-module.js';" : '') +
    (withPayments ? "\nimport { PaymentsModule } from './infrastructure/payment/payments-module.js';" : '') +
    (withCallerScope ? "\nimport { SecurityModule } from './infrastructure/security/security-module.js';" : '') +
    (withUseCases ? "\nimport { UseCaseModule } from './infrastructure/usecase/use-case-module.js';" : '') +
    (withScheduling ? "\nimport { SchedulingModule } from './infrastructure/scheduling/scheduling-module.js';" : '');
  const modules = [
    // Los parámetros de despliegue (globales): los inyectan los handlers.
    withParameters ? 'ServiceParametersModule.register(configuration)' : null,
    withPersistence ? 'PersistenceModule.register(configuration)' : null,
    // La mensajería (global, como la persistencia): el puente lo usan los adaptadores de repositorio.
    withMessaging ? 'MessagingModule.register(configuration)' : null,
    // Los clientes HTTP salientes (globales): los handlers inyectan sus puertos.
    withHttpClients ? 'HttpClientsModule.register(configuration)' : null,
    // El correo saliente (global): los handlers de mail.sentBy inyectan sus puertos.
    withMail ? 'MailModule.register(configuration)' : null,
    // La pasarela de pago (global): los handlers inyectan el puerto PaymentGateway.
    withPayments ? 'PaymentsModule.register(configuration)' : null,
    withCallerScope ? 'SecurityModule' : null,
    withUseCases ? 'UseCaseModule' : null,
    // Los listeners del agente despachan por el mediator: van después de los casos de uso.
    withMessaging ? 'MessageListenersModule' : null,
    // El reloj despacha por el mediator y purga con el DataSource: va el último.
    withScheduling ? 'SchedulingModule.register(configuration)' : null
  ].filter(Boolean);
  const useCaseModule = modules.length > 0 ? `\n      imports: [${modules.join(', ')}],` : '';
  const controllerImports = controllers
    .map((controller) => `\nimport { ${controller.symbol} } from '${relativeSpecifier('src/app.module.ts', controller.from)}';`)
    .join('');
  const controllerList = ['HealthController', ...controllers.map((controller) => controller.symbol)].join(', ');
  return `import { Module, type DynamicModule } from '@nestjs/common';
import { CONFIGURATION, type Configuration } from './infrastructure/config/configuration.js';
import { HealthController } from './infrastructure/health/health.controller.js';
import { GracefulShutdown } from './infrastructure/health/graceful-shutdown.js';${useCaseImport}${controllerImports}

@Module({})
export class AppModule {
  static register(configuration: Configuration): DynamicModule {
    return {
      module: AppModule,${useCaseModule}
      controllers: [${controllerList}],
      providers: [{ provide: CONFIGURATION, useValue: configuration }, GracefulShutdown]
    };
  }
}
`;
}

function httpPlatformTs(withApi, withIdempotencyHeader = false, withSecurity = false, withPayments = false) {
  // El aviso de la pasarela de pago se verifica sobre el texto TAL COMO LLEGÓ: la firma no sobrevive a un JSON
  // leído y vuelto a escribir. Esa ruta recibe el cuerpo sin leer (PaymentNoticeController).
  const noticeExemption = withPayments
    ? `
    if (request.url.split('?')[0] === '${PAYMENT_NOTICE_PATH}') {
      done(null, body);
      return;
    }`
    : '';
  // Con API, la entrada HTTP abre además la correlación de la petición y todo fallo sale por el
  // filtro de errores del contrato (ErrorResponse). Sin API no hay nada que correlacionar ni traducir.
  const apiImports = withApi
    ? `
import { ApiExceptionFilter } from '../rest/api-exception-filter.js';
import { CORRELATION_HEADER, CorrelationContext } from '../correlation/correlation-context.js';${
      withIdempotencyHeader ? "\nimport { IDEMPOTENCY_HEADER, IdempotencyContext } from '../../application/support/idempotency-context.js';" : ''
    }${
      withSecurity
        ? "\nimport { CONFIGURATION, type Configuration } from '../config/configuration.js';\nimport { installSecurity } from '../security/http-security.js';"
        : ''
    }`
    : '';
  const apiSetup = withApi
    ? `
  // La correlación: el X-Correlation-Id recibido si cumple el formato, uno nuevo si no; el EFECTIVO
  // vuelve en la respuesta y queda abierto (AsyncLocalStorage) para todo lo que haga la petición.
  fastify.addHook('onRequest', (request, reply, done) => {
    const correlationId = CorrelationContext.accept(request.headers[CORRELATION_HEADER.toLowerCase()]);
    void reply.header(CORRELATION_HEADER, correlationId);
    ${
      withIdempotencyHeader
        ? `// Y la clave de idempotencia (keySource: client-key), para el handler que la use: sin cabecera no se
    // abre nada y la operación se ejecuta sin deduplicar.
    const idempotencyKey = request.headers[IDEMPOTENCY_HEADER.toLowerCase()];
    CorrelationContext.runWith(correlationId, () => IdempotencyContext.runWith(idempotencyKey, done));`
        : 'CorrelationContext.runWith(correlationId, done);'
    }
  });${
    withSecurity
      ? `
  // La seguridad (capa security): quién llama y qué puede pedir, decidido ANTES de enrutar y después
  // de abrir la correlación, para que un 401 o un 403 lleven su correlationId.
  installSecurity(fastify, app.get<Configuration>(CONFIGURATION));`
      : ''
  }
  // Todo fallo, también los de lectura de la petición y las rutas que no existen, sale como ErrorResponse.
  app.useGlobalFilters(new ApiExceptionFilter());`
    : '';
  return `import { BadRequestException } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { parseWireJson, toWireJson } from '../../application/support/wire.js';${apiImports}

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
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (${withPayments ? 'request' : '_request'}, body, done) => {${noticeExemption}
    try {
      done(null, parseWireJson(body as string));
    } catch {
      // Una excepción HTTP de Nest y no un Error con statusCode: con Nest delante, cualquier otro
      // error de Fastify se trata como interno y sale como 500.
      done(new BadRequestException('El cuerpo de la petición no es JSON válido'), undefined);
    }
  });
  fastify.setReplySerializer((payload) => toWireJson(payload));${apiSetup}
}
`;
}
