// Integraciones HTTP salientes (capa http-clients), con el mismo patrón
// hexagonal que repositorios, storage y publishers: el PUERTO <Cliente>Client
// vive en domain/clients junto a los records <Llamada>Result (resultado en
// términos del dominio); el adaptador <Cliente>HttpAdapter, los DTOs wire
// (<Llamada>Request/<Llamada>Response, el contrato del tercero tal cual) y el
// mapper de anticorrupción <Cliente>Mapper viven en infrastructure/http. Si el
// sistema externo cambia su contrato, solo cambian wire DTOs, adaptador y
// mapper — nunca el dominio ni los use cases.
// Con method/path/request/response estructurados en el diseño todo es
// derivable (llamada, records tipados, mapeo campo a campo); con contract
// solo-prosa quedan records vacíos y mapeo como // TODO (agente). La lógica de
// negocio del fallback siempre es del agente. La auth saliente declarada
// (api-key, bearer, basic, oauth2 client-credentials) se aplica en el bean
// RestClient; las credenciales llegan por configuración, nunca del diseño.

import { javaFile, javaPath, subPackage } from './render.js';
import { domainTypeImport } from './entities.js';

const PORT_PKG = 'domain.clients';
const HTTP_PKG = 'infrastructure.http';

export function generate(model) {
  if (!model.layersPresent.httpClients || !model.httpClients) return [];
  const files = [];
  if (model.httpClients.some((client) => client.auth?.type === 'oauth2-client-credentials')) {
    files.push(renderOAuth2Config(model));
  }
  for (const client of model.httpClients) {
    files.push(renderConfig(model, client));
    files.push(renderPort(model, client));
    files.push(renderMapper(model, client));
    files.push(renderAdapter(model, client));
    for (const call of client.calls) {
      files.push(renderResult(model, client, call));
      files.push(renderResponse(model, client, call));
      if (call.requestType) files.push(renderRequest(model, client, call));
    }
  }
  return files;
}

// Parámetros de una llamada (mismos en puerto y adaptador): path/query/header
// params tipados + los campos del body como parámetros individuales (el
// adaptador arma el wire request con el mapper). Legacy solo-prosa: path vars
// String + Object body si el método lo admite.
function callParams(call) {
  const params = [
    ...call.pathParams.map((f) => ({ decl: `${f.javaType} ${f.name}`, field: f })),
    ...call.queryParams.map((f) => ({ decl: `${f.javaType} ${f.name}`, field: f })),
    ...call.headerParams.map((f) => ({ decl: `${f.javaType} ${f.name}`, field: f })),
    ...call.bodyFields.map((f) => ({ decl: `${f.javaType} ${f.name}`, field: f }))
  ];
  if (call.hasBody && !call.requestType) params.push({ decl: 'Object body', field: null });
  return params;
}

function addFieldImports(model, imports, fields) {
  for (const field of fields) {
    for (const name of field.imports ?? []) imports.add(name);
    const typeImport = domainTypeImport(model, field);
    if (typeImport) imports.add(typeImport);
  }
}

function callFields(call) {
  return [...call.pathParams, ...call.queryParams, ...call.headerParams, ...call.bodyFields];
}

// ─── Configuración del RestClient (base-url, timeouts, auth saliente) ────────

function renderConfig(model, client) {
  const imports = new Set([
    'java.time.Duration',
    'org.springframework.beans.factory.annotation.Value',
    'org.springframework.boot.http.client.ClientHttpRequestFactoryBuilder',
    'org.springframework.boot.http.client.ClientHttpRequestFactorySettings',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.web.client.RestClient'
  ]);

  const beanParams = [`@Value("\${${client.baseUrlProperty}}") String baseUrl`];
  const builderSteps = [];
  const preamble = [];
  const auth = client.auth;
  if (auth?.type === 'api-key') {
    // Default vacío: el contexto (perfil test) arranca sin credenciales reales.
    beanParams.push(`@Value("\${${auth.propertyPrefix}.api-key:}") String apiKey`);
    builderSteps.push(`.defaultHeader("${auth.headerName}", apiKey)`);
  } else if (auth?.type === 'bearer-static') {
    imports.add('org.springframework.http.HttpHeaders');
    beanParams.push(`@Value("\${${auth.propertyPrefix}.token:}") String token`);
    builderSteps.push('.defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + token)');
  } else if (auth?.type === 'basic') {
    beanParams.push(
      `@Value("\${${auth.propertyPrefix}.username:}") String username`,
      `@Value("\${${auth.propertyPrefix}.password:}") String password`
    );
    builderSteps.push('.defaultHeaders(headers -> headers.setBasicAuth(username, password))');
  } else if (auth?.type === 'oauth2-client-credentials') {
    imports.add('org.springframework.security.oauth2.client.OAuth2AuthorizedClientManager');
    imports.add('org.springframework.security.oauth2.client.web.client.OAuth2ClientHttpRequestInterceptor');
    beanParams.push('OAuth2AuthorizedClientManager httpClientsAuthorizedClientManager');
    preamble.push(
      `        OAuth2ClientHttpRequestInterceptor oauth2 =`,
      `                new OAuth2ClientHttpRequestInterceptor(httpClientsAuthorizedClientManager);`,
      `        oauth2.setClientRegistrationIdResolver(request -> "${auth.registrationId}");`
    );
    builderSteps.push('.requestInterceptor(oauth2)');
  }

  const body = `@Configuration
public class ${client.configClass} {

    @Bean
    public RestClient ${client.beanName}(
            ${beanParams.join(',\n            ')}) {
        ClientHttpRequestFactorySettings settings = ClientHttpRequestFactorySettings.defaults()
                .withConnectTimeout(Duration.ofSeconds(5))
                .withReadTimeout(Duration.ofMillis(${client.readTimeoutMs}));
${preamble.length > 0 ? preamble.join('\n') + '\n' : ''}        return RestClient.builder()
                .baseUrl(baseUrl)
${builderSteps.map((s) => `                ${s}`).join('\n')}${builderSteps.length > 0 ? '\n' : ''}                .requestFactory(ClientHttpRequestFactoryBuilder.detect().build(settings))
                .build();
    }
}`;
  return {
    path: javaPath(model, HTTP_PKG, client.configClass),
    content: javaFile(subPackage(model, HTTP_PKG), [...imports], body)
  };
}

// Manager compartido para los clientes con oauth2-client-credentials; las
// ClientRegistration salen de spring.security.oauth2.client.* (parameters/).
function renderOAuth2Config(model) {
  const body = `/**
 * OAuth2 saliente (clientes http-clients con auth oauth2-client-credentials):
 * manager de client_credentials compartido por los beans RestClient. Las
 * registrations viven en spring.security.oauth2.client.* (parameters/).
 */
@Configuration
public class HttpClientsOAuth2Config {

    @Bean
    public OAuth2AuthorizedClientManager httpClientsAuthorizedClientManager(
            ClientRegistrationRepository clientRegistrationRepository,
            OAuth2AuthorizedClientService authorizedClientService) {
        AuthorizedClientServiceOAuth2AuthorizedClientManager manager =
                new AuthorizedClientServiceOAuth2AuthorizedClientManager(clientRegistrationRepository, authorizedClientService);
        manager.setAuthorizedClientProvider(
                OAuth2AuthorizedClientProviderBuilder.builder().clientCredentials().build());
        return manager;
    }
}`;
  return {
    path: javaPath(model, HTTP_PKG, 'HttpClientsOAuth2Config'),
    content: javaFile(
      subPackage(model, HTTP_PKG),
      [
        'org.springframework.context.annotation.Bean',
        'org.springframework.context.annotation.Configuration',
        'org.springframework.security.oauth2.client.AuthorizedClientServiceOAuth2AuthorizedClientManager',
        'org.springframework.security.oauth2.client.OAuth2AuthorizedClientManager',
        'org.springframework.security.oauth2.client.OAuth2AuthorizedClientProviderBuilder',
        'org.springframework.security.oauth2.client.OAuth2AuthorizedClientService',
        'org.springframework.security.oauth2.client.registration.ClientRegistrationRepository'
      ],
      body
    )
  };
}

// ─── Puerto en domain/clients ────────────────────────────────────────────────

function renderPort(model, client) {
  const imports = new Set();
  const methods = client.calls
    .map((call) => {
      addFieldImports(model, imports, callFields(call));
      return `    /** ${call.contract} */
    ${call.resultType} ${call.name}(${callParams(call).map((p) => p.decl).join(', ')});`;
    })
    .join('\n\n');

  const body = `/**
 * ${client.purpose}
 * Puerto de salida del dominio; el adaptador HTTP (${client.adapterClass})
 * vive en infrastructure/http.
 */
public interface ${client.clientClass} {

${methods}
}`;
  return {
    path: javaPath(model, PORT_PKG, client.clientClass),
    content: javaFile(subPackage(model, PORT_PKG), [...imports], body)
  };
}

// Resultado de la llamada en términos del dominio (lo que ven los use cases);
// la forma wire del tercero queda aislada en infrastructure/http.
function renderResult(model, client, call) {
  const imports = new Set();
  addFieldImports(model, imports, call.responseFields);
  const components = call.responseFields.map((f) => `${f.javaType} ${f.name}`).join(', ');
  const todo = call.responseFields.length === 0
    ? `\n * TODO (agente): declara los campos según el contract "${call.contract}".`
    : '';

  const body = `/**
 * Resultado de ${client.id}.${call.name} en términos del dominio.${todo}
 */
public record ${call.resultType}(${components}) {
}`;
  return {
    path: javaPath(model, PORT_PKG, call.resultType),
    content: javaFile(subPackage(model, PORT_PKG), [...imports], body)
  };
}

// ─── Capa de anticorrupción (mapper wire ↔ dominio) ──────────────────────────

function renderMapper(model, client) {
  const imports = new Set(['org.springframework.stereotype.Component']);
  const portPkg = subPackage(model, PORT_PKG);
  const methods = [];

  for (const call of client.calls) {
    imports.add(`${portPkg}.${call.resultType}`);
    addFieldImports(model, imports, call.responseFields);
    const pascal = call.resultType.replace(/Result$/, '');
    if (call.responseFields.length > 0) {
      const args = call.responseFields.map((f) => `response.${f.name}()`).join(', ');
      methods.push(`    /** Traduce la respuesta wire de ${call.name} al resultado del dominio. */
    public ${call.resultType} to${pascal}Result(${call.responseType} response) {
        return new ${call.resultType}(${args});
    }`);
    } else {
      methods.push(`    /** Traduce la respuesta wire de ${call.name} al resultado del dominio. */
    public ${call.resultType} to${pascal}Result(${call.responseType} response) {
        // TODO (agente): mapea la respuesta del contract "${call.contract}" al resultado del dominio.
        return new ${call.resultType}();
    }`);
    }
    if (call.requestType) {
      addFieldImports(model, imports, call.bodyFields);
      const params = call.bodyFields.map((f) => `${f.javaType} ${f.name}`).join(', ');
      const args = call.bodyFields.map((f) => f.name).join(', ');
      methods.push(`    /** Arma el body wire de ${call.name} desde los valores del dominio. */
    public ${call.requestType} to${pascal}Request(${params}) {
        return new ${call.requestType}(${args});
    }`);
    }
  }

  const body = `/**
 * Capa de anticorrupción de ${client.id}: traduce entre el contrato wire del
 * sistema externo y los tipos del dominio. Si el tercero cambia su contrato,
 * el cambio se absorbe aquí (y en los DTOs wire), nunca en el dominio.
 */
@Component
public class ${client.mapperClass} {

${methods.join('\n\n')}
}`;
  return {
    path: javaPath(model, HTTP_PKG, client.mapperClass),
    content: javaFile(subPackage(model, HTTP_PKG), [...imports], body)
  };
}

// ─── Adaptador RestClient (implementa el puerto) ─────────────────────────────

function renderAdapter(model, client) {
  const imports = new Set([
    'org.springframework.beans.factory.annotation.Qualifier',
    'org.springframework.stereotype.Component',
    'org.springframework.web.client.RestClient',
    `${subPackage(model, PORT_PKG)}.${client.clientClass}`
  ]);
  for (const call of client.calls) {
    imports.add(`${subPackage(model, PORT_PKG)}.${call.resultType}`);
  }

  const methods = client.calls.map((call) => renderCallMethod(model, client, call, imports)).join('\n\n');

  const body = `@Component
public class ${client.adapterClass} implements ${client.clientClass} {

    private final RestClient restClient;
    private final ${client.mapperClass} mapper;

    public ${client.adapterClass}(@Qualifier("${client.beanName}") RestClient restClient, ${client.mapperClass} mapper) {
        this.restClient = restClient;
        this.mapper = mapper;
    }

${methods}
}`;
  return {
    path: javaPath(model, HTTP_PKG, client.adapterClass),
    content: javaFile(subPackage(model, HTTP_PKG), [...imports], body)
  };
}

function renderCallMethod(model, client, call, imports) {
  addFieldImports(model, imports, callFields(call));
  const params = callParams(call).map((p) => p.decl);
  const hasFallback = Boolean(call.fallback || call.circuitBreaker);
  const pascal = call.resultType.replace(/Result$/, '');

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

  let callBody;
  if (call.method) {
    const verb = call.method.toLowerCase();
    const buildArgs = call.pathParams.map((f) => f.name).join(', ');
    let uriStep;
    if (call.queryParams.length > 0) {
      const querySteps = call.queryParams.map((f) => `.queryParam("${f.name}", ${f.name})`).join('');
      uriStep = `.uri(uri -> uri.path("${call.path}")${querySteps}.build(${buildArgs}))`;
    } else {
      uriStep = `.uri("${call.path}"${buildArgs ? `, ${buildArgs}` : ''})`;
    }
    const headerSteps = call.headerParams
      .map((f) => `\n                .header("${f.name}", ${f.javaType === 'String' ? f.name : `String.valueOf(${f.name})`})`)
      .join('');
    let bodyStep = '';
    if (call.requestType) {
      const args = call.bodyFields.map((f) => f.name).join(', ');
      bodyStep = `\n                .body(mapper.to${pascal}Request(${args}))`;
    } else if (call.hasBody) {
      bodyStep = '\n                .body(body)';
    }
    const todo = call.typed
      ? ''
      : `        // TODO (agente): ajusta ${call.responseType} y el request al contract\n        //   ${call.contract}\n`;
    callBody = `${todo}        ${call.responseType} response = restClient.${verb}()
                ${uriStep}${headerSteps}${bodyStep}
                .retrieve()
                .body(${call.responseType}.class);
        return mapper.to${pascal}Result(response);`;
  } else {
    callBody = `        // TODO (agente): completar la llamada; el diseño no declara method/path ni el contract es parseable
        //   ${call.contract}
        throw new UnsupportedOperationException("TODO: ${call.name}");`;
  }

  const method = `${annotations.join('\n')}
    public ${call.resultType} ${call.name}(${params.join(', ')}) {
${callBody}
    }`;

  if (!hasFallback) return method;

  const fallbackParams = [...params, 'Throwable throwable'];
  const fallbackDoc = call.fallback
    ? `        // TODO (agente): ${call.fallback}`
    : '        // TODO (agente): política de fallback del circuito abierto.';
  const fallback = `    private ${call.resultType} ${call.fallbackMethod}(${fallbackParams.join(', ')}) {
${fallbackDoc}
        throw new UnsupportedOperationException("TODO: fallback ${call.name}");
    }`;

  return `${method}\n\n${fallback}`;
}

// ─── DTOs wire (contrato del sistema externo, solo infrastructure/http) ──────

function renderResponse(model, client, call) {
  const imports = new Set();
  addFieldImports(model, imports, call.responseFields);
  const components = call.responseFields.map((f) => `${f.javaType} ${f.name}`).join(', ');
  const todo = call.responseFields.length === 0
    ? `\n * TODO (agente): declara los campos según el contract "${call.contract}".`
    : '';

  const body = `/**
 * Respuesta wire de ${client.id}.${call.name} (contrato del sistema externo).${todo}
 */
public record ${call.responseType}(${components}) {
}`;
  return {
    path: javaPath(model, HTTP_PKG, call.responseType),
    content: javaFile(subPackage(model, HTTP_PKG), [...imports], body)
  };
}

function renderRequest(model, client, call) {
  const imports = new Set();
  addFieldImports(model, imports, call.bodyFields);
  const components = call.bodyFields.map((f) => `${f.javaType} ${f.name}`).join(', ');

  const body = `/**
 * Body wire de ${client.id}.${call.name} (contrato del sistema externo).
 */
public record ${call.requestType}(${components}) {
}`;
  return {
    path: javaPath(model, HTTP_PKG, call.requestType),
    content: javaFile(subPackage(model, HTTP_PKG), [...imports], body)
  };
}
