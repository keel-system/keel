// Parámetros de DESPLIEGUE del servicio (`service.keel.yaml § parameters`, DSL 2.15): un valor único
// para todo el servicio que no es dato de negocio ni entrada de ninguna operación —la moneda del
// catálogo, el plazo tras el que un trabajo se da por abandonado—.
//
// El mismo reparto que en keel-spring, porque la frontera hexagonal es la misma: la capa application no
// lee configuración, así que el valor viaja en una clase de DOMINIO que valida sus cotas al construirse
// —un parámetro mal puesto tiene que tumbar el ARRANQUE, no la primera petición que lo use— y quien la
// puebla desde la configuración es un módulo de infraestructura. Misma clave (`<artifactId>.<key>`),
// misma variable de entorno y mismo gradiente por perfil (keel-core/gen/service-parameters.js).

import { parameterProfileValue, parameterProperty } from 'keel-core/gen/service-parameters';
import { classPath, tsModule, tsString } from './render.js';
import { DECIMAL_TS } from './wire.js';

const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
export const SERVICE_PARAMETERS_MODULE_TS = 'src/infrastructure/config/service-parameters-module.ts';
const PROFILES = ['local', 'develop', 'production', 'test'];

export const parametersClass = (model) => `${model.service.className}Parameters`;
export const parametersPath = (model) => classPath('domain/parameters', parametersClass(model));

export function usesServiceParameters(model) {
  return (model.service.parameters ?? []).length > 0;
}

export function generate(model) {
  if (!usesServiceParameters(model)) return [];
  return [
    { path: parametersPath(model), content: domainFile(model) },
    { path: SERVICE_PARAMETERS_MODULE_TS, content: moduleFile(model) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/${model.service.artifactId}.yaml`, content: yaml(model, profile) }))
  ];
}

function yaml(model, profile) {
  const lines = [`${model.service.artifactId}:`];
  for (const parameter of model.service.parameters) {
    lines.push(`  # ${parameter.description}`, `  ${parameter.key}: ${parameterProfileValue(parameter, profile)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Las cotas que el diseño declara, como guardas de constructor (los mensajes de keel-spring). */
function guardsFor(parameter) {
  const { name, key } = parameter;
  const lines = [
    `    if (${name} == null) {`,
    `      throw new Error(${tsString(`Falta el parámetro de despliegue '${key}' (variable ${parameter.envVar}).`)});`,
    '    }'
  ];
  const { pattern, minLength, maxLength, min, max } = parameter.constraints ?? {};
  const fail = (what) => [`      throw new Error(${tsString(`El parámetro '${key}' ${what}.`)});`, '    }'];
  if (pattern) lines.push(`    if (!new RegExp(${tsString(`^(?:${pattern})$`)}, 'u').test(${name})) {`, ...fail('no respeta su formato declarado'));
  if (minLength != null || maxLength != null) {
    const cond = [minLength != null ? `${name}.length < ${minLength}` : null, maxLength != null ? `${name}.length > ${maxLength}` : null].filter(Boolean).join(' || ');
    lines.push(`    if (${cond}) {`, ...fail('no respeta su longitud declarada'));
  }
  if (min != null || max != null) {
    const bound = (value, op) =>
      parameter.tsType === 'Decimal'
        ? `${name}.compareTo(Decimal.parse(${tsString(String(value))})) ${op} 0`
        : parameter.tsType === 'bigint'
          ? `${name} ${op} ${value}n`
          : `${name} ${op} ${value}`;
    const cond = [min != null ? bound(min, '<') : null, max != null ? bound(max, '>') : null].filter(Boolean).join(' || ');
    lines.push(`    if (${cond}) {`, ...fail('está fuera del rango declarado'));
  }
  return lines;
}

function domainFile(model) {
  const parameters = model.service.parameters;
  const usesDecimal = parameters.some((parameter) => parameter.tsType === 'Decimal');
  const ctor = parameters.map((parameter) => `    /** ${parameter.description} */\n    readonly ${parameter.name}: ${parameter.tsType}`).join(',\n');
  return tsModule(
    parametersPath(model),
    usesDecimal ? [{ symbol: 'Decimal', from: DECIMAL_TS }] : [],
    `/**
 * Parámetros de despliegue de ${model.service.name}, ya validados.
 *
 * Value object de dominio: llega por inyección a quien lo necesite (un handler lo declara en su
 * \`inject\`), nunca leyendo la configuración desde application. Lo puebla ServiceParametersModule desde
 * \`${model.service.artifactId}.*\` de la configuración del perfil.
 *
 * Las cotas se comprueban AQUÍ, al construirlo: un valor mal puesto tumba el arranque.
 */
export class ${parametersClass(model)} {
  constructor(
${ctor}
  ) {
${parameters.flatMap(guardsFor).join('\n')}
  }
}`
  );
}

const READERS = {
  string: 'text',
  number: 'integer',
  bigint: 'long',
  Decimal: 'decimal',
  boolean: 'flag'
};

function moduleFile(model) {
  const parameters = model.service.parameters;
  const usesDecimal = parameters.some((parameter) => parameter.tsType === 'Decimal');
  const args = parameters
    .map((parameter) => `    ${READERS[parameter.tsType] ?? 'text'}(configuration, ${tsString(parameterProperty(model, parameter))})`)
    .join(',\n');
  return tsModule(
    SERVICE_PARAMETERS_MODULE_TS,
    [
      { symbol: 'Global', from: '@nestjs/common' },
      { symbol: 'Module', from: '@nestjs/common' },
      { symbol: 'DynamicModule', from: '@nestjs/common', type: true },
      { symbol: 'Configuration', from: CONFIG_TS, type: true },
      { symbol: parametersClass(model), from: parametersPath(model) },
      ...(usesDecimal ? [{ symbol: 'Decimal', from: DECIMAL_TS }] : [])
    ],
    `/**
 * Los parámetros de despliegue del perfil activo. Global: los handlers los inyectan por su clase
 * (${parametersClass(model)}) sin importar este módulo.
 *
 * Sin defaults aquí a propósito: el gradiente por perfil está en config/parameters/<perfil>/${model.service.artifactId}.yaml,
 * y en producción un parámetro obligatorio sin valor no deja arrancar.
 */
@Global()
@Module({})
export class ServiceParametersModule {
  static register(configuration: Configuration): DynamicModule {
    return {
      module: ServiceParametersModule,
      providers: [{ provide: ${parametersClass(model)}, useValue: serviceParameters(configuration) }],
      exports: [${parametersClass(model)}]
    };
  }
}

/** Lee y convierte cada parámetro; el dominio valida sus cotas al construirlo. */
export function serviceParameters(configuration: Configuration): ${parametersClass(model)} {
  return new ${parametersClass(model)}(
${args}
  );
}

function raw(configuration: Configuration, key: string): string | null {
  const value = configuration.get(key);
  return value == null || String(value).trim() === '' ? null : String(value).trim();
}
${[...new Set(parameters.map((parameter) => READERS[parameter.tsType] ?? 'text'))].map((reader) => READER_CODE[reader]).join('')}`
  );
}

// Un lector por tipo; se emiten solo los que el diseño usa. Un valor ausente llega como null al
// constructor del dominio, que es quien dice qué parámetro falta.
const READER_CODE = {
  text: `
function text(configuration: Configuration, key: string): string {
  return raw(configuration, key) as string;
}
`,
  integer: `
function integer(configuration: Configuration, key: string): number {
  const value = raw(configuration, key);
  if (value == null) return value as unknown as number;
  const parsed = Number(value);
  if (!/^-?\\d+$/.test(value) || !Number.isSafeInteger(parsed)) throw new Error(\`\${key} tiene que ser un entero: '\${value}'\`);
  return parsed;
}
`,
  long: `
function long(configuration: Configuration, key: string): bigint {
  const value = raw(configuration, key);
  if (value == null) return value as unknown as bigint;
  if (!/^-?\\d+$/.test(value)) throw new Error(\`\${key} tiene que ser un entero: '\${value}'\`);
  return BigInt(value);
}
`,
  decimal: `
function decimal(configuration: Configuration, key: string): Decimal {
  const value = raw(configuration, key);
  return (value == null ? value : Decimal.parse(value)) as Decimal;
}
`,
  flag: `
function flag(configuration: Configuration, key: string): boolean {
  const value = raw(configuration, key);
  if (value == null) return value as unknown as boolean;
  if (value !== 'true' && value !== 'false') throw new Error(\`\${key} tiene que ser true o false: '\${value}'\`);
  return value === 'true';
}
`
};
