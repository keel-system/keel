// La configuración de la telemetría por perfil (`config/parameters/<perfil>/telemetry.yaml`): el muestreo, el colector
// al que salen las trazas (y los logs, con LOG_EXPORT_OTLP), el scrape de las métricas, el recurso y los interruptores
// de la instrumentación opcional.
//
// Las MISMAS variables y defaults que el `telemetry.yaml` de keel-spring: un mismo `.env` despliega los tres servidores.
// Lo que solo tiene keel-spring —el push de métricas por OTLP, una salida apagada por defecto— no se declara. La
// comparten keel-nest y keel-dotnet; estaba escrita en keel-nest y salió aquí al llegar el tercer generador
// (PLAN-KEEL-DOTNET.md, incremento 14c).

import { collectorHostEndpoint, TELEMETRY_INFRA } from './infra-catalog.js';
import { METRICS_TRANSPORT, instrumentationFor } from './telemetry-vocabulary.js';
import { envWithDefault } from './profile-values.js';
import { envFor } from './runtime-env.js';

/** El `telemetry.yaml` de un perfil. `generator` es el nombre que firma la cabecera. */
export function telemetryYaml(model, profile, { generator }) {
  const endpointVar = TELEMETRY_INFRA.endpointVar;
  const endpoint = profile === 'production' ? `\${${endpointVar}}` : `\${${endpointVar}:${collectorHostEndpoint()}}`;
  const exportEnabled = `\${TELEMETRY_EXPORT_ENABLED:${profile === 'local' || profile === 'test' ? 'false' : 'true'}}`;
  const sampling = profile === 'production' ? '0.1' : '1.0';
  const lines = [
    `# Generado por ${generator} build. La telemetría en el perfil ${profile}: trazas (y logs, con LOG_EXPORT_OTLP)`,
    '# por OTLP/HTTP a un colector; las métricas las viene a buscar el colector. Cambiar de backend es cambiar',
    '# el COLECTOR, no este archivo.',
    'telemetry:',
    '  tracing:',
    '    # Parent-based: se respeta la decisión de quien llama; la proporción solo decide en las raíces.',
    `    sampling-probability: ${envFor('TRACING_SAMPLING_PROBABILITY', profile, sampling)}`,
    '  export:',
    `    enabled: ${exportEnabled}`,
    `    endpoint: ${endpoint}`,
    '  logs:',
    '    # Apagado: el canal primario de los logs es la consola. Encenderlo además de recogerla duplica cada línea.',
    '    export-enabled: ${LOG_EXPORT_OTLP:false}',
    '  metrics:',
    `    prometheus-enabled: ${envWithDefault(profile, METRICS_TRANSPORT.prometheus.envVar, 'true')}`,
    '  resource:',
    `    service-version: "${model.service.version}"`,
    `    deployment-environment: ${envFor('DEPLOYMENT_ENVIRONMENT', profile, profile)}`,
    // Qué réplica emitió cada señal; en local hay una sola instancia.
    ...(profile === 'local' ? [] : ['    service-instance-id: ${SERVICE_INSTANCE_ID:${HOSTNAME:unknown}}'])
  ];
  if (profile === 'production') {
    lines.push(
      'management:',
      '  server:',
      `    # Puerto del scrape, distinto del de negocio. NO se publica fuera del pod/host: solo lo alcanza el`,
      `    # colector que viene a leer ${METRICS_TRANSPORT.scrapePath}.`,
      `    port: ${envFor('MANAGEMENT_PORT', profile)}`
    );
  }
  const switches = instrumentationFor(model);
  if (switches.length > 0) {
    lines.push('keel:', '  telemetry:', '    # Instrumentación opcional: se apaga por ENTORNO y cambia al reiniciar.', '    instrumentation:');
    for (const entry of switches) {
      lines.push(`      # ${entry.label}`, `      ${entry.id}:`, `        enabled: ${envWithDefault(profile, entry.envVar, 'true')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
