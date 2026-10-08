// Muestras de agregados para los checks en vivo de la persistencia (db-check y doc-check): un agregado
// entero con valores que casan con las cotas y los patrones del diseño, y los ayudantes con los que la
// sonda compara lo guardado con lo leído. Las dos ramas de persistencia se miden con las MISMAS muestras.

import { randomUUID } from 'node:crypto';
import { LOCK_VERSION } from 'keel-core/gen';
import { domainMembers } from '../../src/scaffold/entities.js';
import { classPath, entityDir, DIRS } from '../../src/scaffold/render.js';

/**
 * Un texto que casa con un patrón del diseño, para las formas habituales (literales, clases,
 * \d \w \s, cuantificadores, grupos con alternativas). Se comprueba al final: si no casa, null.
 */
export function sampleFor(pattern, minLength = 0, maxLength = null, variant = 0) {
  const upper = String.fromCharCode(65 + (variant % 26));
  const lower = String.fromCharCode(97 + (variant % 26));
  const digit = String((7 + variant) % 10);
  const source = String(pattern).replace(/^\^/, '').replace(/\$$/, '');
  let index = 0;
  const pickClass = (body) => {
    const negated = body.startsWith('^');
    const content = negated ? body.slice(1) : body;
    if (negated) {
      for (const candidate of 'abcxyz019') if (!new RegExp(`[${body}]`).test(candidate) === false) return candidate;
      return 'a';
    }
    if (/^\\d/.test(content) || /0-9/.test(content)) return content.includes('A-Z') ? upper : content.includes('a-z') ? lower : digit;
    if (content.includes('A-Z')) return upper;
    if (content.includes('a-z')) return lower;
    const plain = content.replace(/\\./g, '').replace(/.-./g, '');
    return plain[0] ?? 'a';
  };
  const atom = () => {
    const char = source[index];
    if (char === '(') {
      let depth = 1;
      let end = index + 1;
      while (end < source.length && depth > 0) {
        if (source[end] === '\\') end += 1;
        else if (source[end] === '(') depth += 1;
        else if (source[end] === ')') depth -= 1;
        end += 1;
      }
      let inner = source.slice(index + 1, end - 1).replace(/^\?:/, '');
      inner = splitTop(inner)[0];
      index = end;
      return { text: sampleFor(inner) ?? '' };
    }
    if (char === '[') {
      let end = index + 1;
      while (end < source.length && source[end] !== ']') end += source[end] === '\\' ? 2 : 1;
      const body = source.slice(index + 1, end);
      index = end + 1;
      return { text: pickClass(body) };
    }
    if (char === '\\') {
      const next = source[index + 1];
      index += 2;
      return { text: next === 'd' ? digit : next === 'w' ? lower : next === 's' ? ' ' : next };
    }
    if (char === '.') {
      index += 1;
      return { text: 'a' };
    }
    index += 1;
    return { text: char };
  };
  const parts = [];
  if (splitTop(source).length > 1) return sampleFor(splitTop(source)[0], minLength, maxLength);
  while (index < source.length) {
    const { text } = atom();
    let times = 1;
    const quant = source[index];
    if (quant === '{') {
      const end = source.indexOf('}', index);
      const [min] = source.slice(index + 1, end).split(',');
      times = Math.max(Number(min) || 0, 1);
      index = end + 1;
    } else if (quant === '+') {
      index += 1;
    } else if (quant === '*' || quant === '?') {
      times = 0;
      index += 1;
    }
    parts.push(text.repeat(times));
  }
  let sample = parts.join('');
  while (sample.length < minLength) sample += sample.slice(-1) || 'a';
  if (maxLength != null && sample.length > maxLength) sample = sample.slice(0, maxLength);
  try {
    return new RegExp(`^(?:${pattern})$`).test(sample) ? sample : null;
  } catch {
    return null;
  }
}

function splitTop(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      current += char + (text[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (char === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

let nextInt = 0;
let nextVariant = 0;

/** La expresión JS de un valor de muestra para un campo (o sub-campo) del dominio. */
export function sampleValue(model, field, ctx, salt) {
  if (field.kind === 'enum') {
    const enumDef = model.enums.find((e) => e.name === field.namedType);
    ctx.imports.add(`${field.namedType}|${classPath(DIRS.enums, field.namedType)}`);
    const value = enumDef.values[enumDef.values.length > 1 ? 1 : 0];
    return `${field.namedType}.${value.constant}`;
  }
  if (field.kind === 'composite') {
    const vo = model.valueObjects.find((candidate) => candidate.name === field.namedType);
    // Un value object dentro de otro: en relacional build no lo mapea (deja un TODO al agente), así que
    // la muestra lo deja a null; en documental es un subdocumento más (`ctx.nestedValueObjects`).
    if (!vo || (!ctx.nestedValueObjects && vo.fields.some((sub) => sub.kind === 'composite'))) return null;
    ctx.imports.add(`${vo.name}|${classPath(DIRS.valueObjects, vo.name)}`);
    const args = vo.fields.map((sub) => (sub.list ? `[${sampleValue(model, sub, ctx, `${salt}a`)}]` : sampleValue(model, sub, ctx, salt)));
    if (args.some((arg) => arg == null || arg === '[null]')) return null;
    return `new ${vo.name}(${args.join(', ')})`;
  }
  const text = field.text ?? {};
  const numeric = field.numeric ?? {};
  switch (field.base) {
    case 'uuid':
      return `'${randomUUID()}'`;
    case 'int':
      // Distintos entre elementos: una posición repetida es un empate, y entonces el orden es del motor.
      return String((numeric.min != null ? Number(numeric.min) : 7) + nextInt++);
    case 'long':
      return '9007199254740993n';
    case 'decimal': {
      const scale = numeric.scale ?? 2;
      ctx.imports.add(`Decimal|src/domain/support/decimal.ts`);
      const whole = numeric.min != null && Number(numeric.min) > 12 ? String(Math.ceil(Number(numeric.min))) : '12';
      // Con ceros a la derecha a propósito: la escala es lo que se pierde por el camino.
      return `Decimal.parse('${scale > 0 ? `${whole}.${'5'.padEnd(scale, '0')}` : whole}')`;
    }
    case 'boolean':
      return 'true';
    case 'date':
      return `'2026-03-14'`;
    case 'timestamp':
      return `new Date('2026-03-14T09:21:07.482Z')`;
    case 'json':
      ctx.imports.add(`RawJson|src/domain/support/raw-json.ts`);
      return `RawJson.of('{"a":[1,2.50]}')`;
    default: {
      const min = text.minLength ?? 0;
      const max = text.maxLength ?? 40;
      if (text.pattern) {
        // Distinta en cada llamada (dos agregados de muestra no pueden compartir clave natural), y la
        // forma básica si la variante no casa con el patrón.
        const sample = sampleFor(text.pattern, min, max, nextVariant++) ?? sampleFor(text.pattern, min, max);
        if (sample == null) {
          ctx.unsampled.push(`${field.name} (${text.pattern})`);
          return null;
        }
        return JSON.stringify(sample);
      }
      const base = `${field.name}-${salt}`;
      return JSON.stringify(base.length > max ? base.slice(0, max) : base.padEnd(min, 'x'));
    }
  }
}

/** La expresión JS de un agregado (o entidad interna) de muestra, con su estado completo. */
export function sampleEntity(model, entity, ctx, salt, depth = 0) {
  ctx.imports.add(`${entity.name}|${classPath(entityDir(entity), entity.name)}`);
  const state = [];
  for (const member of domainMembers(model, entity)) {
    let value;
    if (member.kind === 'externalRef') value = `'${randomUUID()}'`;
    else if (member.kind === 'relationMany') {
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      value = depth > 2 || !child ? '[]' : `[${[1, 2].map((n) => sampleEntity(model, child, ctx, `${salt}${n}`, depth + 1)).join(', ')}]`;
    } else if (member.kind === 'relationOne') {
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      value = depth > 2 || !child ? 'null' : sampleEntity(model, child, ctx, `${salt}o`, depth + 1);
    } else if (member.field.list) {
      const values = [1, 2].map((n) => sampleValue(model, { ...member.field, list: false, kind: member.field.kind }, ctx, `${salt}${n}`));
      value = values.some((v) => v == null) ? '[]' : `[${values.join(', ')}]`;
    } else if (member.field.isId) {
      value = `'${randomUUID()}'`;
    } else {
      value = sampleValue(model, member.field, ctx, salt);
      if (value == null) value = 'null';
    }
    state.push(`${member.name}: ${value}`);
  }
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) state.push(`${LOCK_VERSION.field}: null`);
  return `new ${entity.name}({ ${state.join(', ')} })`;
}


/**
 * Los ayudantes que lleva dentro el script de sonda: el estado observable de un agregado (sus getters),
 * su instantánea comparable (decimal por su texto, bigint con sufijo, fechas ISO) y las diferencias.
 * Las colecciones de `UNORDERED` se comparan como conjuntos; la sonda declara esa constante.
 */
export const PROBE_HELPERS = `function stateOf(entity) {
  const out = {};
  let proto = Object.getPrototypeOf(entity);
  while (proto && proto !== Object.prototype) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (descriptor.get && !(key in out)) out[key] = entity[key];
    }
    proto = Object.getPrototypeOf(proto);
  }
  return out;
}

/** El estado observable de un valor: getters del agregado, campos de un value object, texto de un decimal. */
function snapshot(value) {
  if (value == null) return value;
  if (typeof value === 'bigint') return \`\${value}n\`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(snapshot);
  if (typeof value === 'object') {
    if (value.constructor?.name === 'Decimal') return \`D:\${value.toString()}\`;
    if (value.constructor?.name === 'RawJson') return \`J:\${value.text}\`;
    const getters = stateOf(value);
    const own = Object.keys(getters).length > 0 ? getters : { ...value };
    const out = {};
    // La versión y la última modificación las pone la persistencia, no quien guarda.
    for (const key of Object.keys(own).sort()) {
      if (key === 'lockVersion' || key === 'updatedAt' || key === 'updatedBy') continue;
      const item = snapshot(own[key]);
      out[key] = UNORDERED.has(key) && Array.isArray(item) ? [...item].sort((a, b) => String(a?.id).localeCompare(String(b?.id))) : item;
    }
    return out;
  }
  return value;
}

function differences(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((key) => differences(a[key], b[key], at ? \`\${at}.\${key}\` : key));
  }
  return [\`\${at}: \${JSON.stringify(a)} → \${JSON.stringify(b)}\`];
}`;
