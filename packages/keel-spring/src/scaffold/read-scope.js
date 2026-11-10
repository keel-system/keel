// La LECTURA ACOTADA (DSL 2.27, `reads` y `readMiss` en `authentication.scoping` y en `ownership.<Entidad>`) en
// keel-spring: incremento 1 de PLAN-DSL-227-LECTURA-ACOTADA.md. Lo que decide QUÉ (las lecturas, el camino, el
// predicado, la carga por id o por clave, la clave de caché y la nota) es de keel-core/gen/read-scope.js; aquí solo se
// escribe en Java:
//
//   · `ReadScope` (domain.repository): el valor neutral de D1, sellado, con lo que admite y su parte de la clave de
//     caché (D6). Vive junto a los puertos porque los puertos lo reciben.
//   · `ReadScopes` (infrastructure.configurations.security): lo construye desde el token, uno por bloque. Solo una
//     exención da `unrestricted`; un claim ausente es el conjunto vacío (D3).
//   · El componente `@JsonIgnore ReadScope readScope` del mensaje, que estampa el controller (D1), como la identidad.
//   · El predicado en el ADAPTADOR (D4): `readScope(root, query, cb, scope)` en la Specification de JPA, con una
//     subconsulta por salto del camino, y `readScope(scope)` en el Criteria de MongoDB, resolviendo los ids de cada salto.
//     Se suma (AND) a los criterios del finder y llega al conteo de la página, porque es la misma Specification.
//   · `loadScoped(id, scope)` y `loadScopedBy<Clave>(valor, scope)` (D5, T7): cargan, y si la fila existe preguntan al
//     motor si el MISMO predicado la admite. Fuera: vacío con `not-found`, el error declarado con `forbidden`.

import {
  readMissMessage,
  readScopePath,
  readScopeText,
  scopedLoadOf,
  scopedReadsOf,
  scopedRootsOf
} from '@keel-system/keel-core/gen/read-scope';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { javaFile, javaPath, subPackage } from './render.js';

export const READ_SCOPE_PKG = 'domain.repository';
export const READ_SCOPES_PKG = 'infrastructure.configurations.security';
export const READ_SCOPE = 'readScope';

const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;

export const usesReadScope = (model) => scopedReadsOf(model).length > 0;
export const readScopeImport = (model) => `${subPackage(model, READ_SCOPE_PKG)}.ReadScope`;

/** El componente del mensaje (D1): no llega del cuerpo, lo estampa el controller desde el token. */
export function readScopeComponent(model) {
  return { javaType: 'ReadScope', name: READ_SCOPE, imports: [readScopeImport(model)], validation: [], kind: 'base', readScope: true };
}

/** El método de `ReadScopes` que construye el scope de una lectura: uno por bloque. */
export function readScopesMethod(read) {
  return read.kind === 'scoping' ? 'scoping' : `ownerOf${read.block.split('.').pop()}`;
}

/** Lo que estampa el controller en el componente. */
export function stampReadScope(operation) {
  return `readScopes.${readScopesMethod(operation.readScope)}()`;
}

/** Las cargas acotadas de una raíz (T7): `[{ method, by, param: { name, javaType } }]`, sin repetir. */
export function scopedLoadsOf(model, entity) {
  const loads = new Map();
  for (const operation of scopedReadsOf(model)) {
    if (operation.readScope.root !== entity.name) continue;
    const load = scopedLoadOf(model, operation);
    if (!load || loads.has(load.method)) continue;
    const field = load.by === 'id' ? entity.idField : entity.fields.find((candidate) => candidate.name === load.field);
    loads.set(load.method, { ...load, param: { name: field.name, javaType: field.javaType, imports: field.imports ?? [] } });
  }
  return [...loads.values()];
}

/** ¿Lleva el adaptador de esta raíz el predicado del alcance? */
export function isScopedRoot(model, entity) {
  return scopedRootsOf(model).some((root) => root.entity?.name === entity.name);
}

function rootRead(model, entity) {
  return scopedRootsOf(model).find((root) => root.entity?.name === entity.name)?.read ?? null;
}

/** El miss de una carga: el error declarado (forbidden) o vacío (not-found). */
function missStatement(model, read, imports) {
  if (read.readMiss !== 'forbidden') {
    return `        // readMiss: not-found. Una fila ajena da el mismo 404 que una que no existe: no revela que existe.
        return Optional.empty();`;
  }
  const error = operationError(model, scopedReadsOf(model).find((op) => op.readScope.root === read.root && op.readScope.shape === 'single')?.name, read.error);
  imports.add(`${subPackage(model, 'domain.errors')}.${error.exceptionClass}`);
  const args = [JSON.stringify(readMissMessage(model, read)), ...(error.dynamicStatus ? ['403'] : [])];
  return `        // readMiss: forbidden. Existe y es ajena: el ${read.error} (403) del diseño, después del 404 de una que no existe.
        throw new ${error.exceptionClass}(${args.join(', ')});`;
}

/** Las firmas del puerto. */
export function readScopePortMethods(model, entity, imports) {
  const loads = scopedLoadsOf(model, entity);
  if (loads.length === 0) return [];
  imports.add(readScopeImport(model));
  const read = rootRead(model, entity);
  return loads.map((load) => {
    for (const name of load.param.imports) imports.add(name);
    const miss = read.readMiss === 'forbidden' ? `lanza ${read.error} (403)` : 'devuelve vacío, como si no existiera';
    return `    /**
     * Carga el agregado por ${load.by === 'id' ? 'su id' : `su ${load.field}`} si el alcance del llamante lo admite (${read.block}.reads:
     * ${readScopeText(read)}). Vacío si no existe; si existe y es ajeno, ${miss}. El scope lo estampa el borde.
     */
    Optional<${entity.name}> ${load.method}(${load.param.javaType} ${load.param.name}, ReadScope scope);`;
  });
}

function loadHeads(model, entity, imports, findBy) {
  return scopedLoadsOf(model, entity).map((load) => {
    for (const name of load.param.imports) imports.add(name);
    return `    @Override
    public Optional<${entity.name}> ${load.method}(${load.param.javaType} ${load.param.name}, ReadScope scope) {
        return admittedOrMiss(${findBy(load)}(${load.param.name}), scope);
    }`;
  });
}

const findByOf = (entity) => (load) => (load.by === 'id' ? 'findById' : `findBy${capital(load.field)}`);

// ─── JPA ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Los métodos del adaptador relacional: las cargas, el predicado y su comparador. */
export function readScopeJpaMethods(model, entity, imports, jpaField) {
  if (!isScopedRoot(model, entity)) return [];
  const read = rootRead(model, entity);
  for (const name of [
    readScopeImport(model),
    'jakarta.persistence.criteria.CriteriaBuilder',
    'jakarta.persistence.criteria.CriteriaQuery',
    'jakarta.persistence.criteria.Expression',
    'jakarta.persistence.criteria.Predicate',
    'jakarta.persistence.criteria.Root'
  ])
    imports.add(name);
  const methods = loadHeads(model, entity, imports, findByOf(entity));
  if (methods.length > 0) {
    const id = entity.idField;
    methods.push(`    /** El desenlace de una carga acotada (D5): la fila si el predicado la admite; si no, el readMiss del diseño. */
    private Optional<${entity.name}> admittedOrMiss(Optional<${entity.name}> found, ReadScope scope) {
        if (found.isEmpty() || scope instanceof ReadScope.Unrestricted) {
            return found;
        }
        ${id.javaType} key = found.get().get${capital(id.name)}();
        boolean admitted = ${jpaField}.exists((root, query, cb) -> cb.and(cb.equal(root.get("${id.name}"), key), readScope(root, query, cb, scope)));
        if (admitted) {
            return found;
        }
${missStatement(model, read, imports)}
    }`);
  }
  const path = readScopePath(model, read);
  const lines = [];
  let inner = `scoped(cb, ${path.hops.length > 0 ? `hop${path.hops.length}` : 'root'}.<String>get("${read.field}"), scope)`;
  // De dentro afuera: cada salto es una subconsulta que selecciona los ids de la raíz siguiente que cumplen lo de dentro.
  for (let at = path.hops.length; at >= 1; at -= 1) {
    const hop = path.hops[at - 1];
    const target = hop.entity;
    imports.add(`${subPackage(model, 'infrastructure.persistence.entities')}.${target.name}Jpa`);
    imports.add('jakarta.persistence.criteria.Subquery');
    for (const name of target.idField.imports ?? []) imports.add(name);
    lines.push(
      `        Subquery<${target.idField.javaType}> ids${at} = query.subquery(${target.idField.javaType}.class);`,
      `        Root<${target.name}Jpa> hop${at} = ids${at}.from(${target.name}Jpa.class);`,
      `        ids${at}.select(hop${at}.get("${target.idField.name}")).where(${inner});`
    );
    inner = `${at === 1 ? 'root' : `hop${at - 1}`}.get("${hop.relation}Id").in(ids${at})`;
  }
  methods.push(`    /**
     * El alcance de la lectura (${read.block}.reads): ${readScopeText(read)}. Va en la Specification de cada lectura
     * acotada, así que se suma a sus criterios y llega al conteo de la página (D4). Solo Unrestricted lo ve todo.
     */
    private static Predicate readScope(Root<${entity.name}Jpa> root, CriteriaQuery<?> query, CriteriaBuilder cb, ReadScope scope) {
        if (scope instanceof ReadScope.Unrestricted) {
            return cb.conjunction();
        }
${lines.join('\n')}${lines.length > 0 ? '\n' : ''}        return ${inner};
    }

    /** El campo acotado contra el scope. Un dueño nulo o un conjunto vacío no ve nada (D3): nunca todo. */
    private static Predicate scoped(CriteriaBuilder cb, Expression<String> value, ReadScope scope) {
        if (scope instanceof ReadScope.OwnedBy owned && owned.value() != null) {
            return cb.equal(value, owned.value());
        }
        if (scope instanceof ReadScope.Within within && !within.values().isEmpty()) {
            return value.in(within.values());
        }
        return cb.disjunction();
    }`);
  return methods;
}

/** La línea que el finder relacional añade a su Specification. */
export const JPA_SCOPE_LINE = '            where.add(readScope(root, query, cb, scope));';

// ─── MongoDB ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Los métodos del adaptador documental: las cargas, el predicado y su comparador. */
export function readScopeMongoMethods(model, entity, imports) {
  if (!isScopedRoot(model, entity)) return [];
  const read = rootRead(model, entity);
  for (const name of [readScopeImport(model), 'org.springframework.data.mongodb.core.query.Criteria', 'org.springframework.data.mongodb.core.query.Query', 'java.util.List'])
    imports.add(name);
  const mirror = `${entity.name}Document`;
  const methods = loadHeads(model, entity, imports, findByOf(entity));
  if (methods.length > 0) {
    const id = entity.idField;
    methods.push(`    /** El desenlace de una carga acotada (D5): la fila si el predicado la admite; si no, el readMiss del diseño. */
    private Optional<${entity.name}> admittedOrMiss(Optional<${entity.name}> found, ReadScope scope) {
        if (found.isEmpty() || scope instanceof ReadScope.Unrestricted) {
            return found;
        }
        Query mine = new Query(new Criteria().andOperator(Criteria.where("${id.name}").is(found.get().get${capital(id.name)}()), readScope(scope)));
        boolean admitted = mongoTemplate.exists(mine, ${mirror}.class);
        if (admitted) {
            return found;
        }
${missStatement(model, read, imports)}
    }`);
  }
  const path = readScopePath(model, read);
  const lines = [];
  let inner = `scoped("${read.field}", scope)`;
  for (let at = path.hops.length; at >= 1; at -= 1) {
    const hop = path.hops[at - 1];
    const target = hop.entity;
    imports.add(`${subPackage(model, 'infrastructure.persistence.documents')}.${target.name}Document`);
    for (const name of target.idField.imports ?? []) imports.add(name);
    // El salto más interior primero: el de fuera filtra por los ids que devuelve el de dentro.
    lines.push(
      `        Query hop${at} = new Query(${inner});`,
      `        hop${at}.fields().include("${target.idField.name}");`,
      `        List<${target.idField.javaType}> ids${at} = mongoTemplate.find(hop${at}, ${target.name}Document.class).stream().map(${target.name}Document::get${capital(target.idField.name)}).toList();`
    );
    inner = `Criteria.where("${hop.relation}Id").in(ids${at})`;
  }
  methods.push(`    /**
     * El alcance de la lectura (${read.block}.reads): ${readScopeText(read)}. Cada salto a otra raíz se resuelve a sus
     * ids, que es como se guarda la relación. Va en el Criteria de cada lectura acotada, también en el conteo de la página
     * (D4). Solo Unrestricted lo ve todo.
     */
    private Criteria readScope(ReadScope scope) {
${lines.map((line) => `${line}\n`).join('')}        return ${inner};
    }

    /** El campo acotado contra el scope. Un dueño nulo o un conjunto vacío no ve nada (D3): nunca todo. */
    private static Criteria scoped(String property, ReadScope scope) {
        if (scope instanceof ReadScope.OwnedBy owned && owned.value() != null) {
            return Criteria.where(property).is(owned.value());
        }
        if (scope instanceof ReadScope.Within within && !within.values().isEmpty()) {
            return Criteria.where(property).in(within.values());
        }
        return Criteria.where(property).in(List.of());
    }`);
  return methods;
}

/** Las líneas que el finder documental añade a su Criteria: nada con Unrestricted. */
export const MONGO_SCOPE_LINES = ['        if (!(scope instanceof ReadScope.Unrestricted)) {', '            where.add(readScope(scope));', '        }'];

// ─── Los tipos ────────────────────────────────────────────────────────────────────────────────────────────────

export function generate(model) {
  if (!usesReadScope(model)) return [];
  return [readScopeFile(model), readScopesFile(model)];
}

function readScopeFile(model) {
  const body = `/**
 * Qué filas ve quien lee (DSL 2.27, la lectura acotada de security.keel.yaml). Lo construye el borde desde el token
 * ({@code ReadScopes}) y lo estampa en el mensaje; el handler lo pasa al puerto y el ADAPTADOR lo aplica en la consulta,
 * en su total y en la carga por id. Desde otra puerta (un evento, el reloj) llega {@link #unrestricted()}.
 *
 * <ul>
 *   <li>{@link Unrestricted}: sin filtro. Solo lo da una exención.</li>
 *   <li>{@link OwnedBy}: el dueño es la identidad del llamante. Una identidad nula no ve nada.</li>
 *   <li>{@link Within}: el campo acotado está en el conjunto del claim. El conjunto vacío no ve nada.</li>
 * </ul>
 */
public sealed interface ReadScope {

    ReadScope UNRESTRICTED = new Unrestricted();

    record Unrestricted() implements ReadScope {
    }

    record OwnedBy(String value) implements ReadScope {
    }

    record Within(Set<String> values) implements ReadScope {

        public Within {
            values = Set.copyOf(values);
        }
    }

    static ReadScope unrestricted() {
        return UNRESTRICTED;
    }

    static ReadScope ownedBy(String value) {
        return new OwnedBy(value);
    }

    static ReadScope within(Collection<String> values) {
        return new Within(new HashSet<>(values));
    }

    /** ¿Ve este scope una fila cuyo valor acotado es {@code value}? */
    default boolean admits(String value) {
        if (this instanceof Unrestricted) {
            return true;
        }
        if (value == null) {
            return false;
        }
        if (this instanceof Within within) {
            return within.values().contains(value);
        }
        return value.equals(((OwnedBy) this).value());
    }

    /**
     * La parte del scope en la clave de una caché (D6): {@code all}, {@code by:<valor>}, {@code none} o
     * {@code in:<v1>,<v2>} ordenado, con la coma y la barra escapadas. Dos scopes distintos nunca comparten entrada.
     */
    default String cacheKey() {
        if (this instanceof OwnedBy owned) {
            return owned.value() == null ? "none" : "by:" + escape(owned.value());
        }
        if (this instanceof Within within) {
            return "in:" + within.values().stream().sorted().map(ReadScope::escape).collect(Collectors.joining(","));
        }
        return "all";
    }

    private static String escape(String value) {
        return value.replace("\\\\", "\\\\\\\\").replace(",", "\\\\,");
    }
}`;
  return {
    path: javaPath(model, READ_SCOPE_PKG, 'ReadScope'),
    content: javaFile(subPackage(model, READ_SCOPE_PKG), ['java.util.Collection', 'java.util.HashSet', 'java.util.Set', 'java.util.stream.Collectors'], body)
  };
}

function readScopesFile(model) {
  const pkg = subPackage(model, READ_SCOPES_PKG);
  const imports = new Set([readScopeImport(model), 'org.springframework.stereotype.Component']);
  const blocks = new Map();
  for (const operation of scopedReadsOf(model)) blocks.set(readScopesMethod(operation.readScope), operation.readScope);
  const fields = [];
  const params = [];
  const methods = [];
  const identity = model.security?.callerIdentity;
  let usesIdentityBean = false;
  for (const [method, read] of blocks) {
    if (read.kind === 'scoping') {
      imports.add(`${subPackage(model, 'application.support')}.CallerScope`);
      fields.push('    private final CallerScope callerScope;');
      params.push('CallerScope callerScope');
      methods.push(`    /**
     * ${read.block}: ${readScopeText(read)}. Exento (${[...read.exemptRoles.map((role) => `rol ${role}`), ...read.exemptClients.map((client) => `cliente ${client}`)].join(', ') || 'nadie'}):
     * sin filtro. Si no, el conjunto del claim, y un claim ausente es el conjunto VACÍO, que no ve nada (D3).
     */
    public ReadScope ${method}() {
        if (callerScope.isExempt()) {
            return ReadScope.unrestricted();
        }
        return ReadScope.within(callerScope.scopedValues());
    }`);
    } else {
      imports.add('org.springframework.security.core.Authentication');
      imports.add('org.springframework.security.core.context.SecurityContextHolder');
      const bean = Boolean(identity?.resolvedBy) && methodsIncludeBean(model);
      if (bean) usesIdentityBean = true;
      const exempt = read.exemptRoles.map((role) => `"ROLE_${role}"`).join(', ');
      methods.push(`    /**
     * ${read.block}: ${readScopeText(read)}.${read.exemptRoles.length > 0 ? ` Exentos los roles ${read.exemptRoles.join(', ')}: sin filtro.` : ''}
     * Si no, el dueño es la identidad del llamante (callerIdentity), la misma que estampa el controller.
     */
    public ReadScope ${method}() {${read.exemptRoles.length > 0
      ? `
        if (hasAny(${exempt})) {
            return ReadScope.unrestricted();
        }`
      : ''}
        return ReadScope.ownedBy(${bean ? 'callerIdentity.resolve()' : 'CallerIdentity.resolve()'});
    }`);
    }
  }
  if (usesIdentityBean) {
    fields.push('    private final CallerIdentity callerIdentity;');
    params.push('CallerIdentity callerIdentity');
  }
  if ([...blocks.values()].some((read) => read.kind === 'ownership' && read.exemptRoles.length > 0)) {
    methods.push(`    /** ¿Tiene el llamante alguna de estas authorities ({@code ROLE_<rol>}, las que pone el conversor del JWT)? */
    private static boolean hasAny(String... authorities) {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        java.util.Set<String> wanted = java.util.Set.of(authorities);
        return authentication.getAuthorities().stream().anyMatch(authority -> wanted.contains(authority.getAuthority()));
    }`);
  }
  const ctor = params.length > 0
    ? `
${fields.join('\n')}

    public ReadScopes(${params.join(', ')}) {
${params.map((param) => `        this.${param.split(' ')[1]} = ${param.split(' ')[1]};`).join('\n')}
    }
`
    : '';
  const body = `/**
 * El {@link ReadScope} de cada lectura acotada (DSL 2.27), construido desde el token de la petición en curso: lo estampa
 * el controller en el mensaje y el handler no lo vuelve a mirar. Solo una exención da {@code unrestricted} (D3).
 */
@Component
public class ReadScopes {
${ctor}
${methods.join('\n\n')}
}`;
  return { path: javaPath(model, READ_SCOPES_PKG, 'ReadScopes'), content: javaFile(pkg, [...imports], body) };
}

// CallerIdentity es un bean solo cuando resuelve la credencial a una clave natural (callerResolution de security.js);
// si no, es estático. Se decide igual que allí, sin importarlo (security.js importa de repositories.js).
function methodsIncludeBean(model) {
  const resolvedBy = model.security?.callerIdentity?.resolvedBy;
  const entity = resolvedBy && model.entities.find((candidate) => candidate.name === resolvedBy.entity);
  const field = entity?.fields.find((candidate) => candidate.name === resolvedBy.field);
  return Boolean(entity && (entity.naturalKey ?? []).length === 1 && field?.list);
}

/** La nota del handler, la de keel-core, con los nombres de Java. */
export function readScopeHandlerCall(model, operation, finderCallText) {
  const load = scopedLoadOf(model, operation);
  if (!load) return finderCallText;
  const repository = `${operation.readScope.root[0].toLowerCase()}${operation.readScope.root.slice(1)}Repository`;
  return `${repository}.${load.method}(query.${load.input}(), query.${READ_SCOPE}())`;
}
