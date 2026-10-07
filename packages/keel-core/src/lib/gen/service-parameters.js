// Los parámetros de DESPLIEGUE del servicio (`service.keel.yaml § parameters`, DSL 2.15): su valor en
// cada perfil, como decisión neutral.
//
// Los dos servidores del mismo diseño leen el parámetro de la misma clave (`<artifactId>.<key>`) y con
// la misma variable de entorno, y tienen que escribir el MISMO gradiente: literal en los perfiles de
// prueba, variable con default en develop, y en producción la variable PELADA si el parámetro es
// obligatorio y no tiene default —un default silencioso ahí es un valor que nadie eligió, y el servicio
// tiene que negarse a arrancar—.

/** El valor del parámetro en el perfil, ya como texto de configuración (con su placeholder). */
export function parameterProfileValue(parameter, profile) {
  const literal = parameter.testValue ?? parameter.default;
  if (profile === 'local' || profile === 'test') return String(literal ?? `\${${parameter.envVar}}`);
  if (profile === 'production' && parameter.requiredInProduction && parameter.default === null) return `\${${parameter.envVar}}`;
  return `\${${parameter.envVar}:${literal ?? ''}}`;
}

/** La clave de configuración del parámetro: `<artifactId>.<key>`. */
export function parameterProperty(model, parameter) {
  return `${model.service.artifactId}.${parameter.key}`;
}
