// Sondas de vida y de disponibilidad, y el apagado ordenado.
//
// El contrato es el del servidor de keel-spring del mismo diseño: `GET /livez` y `GET /readyz` en
// el puerto principal, con cuerpo `{"status":"UP"}`; mientras el servicio drena tras un SIGTERM,
// `/readyz` responde 503 con `{"status":"OUT_OF_SERVICE"}`, que es lo que saca la instancia del
// balanceador antes de que deje de aceptar conexiones. Un orquestador o un HEALTHCHECK escritos
// contra uno de los dos servidores sirven para el otro.

export function generate() {
  return [
    { path: 'src/infrastructure/health/health.controller.ts', content: controllerTs() },
    { path: 'src/infrastructure/health/graceful-shutdown.ts', content: shutdownTs() }
  ];
}

function controllerTs() {
  return `import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { GracefulShutdown } from './graceful-shutdown.js';

export interface HealthStatus {
  readonly status: 'UP' | 'OUT_OF_SERVICE';
}

@Controller()
export class HealthController {
  constructor(@Inject(GracefulShutdown) private readonly shutdown: GracefulShutdown) {}

  /** El proceso está vivo. No consulta dependencias: si fallara por ellas, el orquestador lo reiniciaría sin motivo. */
  @Get('livez')
  livez(): HealthStatus {
    return { status: 'UP' };
  }

  /** El proceso acepta tráfico. Deja de hacerlo en cuanto empieza el apagado ordenado. */
  @Get('readyz')
  readyz(): HealthStatus {
    if (this.shutdown.draining) {
      throw new HttpException({ status: 'OUT_OF_SERVICE' } satisfies HealthStatus, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: 'UP' };
  }
}
`;
}

function shutdownTs() {
  return `import { Inject, Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import { CONFIGURATION, type Configuration } from '../config/configuration.js';

/**
 * Apagado ordenado. Al recibir la señal, el servicio pasa a drenar (\`/readyz\` responde 503) y
 * Nest cierra el servidor HTTP, que deja de aceptar conexiones y espera a las peticiones en vuelo.
 * Si no terminan en \`server.shutdown-timeout\`, el proceso sale con error: un apagado que no
 * termina nunca bloquea el despliegue siguiente.
 */
@Injectable()
export class GracefulShutdown implements BeforeApplicationShutdown {
  private readonly logger = new Logger(GracefulShutdown.name);
  private drainingSince: number | null = null;

  constructor(@Inject(CONFIGURATION) private readonly configuration: Configuration) {}

  get draining(): boolean {
    return this.drainingSince !== null;
  }

  /** Deja de aceptar tráfico: \`/readyz\` pasa a 503. Separado del tope para poder probarlo sin señal. */
  startDraining(): void {
    this.drainingSince ??= Date.now();
  }

  beforeApplicationShutdown(signal?: string): void {
    this.startDraining();
    const timeoutMs = this.configuration.server.shutdownTimeoutMs;
    this.logger.log(\`Apagado ordenado (\${signal ?? 'cierre'}): margen de \${timeoutMs} ms para las peticiones en vuelo\`);
    const deadline = setTimeout(() => {
      this.logger.error(\`El apagado superó \${timeoutMs} ms: se fuerza la salida\`);
      process.exit(1);
    }, timeoutMs);
    // El temporizador no mantiene vivo el proceso: si todo termina antes, sale sin esperarlo.
    deadline.unref();
  }
}
`;
}
