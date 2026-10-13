// El GRADIENTE de externalización por perfil: cómo se escribe, en la configuración de cada perfil
// (`local`, `develop`, `production`, `test`), un valor que en un despliegue sale de una variable de
// entorno. Es contrato observable del servidor —qué variable lee, si tiene default y en qué perfil—, así
// que lo comparten todos los generadores: el `${VAR:default}` es la sintaxis de placeholder que los dos
// proyectos generados resuelven igual (keel-spring con su Environment, keel-nest con su cargador).
//
// Vive aquí desde el incremento 1 de PLAN-KEEL-DOTNET.md. Hasta entonces keel-spring lo tenía una vez y
// keel-nest lo había copiado en doce emisores, con dos semánticas distintas para el perfil `test` que nadie
// había decidido.

/**
 * Literal en local y en test, variable con default en develop y variable OBLIGATORIA (sin default) en
 * production. `test` es literal como local: es un perfil cerrado (sin infra externa) que debe arrancar
 * sin que nadie exporte nada.
 */
export function envValue(profile, varName, localValue) {
  if (profile === 'local' || profile === 'test') return String(localValue);
  if (profile === 'develop') return `\${${varName}:${localValue}}`;
  return `\${${varName}}`;
}

/**
 * Para valores operativos que no son secretos ni endpoints (niveles de log, group-id): parametrizados
 * en todos los ambientes salvo local, pero siempre con default, porque su ausencia no debe impedir el
 * arranque.
 */
export function envWithDefault(profile, varName, localValue) {
  if (profile === 'local') return String(localValue);
  return `\${${varName}:${localValue}}`;
}

/**
 * Para expresiones cron. No basta con `envWithDefault`: la expresión hay que entrecomillarla en YAML
 * (empieza por dígito y lleva '*'), y si las comillas van DENTRO del default del placeholder pasan a
 * formar parte del valor —`${VAR:"0 0 4 * * *"}` resuelve a `"0 0 4 * * *"` con las comillas incluidas y
 * el planificador la rechaza al arrancar—. Así que se entrecomilla el escalar entero y el default va
 * desnudo.
 */
export function cronWithDefault(profile, varName, cron) {
  return profile === 'local' ? `"${cron}"` : `"\${${varName}:${cron}}"`;
}

/**
 * Para valores que NO tienen un default razonable fuera de local (el diseño no los declara): literal en
 * local y en test, y variable obligatoria en el resto, para fallar al arrancar en vez de apuntar en
 * silencio a un destino erróneo. `test` es literal por la misma razón que en `envValue`: un perfil
 * cerrado que arranca sin que nadie exporte nada. En keel-spring ningún fragmento con un valor
 * obligatorio llega al perfil test; en keel-nest sí (la seguridad configura ahí la clave de prueba), y una
 * variable sin default lo dejaría sin arrancar.
 */
export function envRequired(profile, varName, localValue) {
  if (profile === 'local' || profile === 'test') return String(localValue);
  return `\${${varName}}`;
}
