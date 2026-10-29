// Los mapeos de la aplicación: `To<Dto>` traduce un agregado del dominio al DTO de cada operación que lo devuelve, y a
// los `<Hija>Dto` de las hijas que esos DTO proyectan. Asignación campo a campo y sin reflexión, el mismo reparto que
// los mappers de keel-spring, keel-nest y keel-dotnet. En Go son funciones del paquete, agrupadas en un archivo por
// entidad (`product_mapper.go`): no hay estado que guardar en un objeto mapeador.
//
// Lo que el mapeo no puede derivar del agregado entra por PARÁMETRO, para que el compilador no deje olvidarlo: el
// agregado embebido de otra raíz (solo guarda su id), el dato de otro servicio, el id de la raíz de una hija devuelta
// suelta y las filas de otra raíz leídas por su relación inversa. Y un campo del DTO que no sale tal cual de la
// entidad —no es miembro suyo, su tipo es otro, o la entidad lo admite nil y el DTO no— hace que la función devuelva
// además un error (`ErrNotImplemented` con el campo nombrado) en vez de inventar un valor. Solo esas funciones
// devuelven error: un mapeo que no puede fallar no lo declara. El archivo que lleva uno de esos huecos es del agente
// (sin cabecera de código generado), que es quien lo completa.

import { isPublicBucket } from '@keel-system/keel-core/gen';
import { mappersByEntity, reachableChildDtos } from '@keel-system/keel-core/gen/mapper-plan';
import { goExported } from '../lib/go-projection.js';
import { goString, keyedLiteral } from '../lib/go-source.js';
import { dataImports } from './dtos.js';
import { domainMembers } from './entities.js';
import { appType, applicationPath, declType, goTypeName, layout, localName, packageFile } from './render.js';

export function generate(model) {
  // Cada DTO, en el archivo de la entidad de la que sale: el de una hija, en el de la hija, alcance desde la raíz
  // que lo alcance. Así una hija proyectada por dos raíces tiene una sola función.
  const byEntity = new Map();
  const place = (entityName, dto) => {
    if (!model.entities.some((entity) => entity.name === entityName)) return;
    if (!byEntity.has(entityName)) byEntity.set(entityName, new Map());
    byEntity.get(entityName).set(goTypeName(dto.name), dto);
  };
  for (const [entityName, dtos] of mappersByEntity(model)) {
    if (!model.entities.some((entity) => entity.name === entityName)) continue;
    for (const dto of dtos.values()) place(entityName, dto);
    for (const child of reachableChildDtos(model, [...dtos.values()])) place(child.entity, child);
  }
  const plan = planFunctions(model, byEntity);
  return [...byEntity.entries()].map(([entityName, dtos]) => renderFile(model, entityName, [...dtos.keys()], plan));
}

/** Las funciones de mapeo, por nombre de DTO: su entidad, su DTO y si devuelve error (también por una hija que lo haga). */
function planFunctions(model, byEntity) {
  const plan = new Map();
  for (const [entityName, dtos] of byEntity) {
    for (const [name, dto] of dtos) plan.set(name, { entity: model.entities.find((e) => e.name === entityName), dto, name });
  }
  const fails = (name, seen = new Set()) => {
    const fn = plan.get(name);
    if (!fn || seen.has(name)) return false;
    seen.add(name);
    if (fn.ownFails === undefined) fn.ownFails = renderFunction(model, fn, () => false).fails;
    if (fn.ownFails) return true;
    return fn.dto.fields.some((field) => field.kind === 'childDto' && fails(goTypeName(field.elementGoType ?? field.goType.replace(/^\[\]/, '')), seen));
  };
  for (const fn of plan.values()) fn.fails = fails(fn.name);
  return plan;
}

function renderFile(model, entityName, names, plan) {
  const { application } = layout(model);
  const rendered = names.map((name) => renderFunction(model, plan.get(name), (child) => Boolean(plan.get(child)?.fails)));
  const todo = rendered.some((fn) => fn.todo);
  const imports = ['fmt', ...rendered.flatMap((fn) => fn.imports)];
  return {
    path: applicationPath(model, `${entityName}Mapper`),
    content: packageFile(model, application, { imports, body: `\n${rendered.map((fn) => fn.code).join('\n\n')}\n`, generated: !todo })
  };
}

const baseOf = (type) => type.replace(/^\*/, '');

/**
 * Una función `To<Dto>`. `childFails(nombre)` dice si el mapeo de una hija devuelve error, para propagarlo. Devuelve
 * el código, si la propia función tiene un hueco (`todo`), si devuelve error (`fails`) y sus imports.
 */
function renderFunction(model, fn, childFails) {
  const { entity, dto, name } = fn;
  const entityType = `*domain.${entity.name}`;
  const members = new Map(domainMembers(model, entity).map((member) => [member.name, member]));
  const idField = entity.fields.find((field) => field.isId);
  const params = [`entity ${entityType}`];
  const statements = [];
  const values = [];
  let todo = false;
  let fails = false;
  const zero = `${name}{}`;
  const missing = (what) => {
    todo = true;
    fails = true;
    return `\treturn ${zero}, fmt.Errorf("%w: %s", ErrNotImplemented, ${goString(`TODO (agente): ${name}.${what}`)})`;
  };

  for (const field of dto.fields) {
    const local = localName(field.name);
    const type = appType(field);
    if (field.kind === 'refDto' && field.refSource) {
      const source = goTypeName(field.refSource);
      if (field.list) {
        params.push(`${local} []${source}`);
        statements.push(missing(`${field.name}: recorta cada ${source} a ${goTypeName(field.elementGoType)}`));
        values.push(null);
        continue;
      }
      const variant = goTypeName(field.elementGoType ?? field.goType);
      if (type.startsWith('*')) {
        params.push(`${local} *${source}`);
        const out = `${local}Dto`;
        statements.push(`\tvar ${out} *${variant}\n\tif ${local} != nil {\n\t\t${out} = new(To${variant}(*${local}))\n\t}`);
        values.push(out);
      } else {
        params.push(`${local} ${source}`);
        values.push(`To${variant}(${local})`);
      }
      continue;
    }
    if (field.kind === 'refDto' || field.kind === 'needDto' || field.kind === 'parentId') {
      params.push(`${local} ${type}`);
      values.push(local);
      continue;
    }
    if (field.kind === 'childDto' && field.inverse) {
      const child = goTypeName(field.elementGoType);
      params.push(`${local} []*domain.${field.childEntity}`);
      statements.push(mapList(local, `${local}Dto`, child, '', childFails(child), zero));
      values.push(`${local}Dto`);
      continue;
    }
    const member = members.get(field.name);
    if (!member) {
      statements.push(missing(`${field.name}: no es miembro directo de ${entity.name}; mapéalo (¿subcampo de value object?)`));
      values.push(null);
      continue;
    }
    const getter = `entity.${goExported(member.name)}()`;
    // Un `file` de bucket público expone la URL, no la clave: la resuelve el puerto de almacenamiento (incremento 13).
    if (field.base === 'file' && !field.list && isPublicBucket(model, field.bucket)) {
      statements.push(missing(`${field.name}: resuelve la URL pública del bucket ${field.bucket} con el puerto de almacenamiento`));
      values.push(null);
      continue;
    }
    if (field.kind === 'childDto') {
      const child = goTypeName(field.elementGoType);
      const childDto = (model.childDtos ?? []).find((candidate) => candidate.entity === field.childEntity);
      const parentField = (childDto?.fields ?? []).find((candidate) => candidate.kind === 'parentId');
      if (parentField && parentField.parentEntity !== entity.name) {
        statements.push(missing(`${field.name}: proyecta ${child}, que pide el id de ${parentField.parentEntity}, y aquí solo hay un ${entity.name}`));
        values.push(null);
        continue;
      }
      const extra = parentField && idField ? `, entity.${goExported(idField.name)}()` : '';
      const out = `${local}Dto`;
      if (field.list) {
        statements.push(mapList(getter, out, child, extra, childFails(child), zero));
      } else if (type.startsWith('*')) {
        const call = childFails(child) ? null : `To${child}(found${extra})`;
        statements.push(
          call
            ? `\tvar ${out} *${child}\n\tif found := ${getter}; found != nil {\n\t\t${out} = new(${call})\n\t}`
            : `\tvar ${out} *${child}\n\tif found := ${getter}; found != nil {\n\t\tmapped, err := To${child}(found${extra})\n\t\tif err != nil {\n\t\t\treturn ${zero}, err\n\t\t}\n\t\t${out} = &mapped\n\t}`
        );
        if (childFails(child)) fails = true;
      } else {
        const found = `${local}Found`;
        statements.push(`\t${found} := ${getter}\n\tif ${found} == nil {\n${missing(`${field.name} es opcional en ${entity.name} y obligatorio en el DTO`).replace(/^\t/, '\t\t')}\n\t}`);
        if (childFails(child)) {
          statements.push(`\t${out}, err := To${child}(${found}${extra})\n\tif err != nil {\n\t\treturn ${zero}, err\n\t}`);
        } else statements.push(`\t${out} := To${child}(${found}${extra})`);
      }
      if (childFails(child)) fails = true;
      values.push(out);
      continue;
    }
    const wanted = declType(field);
    if (member.declaredLock && !wanted.startsWith('*')) {
      // La versión es nil solo antes de la primera escritura, y una respuesta sale de un agregado ya guardado o
      // leído: sin ella es un handler que mapea antes de guardar, no un dato que decidir.
      fails = true;
      statements.push(
        `\tif ${getter} == nil {\n\t\treturn ${zero}, fmt.Errorf("%w: %s", ErrNotImplemented, ${goString(`${entity.name}.${field.name} sin valor: la versión la pone la persistencia al guardar; mapea el agregado que devuelve el repositorio`)})\n\t}`
      );
      values.push(`*${getter}`);
      continue;
    }
    if (member.type === wanted) {
      values.push(getter);
      continue;
    }
    if (member.type === `*${wanted}`) {
      statements.push(`\tif ${getter} == nil {\n${missing(`${field.name} es opcional en ${entity.name} y obligatorio en el DTO: decide qué sale si falta`).replace(/^\t/, '\t\t')}\n\t}`);
      values.push(`*${getter}`);
      continue;
    }
    if (`*${member.type}` === wanted) {
      values.push(`new(${getter})`);
      continue;
    }
    statements.push(missing(`${field.name}: ${entity.name} lo guarda como ${baseOf(member.type)} y el DTO lo pide como ${wanted}`));
    values.push(null);
  }

  // Un hueco que corta la función entera: lo de detrás de un return incondicional no se alcanza (vet lo diría) y lo
  // de delante declararía variables que nadie lee (no compila), así que la función se queda en ese return.
  const unconditional = statements.findIndex((statement) => /^\treturn /.test(statement));
  const lines = unconditional >= 0 ? [statements[unconditional]] : statements;
  const pairs = dto.fields.map((field, index) => [goExported(field.name), values[index]]);
  const literal = `${name}{\n${keyedLiteral(pairs, '\t\t').join('\n')}\n\t}`;
  const tail = unconditional >= 0 ? '' : `\treturn ${literal}${fails ? ', nil' : ''}`;
  const returns = fails ? `(${name}, error)` : name;
  const body = [...lines, tail].filter(Boolean).join('\n');
  const code = `// To${name} traduce un ${entity.name} a ${name}.
func To${name}(${params.join(', ')}) ${returns} {
${body}
}`;
  // Los parámetros de un hueco incondicional no se leen, y eso es legal en Go: el agente los usará al completarlo.
  return { code, todo, fails, imports: dataImports(dto.fields) };
}

/** El bucle que mapea una colección de hijas a sus DTO, propagando el error si su mapeo lo devuelve. */
function mapList(source, out, child, extra, childFails, zero) {
  const call = `To${child}(item${extra})`;
  const append = childFails
    ? `\t\tmapped, err := ${call}\n\t\tif err != nil {\n\t\t\treturn ${zero}, err\n\t\t}\n\t\t${out} = append(${out}, mapped)`
    : `\t\t${out} = append(${out}, ${call})`;
  return `\t${out} := make([]${child}, 0, len(${source}))\n\tfor _, item := range ${source} {\n${append}\n\t}`;
}
