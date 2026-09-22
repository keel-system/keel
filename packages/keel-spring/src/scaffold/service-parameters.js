// Parámetros de DESPLIEGUE del servicio (`service.keel.yaml § parameters`).
//
// Qué problema resuelve. Un servicio suele tener uno o dos valores que no son dato de negocio
// ni entrada de ninguna operación y de los que sí depende su comportamiento: la moneda en la
// que opera el catálogo, la zona horaria con la que se corta un día. El diseño los decidía en
// PROSA —una `rule` del dominio— y el DSL no tenía dónde escribirlos, así que en la corrida
// `catalog` el agente se inventó el fragmento de configuración, la clave, la variable de
// entorno y su presencia en los cuatro perfiles, y el contrato operativo («esto hay que dárselo
// al arrancar o el servicio no arranca») no quedó escrito en ninguna parte. Aguas arriba lo
// avisa `CHK-SERVICE-PARAM-UNBACKED`; aquí se traduce.
//
// Dos artefactos y no uno, por la frontera hexagonal que ya está escrita: la capa APPLICATION
// no puede leer `@Value` (constitution.md), así que el valor viaja en un record de DOMINIO que
// valida sus cotas al construirse —un parámetro mal puesto tiene que morir en el ARRANQUE y no
// en la primera petición que lo use— y quien lo puebla desde la configuración es un
// `@Configuration` de infraestructura. Es el mismo reparto que `BucketPolicy`/`StorageProperties`.

import { javaFile, javaPath, subPackage } from './render.js';
import { escapeJava } from '../lib/type-mapper.js';

const DOMAIN_PKG = 'domain.parameters';
const INFRA_PKG = 'infrastructure.configurations';

export function generate(model) {
  const parameters = model.service.parameters ?? [];
  if (parameters.length === 0) return [];
  return [renderRecord(model, parameters), renderConfig(model, parameters)];
}

function recordClass(model) {
  return `${model.service.className}Parameters`;
}

function renderRecord(model, parameters) {
  const imports = new Set();
  const components = parameters.map((parameter) => {
    if (parameter.javaType === 'BigDecimal') imports.add('java.math.BigDecimal');
    return `${parameter.javaType} ${parameter.name}`;
  });
  const params = parameters.map((parameter) => ` * @param ${parameter.name} ${parameter.description}`).join('\n');
  const guards = parameters.flatMap((parameter) => guardsFor(parameter)).join('\n');

  const body = `/**
 * Parámetros de despliegue de ${model.service.name}, ya validados.
 *
 * <p>Value object de dominio: llega por constructor a quien lo necesite, nunca por
 * {@code @Value} desde la capa de aplicación. Lo puebla {@link ${recordClass(model)}Config}
 * desde {@code ${model.service.artifactId}.*} de la configuración por perfil.
 *
 * <p>Las cotas se comprueban AQUÍ, al construirlo, y por eso un valor mal puesto tumba el
 * arranque en vez de aparecer en la primera petición que lo use.
 *
${params}
 */
public record ${recordClass(model)}(${components.join(', ')}) {

    public ${recordClass(model)} {
${guards}
    }
}`;
  return {
    path: javaPath(model, DOMAIN_PKG, recordClass(model)),
    content: javaFile(subPackage(model, DOMAIN_PKG), [...imports], body)
  };
}

// Las cotas que el diseño declara, traducidas a guardas de constructor. Lo que no se pueda
// comprobar aquí no se finge: el record solo promete lo que el diseño escribió.
function guardsFor(parameter) {
  const lines = [];
  const name = parameter.name;
  lines.push(`        if (${name} == null) {`);
  lines.push(
    `            throw new IllegalStateException("Falta el parámetro de despliegue '${parameter.key}' ` +
      `(variable ${parameter.envVar}).");`
  );
  lines.push('        }');
  const { pattern, minLength, maxLength, min, max } = parameter.constraints ?? {};
  if (pattern) {
    lines.push(`        if (!${name}.matches("${escapeJava(String(pattern))}")) {`);
    lines.push(
      `            throw new IllegalStateException("El parámetro '${parameter.key}' no respeta su formato declarado.");`
    );
    lines.push('        }');
  }
  if (minLength != null || maxLength != null) {
    const cond = [
      minLength != null ? `${name}.length() < ${minLength}` : null,
      maxLength != null ? `${name}.length() > ${maxLength}` : null
    ]
      .filter(Boolean)
      .join(' || ');
    lines.push(`        if (${cond}) {`);
    lines.push(
      `            throw new IllegalStateException("El parámetro '${parameter.key}' no respeta su longitud declarada.");`
    );
    lines.push('        }');
  }
  if (min != null || max != null) {
    const compare = parameter.javaType === 'BigDecimal' ? 'compareTo' : null;
    const cond = [
      min != null ? (compare ? `${name}.${compare}(new BigDecimal("${min}")) < 0` : `${name} < ${min}`) : null,
      max != null ? (compare ? `${name}.${compare}(new BigDecimal("${max}")) > 0` : `${name} > ${max}`) : null
    ]
      .filter(Boolean)
      .join(' || ');
    lines.push(`        if (${cond}) {`);
    lines.push(
      `            throw new IllegalStateException("El parámetro '${parameter.key}' está fuera del rango declarado.");`
    );
    lines.push('        }');
  }
  return lines;
}

function renderConfig(model, parameters) {
  const imports = new Set([
    'org.springframework.beans.factory.annotation.Value',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    `${subPackage(model, DOMAIN_PKG)}.${recordClass(model)}`
  ]);
  const args = parameters
    .map((parameter) => {
      if (parameter.javaType === 'BigDecimal') imports.add('java.math.BigDecimal');
      return `            @Value("\${${model.service.artifactId}.${parameter.key}}") ${parameter.javaType} ${parameter.name}`;
    })
    .join(',\n');
  const names = parameters.map((parameter) => parameter.name).join(', ');

  const body = `/**
 * Puebla {@link ${recordClass(model)}} desde la configuración por perfil.
 *
 * <p>Los placeholders van SIN default a propósito: el gradiente por perfil ya está en
 * {@code parameters/<perfil>/${model.service.artifactId}.yaml}, y un default aquí lo
 * silenciaría justo donde importa —un despliegue de producción al que le falta la variable
 * arrancaría con un valor que nadie eligió en vez de no arrancar.
 */
@Configuration
public class ${recordClass(model)}Config {

    @Bean
    public ${recordClass(model)} ${lowerFirst(recordClass(model))}(
${args}) {
        return new ${recordClass(model)}(${names});
    }
}`;
  return {
    path: javaPath(model, INFRA_PKG, `${recordClass(model)}Config`),
    content: javaFile(subPackage(model, INFRA_PKG), [...imports], body)
  };
}

function lowerFirst(value) {
  return `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}
