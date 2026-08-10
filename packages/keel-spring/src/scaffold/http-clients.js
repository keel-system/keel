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
import { outboundIdempotentCalls } from './http-idempotency.js';
import { providerFailures } from '../lib/outbound-failures.js';

const PORT_PKG = 'domain.clients';
const HTTP_PKG = 'infrastructure.http';
const SUPPORT_PKG = 'application.support';

export function generate(model) {
  if (!model.layersPresent.httpClients || !model.httpClients) return [];
  const files = [];
  if (model.httpClients.some((client) => client.auth?.type === 'oauth2-client-credentials')) {
    files.push(renderOAuth2Config(model));
  }
  if (outboundIdempotentCalls(model).length > 0) files.push(renderOutboundIdempotency(model));
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
    'java.net.http.HttpClient',
    'java.time.Duration',
    'org.springframework.beans.factory.annotation.Value',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.http.client.JdkClientHttpRequestFactory',
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
        // HTTP/1.1 explícito, y no el request factory que \`detect()\` elija. Sin más
        // clientes en el classpath, detect() cae en el del JDK, que negocia HTTP/2 y
        // contra un servidor en claro lo intenta con \`Upgrade: h2c\`: si el otro
        // extremo no completa el upgrade, el CUERPO SE PIERDE y la llamada muere con
        // \`Received RST_STREAM: Stream cancelled\`, que el fallback traduce a "el
        // proveedor no está disponible". El síntoma acusa al proveedor y la causa
        // está aquí — le pasa al WireMock que levanta el propio generador, así que
        // sin esto ninguna activación con cuerpo es ejercitable.
        HttpClient httpClient = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(5))
                .build();
        JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(httpClient);
        requestFactory.setReadTimeout(Duration.ofMillis(${client.readTimeoutMs}));
${preamble.length > 0 ? preamble.join('\n') + '\n' : ''}        return RestClient.builder()
                .baseUrl(baseUrl)
${builderSteps.map((s) => `                ${s}`).join('\n')}${builderSteps.length > 0 ? '\n' : ''}                .requestFactory(requestFactory)
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

  // Solo lo declara si algo del adaptador registra: un fallback `ignore` o la guarda
  // del cuerpo ausente. Un logger sin uso es ruido que además dispara avisos de
  // análisis estático. Va DESPUÉS de renderizar los métodos a propósito — son ellos
  // los que añaden el import, y calcularlo antes dejaría el campo sin declarar y el
  // adaptador sin compilar.
  const logger = imports.has('org.slf4j.Logger')
    ? `    private static final Logger log = LoggerFactory.getLogger(${client.adapterClass}.class);\n\n`
    : '';

  const body = `@Component
public class ${client.adapterClass} implements ${client.clientClass} {

${logger}    private final RestClient restClient;
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

// La clave que ESTE servicio le manda al proveedor. Es la cara simétrica de la
// idempotencia de entrada: allí evitamos que un cliente nos ejecute dos veces;
// aquí, que nuestro propio @Retry ejecute dos veces su trabajo. Un timeout no
// distingue "no llegó" de "llegó y se hizo", así que sin clave el reintento de un
// POST es una segunda ejecución — y eso es justo la deuda que luego intentan
// arreglar las compensaciones.
function renderOutboundIdempotency(model) {
  const body = `/**
 * Clave de idempotencia saliente, por llamada.
 *
 * <p>Lo que la hace útil es que el reintento produzca la MISMA clave: resilience4j
 * vuelve a invocar el método entero, así que cualquier cosa aleatoria o dependiente
 * del instante pediría una ejecución nueva al proveedor en cada intento, que es
 * exactamente lo que se quiere evitar.
 */
public final class OutboundIdempotency {

    private OutboundIdempotency() {
        // Clase de utilidad.
    }

    /** Clave por CONTENIDO: dos peticiones idénticas son la misma intención. */
    public static String fromPayload(String call, Object payload) {
        return CommandSignature.of(Arrays.asList(call, payload));
    }

    /**
     * Clave por CORRELACIÓN: el proveedor deduplica por intención de negocio, no por
     * contenido — dos peticiones idénticas de dos ejecuciones distintas sí deben
     * ejecutarse las dos.
     *
     * <p>Sin correlación abierta (un hilo de fondo, un arranque) se cae a la firma del
     * contenido: es lo único estable que queda, y una clave aleatoria sería peor que
     * no mandar ninguna.
     */
    public static String correlated(String call, Object payload) {
        String correlationId = CorrelationContext.get();
        return correlationId == null
                ? fromPayload(call, payload)
                : CommandSignature.of(Arrays.asList(call, correlationId));
    }
}`;

  return {
    path: javaPath(model, HTTP_PKG, 'OutboundIdempotency'),
    content: javaFile(
      subPackage(model, HTTP_PKG),
      [
        `${subPackage(model, SUPPORT_PKG)}.CommandSignature`,
        `${subPackage(model, 'infrastructure.correlation')}.CorrelationContext`,
        'java.util.Arrays'
      ],
      body
    )
  };
}

/**
 * Argumentos de un resultado SIN datos del proveedor: `List.of()` para las listas y
 * `null` para el resto.
 *
 * Lo usan los dos caminos que llegan a esa situación —el fallback `ignore` y la
 * respuesta sin cuerpo—, y por eso vive aquí en vez de duplicado: son la misma noción
 * («no hay nada que el proveedor haya dicho») y si divergieran, dos caminos que el
 * llamante no distingue devolverían formas distintas del mismo vacío.
 *
 * Las listas van vacías y no a `null` a propósito: quien recibe una colección la
 * recorre, y un `null` ahí convierte una degradación prevista en un NPE.
 */
function neutralResultArgs(call, imports) {
  if (call.responseFields.some((field) => field.javaType.startsWith('List<'))) imports.add('java.util.List');
  return call.responseFields
    .map((field) => (field.javaType.startsWith('List<') ? 'List.of()' : 'null'))
    .join(', ');
}

function renderCallMethod(model, client, call, imports) {
  addFieldImports(model, imports, callFields(call));
  const params = callParams(call).map((p) => p.decl);
  // Hace falta algo que lo dispare: el fallback lo invoca un aspecto, así que sin
  // retry ni circuito no hay quien lo llame y serían cinco métodos privados muertos.
  const hasFallback = Boolean((call.fallback || call.circuitBreaker) && (call.retry || call.circuitBreaker));
  const pascal = call.resultType.replace(/Result$/, '');

  // El fallbackMethod va en el aspecto MÁS EXTERNO, que es `@Retry`: el orden de
  // resilience4j es Retry(CircuitBreaker(llamada)). Ponerlo en el circuito teniendo
  // retry —como se hacía— dejaba el retry MUERTO: el aspecto del circuito atrapaba la
  // excepción, ejecutaba el fallback y le devolvía al de retry un valor normal, así
  // que veía éxito y no reintentaba nunca. Con el fallback fuera, el 5xx se reintenta
  // de verdad, el circuito registra cada intento, y solo al agotarlos entra el
  // fallback. `CallNotPermittedException` no está en `retry-exceptions`, así que
  // atraviesa el retry sin consumir intentos y llega a su sobrecarga.
  const annotations = ['    @Override'];
  if (call.retry) {
    imports.add('io.github.resilience4j.retry.annotation.Retry');
    const fb = hasFallback ? `, fallbackMethod = "${call.fallbackMethod}"` : '';
    annotations.push(`    @Retry(name = "${call.instanceName}"${fb})`);
  }
  if (call.circuitBreaker) {
    imports.add('io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker');
    const fb = hasFallback && !call.retry ? `, fallbackMethod = "${call.fallbackMethod}"` : '';
    annotations.push(`    @CircuitBreaker(name = "${call.instanceName}"${fb})`);
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
    // Con clave saliente el wire request se hoista a variable: la firma tiene que
    // ser la del MISMO objeto que se envía, y calcularla dos veces (una para el
    // body, otra para la cabecera) es la forma de que un día dejen de coincidir.
    let preamble = '';
    let bodyStep = '';
    let payloadExpr = null;
    if (call.requestType) {
      const args = call.bodyFields.map((f) => f.name).join(', ');
      if (call.idempotency) {
        preamble = `        ${call.requestType} request = mapper.to${pascal}Request(${args});\n`;
        bodyStep = '\n                .body(request)';
        payloadExpr = 'request';
      } else {
        bodyStep = `\n                .body(mapper.to${pascal}Request(${args}))`;
      }
    } else if (call.hasBody) {
      bodyStep = '\n                .body(body)';
      payloadExpr = 'body';
    }
    let idempotencyStep = '';
    if (call.idempotency) {
      imports.add(`${subPackage(model, HTTP_PKG)}.OutboundIdempotency`);
      if (!payloadExpr) {
        // Sin cuerpo, lo que identifica la petición son sus parámetros (el DELETE
        // de un recurso concreto). Arrays.asList y no List.of: un parámetro
        // opcional puede venir nulo y List.of lo rechazaría en tiempo de ejecución.
        const params = callParams(call).map((p) => p.field.name);
        imports.add('java.util.Arrays');
        payloadExpr = params.length > 0 ? `Arrays.asList(${params.join(', ')})` : 'null';
      }
      const factory = call.idempotency.keyFrom === 'correlation' ? 'correlated' : 'fromPayload';
      idempotencyStep = `\n                .header("${call.idempotency.header}", OutboundIdempotency.${factory}("${call.name}", ${payloadExpr}))`;
    }
    const todo = call.typed
      ? ''
      : `        // TODO (agente): ajusta ${call.responseType} y el request al contract\n        //   ${call.contract}\n`;
    // Cuerpo ausente. `body(...)` devuelve null cuando la respuesta no trae cuerpo —un
    // 204, que es la contestación más natural a un DELETE—, y el mapper desreferencia:
    // sin esta guarda sale un NPE que el fallback del circuit breaker se traga por el
    // camino escrito para «el proveedor no responde». O sea que una llamada que
    // FUNCIONÓ se registra como proveedor caído, y con onFailure: fail se convierte en
    // el error de indisponibilidad del diseño. El síntoma acusa al proveedor y la causa
    // está aquí.
    //
    // Se traduce como valores AUSENTES y no como fallo, porque el DSL ya puso esa
    // decisión en otro sitio: `awaits: outcome` dice que el desenlace lo condiciona lo
    // que devuelva el proveedor, así que quien decide qué hacer sin desenlace es el
    // handler. Devolver el resultado neutro se lo entrega; lanzar se lo robaría.
    //
    // Solo con campos declarados: sin ellos el mapper devuelve `new XxxResult()` sin
    // tocar la respuesta, así que no hay NPE posible y la guarda sería ruido.
    const emptyBodyGuard =
      call.responseFields.length > 0
        ? (imports.add('org.slf4j.Logger'),
          imports.add('org.slf4j.LoggerFactory'),
          `\n        if (response == null) {
            log.warn("${client.id}.${call.name} respondió sin cuerpo; el contrato declara ${call.responseFields.length} campo(s)");
            return new ${call.resultType}(${neutralResultArgs(call, imports)});
        }`)
        : '';
    callBody = `${todo}${preamble}        ${call.responseType} response = restClient.${verb}()
                ${uriStep}${headerSteps}${idempotencyStep}${bodyStep}
                .retrieve()
                .body(${call.responseType}.class);${emptyBodyGuard}
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

  // El fallback NO captura `Throwable`. Se emite una sobrecarga por excepción que de
  // verdad significa que el proveedor no está (`providerFailures`), y todas delegan en
  // un único método con la política. Lo que no tiene sobrecarga —un NPE, un cast, un
  // cuerpo que no deserializa, un 4xx— resilience4j lo relanza tal cual: un bug del
  // adaptador se ve con su traza en vez de registrarse como caída ajena, que es lo que
  // mantuvo un defecto de código meses sin diagnosticar.
  //
  // Son siempre DOS o más a propósito: con un solo método de fallback resilience4j no
  // comprueba el tipo del último parámetro y lo invoca con cualquier excepción, así que
  // una sola sobrecarga «estrecha» no estrecharía nada.
  // `field` es null en la rama de cuerpo sin tipar (`Object body`), que es justo la
  // que aparece cuando el contract es solo prosa: leerlo a secas reventaría ahí.
  const args = [...callParams(call).map((p) => p.field?.name ?? 'body'), 'throwable'].join(', ');
  const overloads = providerFailures({ circuitBreaker: Boolean(call.circuitBreaker) }).map((failure) => {
    imports.add(failure.fqn);
    // El rechazo se registra aparte antes de delegar: llamarlo «no disponible» a
    // secas repetiría, en pequeño, el error de diagnóstico que este fallback corrige.
    const rejection = failure.rejection
      ? `        // Si el rechazo tiene significado de negocio —un 404 es "no existe", un 409 un
        // conflicto suyo—, la traducción va con .onStatus(...) en la llamada, no aquí.
        log.warn("${client.id}.${call.name} rechazada por el proveedor ({})", throwable.getStatusCode());\n`
      : '';
    return `    /** ${failure.reason} */
    private ${call.resultType} ${call.fallbackMethod}(${[...params, `${failure.simple} throwable`].join(', ')}) {
${rejection}        return ${call.unavailableMethod}(${args});
    }`;
  });

  const unavailable = `    /**
     * Política del diseño para cuando ${client.id}.${call.name} no sale.
     *
     * Solo llega aquí lo que ha hecho el PROVEEDOR: no responder, responder mal o
     * rechazarnos. Un error de programación de este adaptador —un NPE, un cast, un
     * cuerpo que no deserializa— no tiene sobrecarga que lo enrute y se propaga con
     * su traza. No lo ensanches a \`Exception\` ni a \`Throwable\` para "que no se
     * escape nada": lo que se escapa es el bug, y taparlo aquí es lo que mantuvo uno
     * meses disfrazado de caída ajena.
     */
    private ${call.resultType} ${call.unavailableMethod}(${[...params, 'Throwable throwable'].join(', ')}) {
${fallbackBody(model, client, call, imports)}
    }`;

  return [method, ...overloads, unavailable].join('\n\n');
}

// Cuerpo del fallback. Si el diseño ya declaró la política —una activación de la
// capa `dependencies` que sale por esta llamada trae su `onFailure`— se genera,
// en vez de dejar un TODO que obliga al agente a reinventar una decisión que ya
// está tomada. Con varias activaciones por la misma llamada no se elige por él:
// políticas distintas sobre un único método es un conflicto del diseño.
function fallbackBody(model, client, call, imports) {
  const activations = call.activations ?? [];
  // La causa se registra SIEMPRE, gane la política que gane. El fallback recibe el
  // throwable y lo natural es tirarlo: entonces un fallo de integración —una
  // negociación HTTP rota, un cuerpo que no deserializa— queda indistinguible de
  // "el proveedor está caído", que es lo que dice el error que se lanza después.
  // Diagnosticar eso sin el log cuesta instrumentar el adaptador a mano.
  imports.add('org.slf4j.Logger');
  imports.add('org.slf4j.LoggerFactory');
  // Por el campo estático, no por un logger creado aquí: el import de arriba garantiza
  // que `log` está declarado en el adaptador, así que el inline solo añadía una segunda
  // instancia y una SEGUNDA línea de log del mismo evento. Los pases de calidad de
  // cuatro corridas seguidas lo consolidaron a mano en el proyecto generado, que es la
  // señal de que el arreglo va aquí y no allí.
  const trace = `        log.warn("Fallback de ${client.id}.${call.name}", throwable);\n`;

  if (activations.length !== 1) {
    // Sin política declarada, la prosa del diseño ES la instrucción al agente.
    const doc = call.fallback
      ? `        // TODO (agente): ${call.fallback}`
      : '        // TODO (agente): política de fallback del circuito abierto.';
    const listed =
      activations.length > 1
        ? `\n        // Varias activaciones salen por esta llamada y el diseño no puede darles políticas\n        // distintas sobre un único método: ${activations
            .map(({ dependency, activation }) => `${dependency}.${activation.name} (onFailure: ${activation.onFailure?.action ?? 'sin declarar'})`)
            .join('; ')}`
        : '';
    return `${trace}${doc}${listed}
        throw new UnsupportedOperationException("TODO: fallback ${call.name}");`;
  }

  const prose = call.fallback ? `        // Fallback declarado en el diseño: ${call.fallback}\n` : '';

  const { dependency, activation } = activations[0];
  const { onFailure } = activation;
  const origin = `        // Política declarada por la activación ${dependency}.${activation.name} (onFailure: ${onFailure?.action ?? 'sin declarar'}).\n`;

  if (onFailure?.action === 'ignore') {
    imports.add('org.slf4j.Logger');
    imports.add('org.slf4j.LoggerFactory');
    // Resultado neutro: el diseño dice que el fallo no interrumpe al llamante,
    // así que no puede propagar la excepción ni inventarse datos del proveedor.
    const empty = neutralResultArgs(call, imports);
    // Una sola línea, no el trace genérico MÁS esta: son el mismo evento, y el mensaje
    // de aquí dice más (que el llamante sigue adelante). El throwable va como argumento
    // —no `toString()`— para conservar la traza: sin ella, diagnosticar un fallo de
    // integración disfrazado de proveedor caído obliga a instrumentar a mano.
    return `${prose}${origin}        // El llamante sigue adelante: no propagues la excepción ni inventes datos del proveedor.
        log.warn("${client.id}.${call.name} no disponible; se continúa sin él", throwable);
        return new ${call.resultType}(${empty});`;
  }

  if (onFailure?.action === 'fail') {
    const message = `"${dependency} no está disponible para ${activation.name}"`;
    if (onFailure.exceptionClass) {
      imports.add(`${subPackage(model, 'domain.errors')}.${onFailure.exceptionClass}`);
      const args = onFailure.dynamicStatus ? `${message}, ${onFailure.httpStatus}` : message;
      return `${trace}${prose}${origin}        throw new ${onFailure.exceptionClass}(${args});`;
    }
    return `${trace}${prose}${origin}        // TODO (agente): el diseño declara onFailure.error = ${onFailure.error}, pero ninguna
        // operación de use-cases lo declara todavía, así que su clase no existe.
        throw new UnsupportedOperationException("TODO: fallback ${call.name}");`;
  }

  if (onFailure?.action === 'degrade') {
    return `${trace}${prose}${origin}        // TODO (agente): el resultado degradado es lógica de negocio y debe ser distinguible
        // por el cliente de una respuesta normal — un dato plausible pero falso es peor que fallar:
        //   ${onFailure.degradedTo}
        throw new UnsupportedOperationException("TODO: fallback ${call.name}");`;
  }

  return `${trace}${prose}${origin}        // TODO (agente): la activación no declara onFailure.
        throw new UnsupportedOperationException("TODO: fallback ${call.name}");`;
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
