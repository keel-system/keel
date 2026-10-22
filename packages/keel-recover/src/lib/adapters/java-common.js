// Lo que comparten Maven y Gradle: el framework, el servidor de aplicaciones y los riesgos
// conocidos de un repositorio de artefactos. Los riesgos son del ENTORNO (qué repositorio se cerró
// o exige credenciales), no del legacy: el paso 0d los necesita para preparar el mirror antes del
// primer build, en vez de descubrirlos fallando.

const REPOSITORY_RISKS = [
  [/^http:\/\//i, 'insecure-http'], // Maven >= 3.8.1 bloquea los repositorios http
  [/jcenter\.bintray\.com|\bjcenter\(\)|dl\.bintray\.com/i, 'sunset'], // Bintray y JCenter cerraron en 2021-2022
  [/repo\.spring\.io\/(libs-|plugins-)(release|milestone|snapshot)/i, 'requires-auth'], // cerrados al anónimo desde 2022
];

export function repositoryRisks(url) {
  return REPOSITORY_RISKS.filter(([re]) => re.test(url)).map(([, risk]) => risk);
}

export function springBoot(boot) {
  return boot ? { name: 'spring-boot', version: boot.version, evidence: boot.evidence } : null;
}

// Starters que traen un servidor embebido, y cuál.
const SERVER_STARTERS = [
  ['org.springframework.boot:spring-boot-starter-jetty', 'jetty'],
  ['org.springframework.boot:spring-boot-starter-undertow', 'undertow'],
  ['org.springframework.boot:spring-boot-starter-reactor-netty', 'netty'],
];
const WEB_STARTERS = new Set([
  'org.springframework.boot:spring-boot-starter-web',
  'org.springframework.boot:spring-boot-starter-data-rest',
  'org.springframework.boot:spring-boot-starter-jersey',
  'org.springframework.boot:spring-boot-starter-websocket',
  'org.springframework.boot:spring-boot-starter-web-services',
]);

/**
 * Servidor que ejecuta la app. Con Spring Boot va embebido (Tomcat salvo que un starter diga
 * otro); sin Spring Boot y empaquetado como war, lo pone un servidor de aplicaciones que el repo
 * no nombra, y eso es una pregunta, no un default.
 */
export function serverOf(libraries, boot, packagingKind) {
  const main = libraries.filter((l) => l.scope === 'main');
  if (boot) {
    for (const [id, name] of SERVER_STARTERS) {
      const lib = main.find((l) => l.id === id);
      if (lib) return { name, embedded: true, evidence: lib.evidence };
    }
    const webflux = main.find((l) => l.id === 'org.springframework.boot:spring-boot-starter-webflux');
    if (webflux) return { name: 'netty', embedded: true, evidence: webflux.evidence };
    const web = main.find((l) => WEB_STARTERS.has(l.id));
    if (web) return { name: 'tomcat', embedded: true, evidence: web.evidence };
    return null;
  }
  if (packagingKind === 'war') return { name: null, embedded: false, evidence: null };
  return null;
}
