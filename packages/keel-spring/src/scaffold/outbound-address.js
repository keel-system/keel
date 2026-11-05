// Filtro de direcciones de las llamadas salientes (anti-SSRF, defensa en profundidad). Una sola
// pieza, `OutboundAddressPolicy`, que construye el HttpClient del JDK de TODO cliente saliente que
// emite build: los de la capa http-clients (http-clients.js) y el de la pasarela de pago
// (payments.js). Dos copias de la política serían dos políticas en cuanto cambie una.
//
// Ninguna base-url sale de la entrada del llamante: todas son configuración. Lo que cierra el filtro
// es la salida al endpoint de metadatos de la nube (169.254.169.254, fd00:ec2::254) si una variable
// de entorno se manipula o una redirección del proveedor se sigue. Es defensa en profundidad y nada
// más: el selector de Boot resuelve el host y mira la PRIMERA dirección, y el HttpClient vuelve a
// resolver al conectar, así que no protege de un DNS rebinding (medido en el inc. 0 de
// PLAN-KEEL-SPRING-BOOT41.md).
//
// El rechazo es `FilteredHostException`, una RuntimeException que llega CRUDA al llamante del
// RestClient —medido: no la envuelve en ResourceAccessException—, así que no es un fallo del
// proveedor: el fallback estrecho (outbound-failures.js) no la atiende, el circuito no la cuenta, el
// retry no la repite y la pasarela no deja la acción en duda (no salió nada). Se propaga como un
// error de configuración, con su traza, hasta el 500. Lo mide payment-check (`filteredHost`).

import { javaFile, javaPath, subPackage } from './render.js';

export const OUTBOUND_PKG = 'infrastructure.http';
export const OUTBOUND_POLICY_CLASS = 'OutboundAddressPolicy';

/** La clave de configuración de la lista de denegación extra y su variable de entorno. */
export const DENIED_ADDRESSES_PROPERTY = 'outbound.denied-addresses';
export const DENIED_ADDRESSES_ENV = 'OUTBOUND_DENIED_ADDRESSES';

/**
 * Lo que se deniega SIEMPRE, en CIDR. El filtro de Boot es de PERMITIDAS, así que la política se
 * escribe como `not(...)` de esto. Loopback y las redes privadas quedan permitidas: en local y test
 * el proveedor es el WireMock de localhost, y en producción los servicios internos viven en IP
 * privadas. `fd00:ec2::254` va explícito porque cae dentro de `fc00::/7`, que es red privada.
 */
export const ALWAYS_DENIED = [
  { cidr: '169.254.0.0/16', why: 'link-local IPv4: el endpoint de metadatos de la nube' },
  { cidr: 'fe80::/10', why: 'link-local IPv6' },
  { cidr: '0.0.0.0/8', why: 'any-local IPv4: en Linux 0.0.0.0 conecta con el propio host' },
  { cidr: '::/128', why: 'any-local IPv6' },
  { cidr: 'fd00:ec2::254/128', why: 'metadatos de AWS por IPv6, dentro de la red privada fc00::/7' }
];

/** ¿Hay algún cliente saliente que construir? */
export function usesOutboundPolicy(model) {
  return Boolean((model.layersPresent.httpClients && (model.httpClients ?? []).length > 0) || model.payments);
}

/** El FQN de la política, para los imports de quien la inyecta. */
export function outboundPolicyImport(model) {
  return `${model.service.basePackage}.${OUTBOUND_PKG}.${OUTBOUND_POLICY_CLASS}`;
}

export function generate(model) {
  if (!usesOutboundPolicy(model)) return [];
  // Sin coma tras el último: Java no admite una coma final en los argumentos.
  const denied = ALWAYS_DENIED.map(({ cidr, why }, i) => `            "${cidr}"${i < ALWAYS_DENIED.length - 1 ? ',' : ''} // ${why}`).join('\n');
  const body = `/**
 * A dónde puede salir una llamada saliente, y el HttpClient del JDK que lo hace cumplir. Lo usan
 * todos los clientes que construye build (http-clients y pasarela de pago).
 *
 * <p>Se deniega siempre link-local, any-local, multicast y el endpoint de metadatos de la nube, más lo
 * que añada {@code ${DENIED_ADDRESSES_PROPERTY}} (CIDR separados por comas). Loopback y las redes
 * privadas se permiten: los proveedores internos viven ahí. Un CIDR mal escrito impide arrancar.
 *
 * <p>Es defensa en profundidad: el filtro mira la primera dirección que resuelve el host, y el cliente
 * vuelve a resolver al conectar, así que no protege de un DNS rebinding.
 *
 * <p>El rechazo es {@link org.springframework.boot.http.client.FilteredHostException}, que llega
 * cruda al llamante del RestClient: NO es un fallo del proveedor (no salió nada), así que ni el
 * fallback ni el circuito ni el retry la atienden. Es un error de configuración y se propaga.
 */
@Component
public class ${OUTBOUND_POLICY_CLASS} {

    private static final InetAddressFilter ALWAYS_DENIED = InetAddressFilter.of(
${denied}
            ).or(InetAddressFilter.multicast());

    private final InetAddressFilter allowed;

    public ${OUTBOUND_POLICY_CLASS}(@Value("\${${DENIED_ADDRESSES_PROPERTY}:}") List<String> extraDenied) {
        InetAddressFilter denied = ALWAYS_DENIED;
        List<String> extra = extraDenied.stream().map(String::trim).filter(cidr -> !cidr.isEmpty()).toList();
        if (!extra.isEmpty()) {
            denied = denied.or(InetAddressFilter.of(extra.toArray(String[]::new)));
        }
        this.allowed = InetAddressFilter.not(denied);
    }

    /**
     * El HttpClient del JDK con el filtro puesto.
     *
     * <p>HTTP/1.1 explícito, y no lo que negocie el cliente. El del JDK negocia HTTP/2 y contra un
     * servidor en claro lo intenta con {@code Upgrade: h2c}: si el otro extremo no completa el
     * upgrade, el CUERPO SE PIERDE y la llamada muere con {@code Received RST_STREAM: Stream
     * cancelled}, que el fallback traduce a "el proveedor no está disponible". El síntoma acusa al
     * proveedor y la causa está aquí — le pasa al WireMock que levanta el propio generador.
     *
     * <p>Sin seguir redirecciones, como el HttpClient del JDK a secas: los defaults de Boot las
     * siguen, y una respuesta del proveedor no decide a dónde sale la siguiente petición.
     *
     * <p>El selector que filtra es package-private en Boot: solo lo instala {@link JdkHttpClientBuilder}.
     */
    public HttpClient httpClient(Duration connectTimeout) {
        return new JdkHttpClientBuilder()
                .withCustomizer(builder -> builder.version(HttpClient.Version.HTTP_1_1))
                .build(HttpClientSettings.defaults()
                        .withRedirects(HttpRedirects.DONT_FOLLOW)
                        .withConnectTimeout(connectTimeout)
                        .withInetAddressFilter(allowed));
    }
}`;
  return [
    {
      path: javaPath(model, OUTBOUND_PKG, OUTBOUND_POLICY_CLASS),
      content: javaFile(
        subPackage(model, OUTBOUND_PKG),
        [
          'java.net.http.HttpClient',
          'java.time.Duration',
          'java.util.List',
          'org.springframework.beans.factory.annotation.Value',
          'org.springframework.boot.http.client.HttpClientSettings',
          'org.springframework.boot.http.client.HttpRedirects',
          'org.springframework.boot.http.client.InetAddressFilter',
          'org.springframework.boot.http.client.JdkHttpClientBuilder',
          'org.springframework.stereotype.Component'
        ],
        body
      )
    }
  ];
}
