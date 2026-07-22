// Integraciones HTTP salientes (capa http-clients). Por cada cliente genera de
// forma determinista: un RestClient configurado (base-url + timeouts), una
// interfaz + implementación con las llamadas parseadas del contract y las
// anotaciones resilience4j (@Retry/@CircuitBreaker) derivadas del diseño, y un
// record de respuesta por llamada. La resiliencia (timeouts, retry, circuit
// breaker) es enteramente derivable; el tipado fino de la respuesta y el cuerpo
// del fallback (negocio) quedan como // TODO (agente).

import { javaFile, javaPath, subPackage } from './render.js';

const HTTP_PKG = 'infrastructure.http';

export function generate(model) {
  if (!model.layersPresent.httpClients || !model.httpClients) return [];
  const files = [];
  for (const client of model.httpClients) {
    files.push(renderConfig(model, client));
    files.push(renderInterface(model, client));
    files.push(renderImpl(model, client));
    for (const call of client.calls) files.push(renderResponse(model, client, call));
  }
  return files;
}

// Parámetros Java de una llamada: las path vars como String + un body opcional
// para métodos con cuerpo (el agente tipa ambos según el contract).
function callParams(call) {
  const params = call.pathVars.map((v) => `String ${v}`);
  if (call.hasBody) params.push('Object body');
  return params;
}

function renderConfig(model, client) {
  const body = `@Configuration
public class ${client.configClass} {

    @Bean
    public RestClient ${client.beanName}(@Value("\${${client.baseUrlProperty}}") String baseUrl) {
        ClientHttpRequestFactorySettings settings = ClientHttpRequestFactorySettings.defaults()
                .withConnectTimeout(Duration.ofSeconds(5))
                .withReadTimeout(Duration.ofMillis(${client.readTimeoutMs}));
        return RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(ClientHttpRequestFactoryBuilder.detect().build(settings))
                .build();
    }
}`;
  return {
    path: javaPath(model, HTTP_PKG, client.configClass),
    content: javaFile(
      subPackage(model, HTTP_PKG),
      [
        'java.time.Duration',
        'org.springframework.beans.factory.annotation.Value',
        'org.springframework.boot.http.client.ClientHttpRequestFactoryBuilder',
        'org.springframework.boot.http.client.ClientHttpRequestFactorySettings',
        'org.springframework.context.annotation.Bean',
        'org.springframework.context.annotation.Configuration',
        'org.springframework.web.client.RestClient'
      ],
      body
    )
  };
}

function renderInterface(model, client) {
  const methods = client.calls
    .map((call) => `    /** ${call.contract} */
    ${call.responseType} ${call.name}(${callParams(call).join(', ')});`)
    .join('\n\n');

  const body = `/**
 * ${client.purpose}
 */
public interface ${client.clientClass} {

${methods}
}`;
  return {
    path: javaPath(model, HTTP_PKG, client.clientClass),
    content: javaFile(subPackage(model, HTTP_PKG), [], body)
  };
}

function renderImpl(model, client) {
  const imports = new Set([
    'org.springframework.beans.factory.annotation.Qualifier',
    'org.springframework.stereotype.Component',
    'org.springframework.web.client.RestClient'
  ]);

  const methods = client.calls.map((call) => renderCallMethod(call, imports)).join('\n\n');

  const body = `@Component
public class ${client.clientClass}Impl implements ${client.clientClass} {

    private final RestClient restClient;

    public ${client.clientClass}Impl(@Qualifier("${client.beanName}") RestClient restClient) {
        this.restClient = restClient;
    }

${methods}
}`;
  return {
    path: javaPath(model, HTTP_PKG, `${client.clientClass}Impl`),
    content: javaFile(subPackage(model, HTTP_PKG), [...imports], body)
  };
}

function renderCallMethod(call, imports) {
  const params = callParams(call);
  const hasFallback = Boolean(call.fallback || call.circuitBreaker);

  const annotations = ['    @Override'];
  if (call.retry) {
    imports.add('io.github.resilience4j.retry.annotation.Retry');
    const fb = hasFallback && !call.circuitBreaker ? `, fallbackMethod = "${call.fallbackMethod}"` : '';
    annotations.push(`    @Retry(name = "${call.instanceName}"${fb})`);
  }
  if (call.circuitBreaker) {
    imports.add('io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker');
    annotations.push(`    @CircuitBreaker(name = "${call.instanceName}", fallbackMethod = "${call.fallbackMethod}")`);
  }

  // Cuerpo de la llamada: si el contract trae método/ruta, se arma el RestClient
  // funcional (el agente afina el tipado de respuesta); si no, queda como stub.
  let callBody;
  if (call.method) {
    const verb = call.method.toLowerCase();
    const uriArgs = call.pathVars.length > 0 ? `, ${call.pathVars.join(', ')}` : '';
    const bodyStep = call.hasBody ? '\n                .body(body)' : '';
    callBody = `        // TODO (agente): ajusta ${call.responseType} y el request al contract
        //   ${call.contract}
        return restClient.${verb}()
                .uri("${call.path}"${uriArgs})${bodyStep}
                .retrieve()
                .body(${call.responseType}.class);`;
  } else {
    callBody = `        // TODO (agente): completar la llamada; el contract no declara método/ruta parseables
        //   ${call.contract}
        throw new UnsupportedOperationException("TODO: ${call.name}");`;
  }

  const method = `${annotations.join('\n')}
    public ${call.responseType} ${call.name}(${params.join(', ')}) {
${callBody}
    }`;

  if (!hasFallback) return method;

  const fallbackParams = [...params, 'Throwable throwable'];
  const fallbackDoc = call.fallback ? `        // TODO (agente): ${call.fallback}` : '        // TODO (agente): política de fallback del circuito abierto.';
  const fallback = `    private ${call.responseType} ${call.fallbackMethod}(${fallbackParams.join(', ')}) {
${fallbackDoc}
        throw new UnsupportedOperationException("TODO: fallback ${call.name}");
    }`;

  return `${method}\n\n${fallback}`;
}

function renderResponse(model, client, call) {
  const body = `/**
 * Respuesta de ${client.id}.${call.name}.
 * TODO (agente): declara los campos según el contract "${call.contract}".
 */
public record ${call.responseType}() {
}`;
  return {
    path: javaPath(model, HTTP_PKG, call.responseType),
    content: javaFile(subPackage(model, HTTP_PKG), [], body)
  };
}
