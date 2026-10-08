// El RECLAMO de un barrido (incremento 10c): llevarse un lote de filas pendientes de forma que dos réplicas
// nunca se lleven la misma. Es el mismo mecanismo que genera keel-spring (su `claim.js`), sobre TypeORM.
//
// Por qué lo genera build y no el agente: el reloj dispara el barrido en TODAS las réplicas, y el camino de
// menor resistencia para quien escribe el handler a mano —leer el lote con un finder por estado y marcarlo
// después— sale verde con una sola instancia y se lo da entero a todas en producción.
//
// Dos capas, como en keel-spring:
//   · llevarse la fila: un UPDATE condicional (`… WHERE id = :id AND estado IN :desde`). Una fila afectada
//     = es mía; cero = otra réplica llegó antes. La marca es el PROPIO estado de destino del diseño;
//   · elegir a qué filas tirarle: la lectura con FOR UPDATE SKIP LOCKED, para que cada réplica reciba
//     candidatos distintos. Es una optimización: el reclamo es correcto sin ella.
// Y dos sujetos: la COLA (filas que esperan) y el RESCATE de un estado en vuelo (`claim.stalled`), que lleva
// una cota temporal —sin ella, reclamar es arrancarle el trabajo a quien lo está haciendo— y que NO cambia el
// estado: lo ARRIENDA renovando su reloj; la transición la hace el dominio, que fija los campos que exige.
//
// Qué reclama cada barrido, en qué orden y de qué claves salen el lote y el plazo lo decide keel-core
// (`operation.claim[]`, `claimOrderField`, `sweepConfig`): las mismas decisiones que en keel-spring.

import { claimOrderField, claimsForEntity, screamingSnake, sweepClaims, sweepConfig } from 'keel-core/gen';
import { DIRS, classPath, tsModule, tsString } from './render.js';
import { engineOf, ormClass, usesPersistence } from './persistence-entities.js';
import { parametersClass, parametersPath } from './service-parameters.js';

const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
export const SWEEP_SETTINGS_TS = 'src/infrastructure/persistence/sweep-settings.ts';
const PROFILES = ['local', 'develop', 'production', 'test'];

/** ¿Genera build algún reclamo de barrido? En los dos modelos (el documental desde el incremento 12c). */
export function usesSweepClaims(model) {
  return usesPersistence(model) && sweepClaims(model).length > 0;
}

export function generate(model) {
  if (!usesSweepClaims(model)) return [];
  return [
    { path: SWEEP_SETTINGS_TS, content: settingsFile(model) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/sweep.yaml`, content: sweepYaml(model, profile) }))
  ];
}

const envWithDefault = (profile, name, value) => (profile === 'local' || profile === 'test' ? String(value) : `\${${name}:${value}}`);

function sweepYaml(model, profile) {
  const lines = ['sweep:'];
  for (const { key, entries } of sweepConfig(model)) {
    lines.push(`  ${key}:`);
    for (const entry of entries) {
      if (entry.kind === 'batch') {
        lines.push(
          '    # Cota del lote por pasada: capacidad, no diseño; misma familia que outbox.relay.batch-size.',
          `    batch-size: ${envWithDefault(profile, entry.env, entry.default)}`
        );
      } else {
        lines.push(
          `    # ${entry.operation.name}: un ${entry.claim.entity} que lleva más de esto en ${entry.claim.stalled.state} (medido sobre`,
          `    # ${entry.claim.stalled.stampField}) se da por abandonado y otra réplica lo rescata. Por ENCIMA de un ciclo completo.`,
          `    stalled-after-seconds: ${envWithDefault(profile, entry.env, entry.default)}`
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function settingsFile(model) {
  const config = sweepConfig(model);
  const batches = config.flatMap(({ key, entries }) => entries.filter((entry) => entry.kind === 'batch').map((entry) => ({ key, entry })));
  const stalled = config.flatMap(({ key, entries }) => entries.filter((entry) => entry.kind === 'stalled').map((entry) => ({ key, entry })));
  return tsModule(
    SWEEP_SETTINGS_TS,
    [{ symbol: 'Configuration', from: CONFIG_TS, type: true }],
    `/** Token de la configuración de los barridos ya resuelta. */
export const SWEEP_SETTINGS = Symbol('SWEEP_SETTINGS');

export interface SweepSettings {
  /** La cota del lote de cada barrido, por su clave (\`sweep.<clave>.batch-size\`). */
  readonly batchSize: Readonly<Record<string, number>>;
  /** El plazo de abandono de cada rescate no enlazado a un parámetro (\`sweep.<clave>.stalled-after-seconds\`). */
  readonly stalledAfterSeconds: Readonly<Record<string, number>>;
}

/**
 * Lee los barridos del perfil, con las claves y los defaults del servidor de keel-spring. Un valor que no
 * es un entero positivo no deja arrancar.
 */
export function sweepSettings(configuration: Configuration): SweepSettings {
  return {
    batchSize: {
${batches.map(({ key, entry }) => `      ${tsString(key)}: positive(configuration, ${tsString(`sweep.${key}.${entry.leaf}`)}, ${entry.default})`).join(',\n')}
    },
    stalledAfterSeconds: {
${stalled.map(({ key, entry }) => `      ${tsString(key)}: positive(configuration, ${tsString(`sweep.${key}.${entry.leaf}`)}, ${entry.default})`).join(',\n')}
    }
  };
}

function positive(configuration: Configuration, key: string, fallback: number): number {
  const value = configuration.get(key);
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(\`\${key} tiene que ser un entero positivo: '\${String(value)}'\`);
  return parsed;
}`
  );
}

// ─── El puerto ───────────────────────────────────────────────────────────────

/** Los métodos de reclamo del puerto <E>Repository, con lo que el agente tiene que saber de cada uno. */
export function portClaimMethods(model, entity) {
  return claimsForEntity(model, entity.name).map((claim) => `  /**
${describe(claim, entity.name)
  .split('\n')
  .map((line) => `   * ${line}`.trimEnd())
  .join('\n')}
   */
  abstract ${claim.method}(): Promise<${entity.name}[]>;`);
}

function describe(claim, entityName) {
  const stamp = claim.stamps
    ? `\n\nDevuelve las filas con ${claim.stamps.field} YA estampado, en el mismo UPDATE que el cambio de estado, porque\n${claim.stamps.reason} consulta esa marca. No la vuelvas a poner desde el handler: una caída entre las dos escrituras\ndejaría la fila con la marca a null, invisible para siempre a quien la busca por antigüedad.`
    : '';
  if (claim.stalled) {
    const deadline = claim.stalled.parameter
      ? `el parámetro del diseño ${claim.stalled.parameter.name} (en ${claim.stalled.parameter.unit})`
      : `sweep.${claim.stalled.configKey}.stalled-after-seconds`;
    return `Rescata hasta el lote de ${entityName} ATASCADOS en ${claim.stalled.state}: los devuelve SIGUIENDO en ${claim.stalled.state}, con
${claim.stalled.stampField} renovado, para que el handler los pase a ${claim.to}.

Reclama, no lee: corre en TODAS las réplicas, y solo devuelve lo que ESTA se llevó (un UPDATE condicional que
solo casa si la fila sigue atascada, y que renueva el reloj). Confirma en su propia transacción antes de volver.

No cambia el estado, lo ARRIENDA: la transición a ${claim.to} es del dominio, que fija los campos que ese estado
exige. Si el ciclo muere entre el reclamo y la transición, la fila sigue en ${claim.stalled.state} con el reloj
renovado y otro rescate la recoge pasado el plazo.

Solo se lleva lo ABANDONADO: ${claim.stalled.stampField} más viejo que ${deadline}. Lo que devuelve es trabajo que
alguien dejó a medias: si el ciclo que murió ya produjo un efecto irreversible, repetirlo lo duplica.${stamp}`;
  }
  const due = claim.due ? ` Solo los que ya vencieron (${claim.due.field} <= ahora).` : '';
  return `Reclama hasta el lote de ${entityName} en ${claim.from.join(' o ')} y los pasa a ${claim.to}.${due}

Reclama, no lee: corre en TODAS las réplicas a la vez, y lo que devuelve son SOLO las filas que ESTA se llevó
(el paso a ${claim.to} va en un UPDATE condicional). Leer el lote con un finder y marcarlo después se lo daría
entero a todas. Confirma en su propia transacción antes de volver: actúa sobre lo que devuelve FUERA de ella.${stamp}`;
}

// ─── El adaptador ────────────────────────────────────────────────────────────

/** Lo que el constructor del adaptador inyecta además de la transacción: la configuración y, si un rescate lo lee, los parámetros. */
export function claimDependencies(model, entity) {
  const claims = claimsForEntity(model, entity.name);
  if (claims.length === 0 || !usesPersistence(model)) return [];
  const deps = [{ token: 'SWEEP_SETTINGS', name: 'sweeps', type: 'SweepSettings', imports: [{ symbol: 'SWEEP_SETTINGS', from: SWEEP_SETTINGS_TS }, { symbol: 'SweepSettings', from: SWEEP_SETTINGS_TS, type: true }] }];
  if (claims.some((claim) => claim.stalled?.parameter)) {
    deps.push({ token: parametersClass(model), name: 'parameters', type: parametersClass(model), imports: [{ symbol: parametersClass(model), from: parametersPath(model) }] });
  }
  return deps;
}

/** Los métodos de reclamo del adaptador TypeORM. `findOptions(where)` es el de la carga del agregado entero. */
export function adapterClaimMethods(model, entity, imports, findOptions) {
  const claims = claimsForEntity(model, entity.name);
  if (claims.length === 0) return [];
  const { enumType, field } = entity.lifecycle;
  const orm = ormClass(entity.name);
  imports.push({ symbol: enumType, from: classPath(DIRS.enums, enumType) });
  const mysql = engineOf(model) === 'mysql';
  // READ COMMITTED en MySQL: en REPEATABLE READ la lectura con bloqueo toma también los HUECOS entre claves
  // y frena los INSERT de filas nuevas hasta el lock wait timeout. Es la misma decisión que keel-spring.
  const isolation = mysql ? ", { isolation: 'READ COMMITTED' }" : '';
  const operators = new Set();
  const methods = claims.map((claim) => {
    const states = claim.from.map((state) => `${enumType}.${screamingSnake(state)}`).join(', ');
    const order = claimOrderField(entity, claim);
    const extra = [];
    const setup = [];
    if (claim.stalled) {
      operators.add('LessThan');
      const seconds = claim.stalled.parameter
        ? `this.parameters.${claim.stalled.parameter.name} * ${claim.stalled.parameter.unitSeconds}`
        : `this.sweeps.stalledAfterSeconds[${tsString(claim.stalled.configKey)}]!`;
      setup.push(
        '    // La cota del rescate: solo lo que lleva atascado más que el plazo. Se calcula UNA vez para la',
        '    // lectura y para cada UPDATE: recalcularla movería la cota entre las dos.',
        `    const staleBefore = new Date(Date.now() - (${seconds}) * 1000);`
      );
      extra.push(`${claim.stalled.stampField}: LessThan(staleBefore)`);
    }
    if (claim.due) {
      operators.add('LessThanOrEqual');
      setup.push(`    // Solo lo que ya venció (${claim.due.field} <= ahora).`, '    const now = new Date();');
      extra.push(`${claim.due.field}: LessThanOrEqual(now)`);
    }
    // El instante con el que se estampa o se arrienda: uno por tanda.
    if (claim.stamps || claim.stalled) setup.push('    const claimedAt = new Date();');
    const condition = (head) => `states.map((state) => ({ ${[...head, `${field}: state`, ...extra].join(', ')} }))`;
    const set = claim.stalled
      ? `{ ${claim.stalled.stampField}: claimedAt }`
      : `{ ${field}: ${enumType}.${screamingSnake(claim.to)}${claim.stamps ? `, ${claim.stamps.field}: claimedAt` : ''} }`;
    return `  async ${claim.method}(): Promise<${entity.name}[]> {
${setup.join('\n')}${setup.length > 0 ? '\n' : ''}    const states = [${states}];
    return this.transactions.inNewTransaction(async (manager) => {
      // Los candidatos, del más antiguo al más nuevo. SKIP LOCKED: cada réplica recibe candidatos DISTINTOS
      // en vez de pelearse por la misma página; el bloqueo dura lo que esta transacción, que termina al reclamar.
      const candidates = await manager
        .createQueryBuilder(${orm}, 'e')
        .select(['e.id'])
        .where(${condition([])})
        .orderBy('e.${order}', 'ASC')
        .limit(this.sweeps.batchSize[${tsString(claim.sweepKey)}]!)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();
      const claimed: ${entity.name}[] = [];
      for (const { id } of candidates) {
        // El reclamo: ${claim.stalled ? `renueva ${claim.stalled.stampField} SOLO si la fila sigue atascada en ${claim.stalled.state}; el estado no se toca` : `pasa la fila a ${claim.to} SOLO si sigue en su estado de partida`}. 1 = es mía; 0 = otra
        // réplica la reclamó entre la lectura y esta escritura. Esa comparación es toda la exclusión mutua.
        const result = await manager
          .createQueryBuilder()
          .update(${orm})
          .set(${set})
          .where(${condition(['id'])})
          .execute();
        if (!result.affected) continue;
        const found = await manager.findOne(${orm}, ${findOptions('{ id }')});
        if (found != null) claimed.push(toDomain${entity.name}(found));
      }
      return claimed;
    }${isolation});
  }`;
  });
  for (const operator of operators) imports.push({ symbol: operator, from: 'typeorm' });
  return methods.map((method, index) => `  /** El reclamo del puerto (${claims[index].stalled ? 'rescate' : 'cola'}): ver ${entity.name}Repository.${claims[index].method}. */
${method}`);
}

