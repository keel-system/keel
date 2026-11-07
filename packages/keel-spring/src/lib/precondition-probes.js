// Las sondas de la ESCRITURA CONDICIONAL (DSL 2.25, api.concurrency) para keel-spring: los casos CW-1 a CW-11 de
// keel-core/gen/conditional-writes.js, con los mismos ids que ejecutan keel-dotnet, keel-nest y keel-go. Dos clases JUnit
// que scripts/precondition-check.js escribe dentro del proyecto generado (no forman parte de él):
//
//   · el ADAPTADOR (CW-1 a CW-5), contra el motor real que levanta infra/: la carga con la vigente, la otra versión es
//     la precondición sin tocar la fila, la esperada nula no compara, save devuelve la versión nueva que ve una lectura
//     posterior (T1), y otra escritura entre la carga y el guardado sigue siendo el conflicto de concurrencia (409), no
//     el 412;
//   · el BORDE (CW-6 a CW-11), sin base: el 428 por MockMvc con el interceptor y el controller generados (y el mediator
//     de mentira, que no se toca), los casos de la cabecera de keel-core/gen/wire.js, el 412 de ApiExceptionHandler, el
//     ETag expuesto en CORS, el formato del ETag y la entrada de la caché con su versión (RedisOperationCache sobre un
//     CacheManager en memoria: lo que cambia es el tipo que guarda, y el store lo miden las corridas).

import { conditionalWritesOf } from '@keel-system/keel-core/gen/conditional-writes';
import { conditionalWriteCases } from '@keel-system/keel-core/gen/api-cases';
import { WIRE_ETAG_CASES } from '@keel-system/keel-core/gen/wire';
import { cachedOperations } from '@keel-system/keel-core/gen/cache-plan';
import { constructorArgs } from './finder-probes.js';
import { conexionPerezosa } from './claim-probes.js';
import { LOCK_VERSION } from '@keel-system/keel-core/gen/relational';

export const PACKAGE_LEAF = 'preconditioncheck';
export const ADAPTER_CLASS = 'PreconditionAdapterCheckTest';
export const EDGE_CLASS = 'PreconditionEdgeCheckTest';

const java = (text) => JSON.stringify(text);
const decap = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

/** Las raíces que carga alguna escritura condicional. */
export function conditionalRoots(model) {
  const names = new Set((conditionalWritesOf(model)?.writes ?? []).map((write) => write.root));
  return model.entities.filter((entity) => names.has(entity.name));
}

/** Los tipos que nombran las sondas y cuyo paquete hay que leer del proyecto generado. */
export function namedTypes(model) {
  const names = new Set();
  for (const entity of conditionalRoots(model)) {
    names.add(entity.name);
    const visit = (field) => {
      if (field.kind === 'enum') names.add(field.namedType);
      if (field.kind === 'composite') {
        names.add(field.namedType);
        model.valueObjects.find((candidate) => candidate.name === field.namedType)?.fields.forEach(visit);
      }
    };
    entity.fields.filter((field) => field.name !== LOCK_VERSION.field || entity.declaresLockVersion).forEach(visit);
  }
  return [...names];
}

/** CW-1 a CW-5 contra el adaptador generado. */
export function adapterTestClass(model, { packages, document, datasource, collaborators = [] }) {
  const imports = new Set([
    'java.math.BigDecimal',
    'java.time.Instant',
    'java.time.LocalDate',
    'java.util.List',
    'java.util.UUID',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.context.annotation.Import',
    'org.springframework.dao.OptimisticLockingFailureException',
    `${packages.errors}.PreconditionFailedException`,
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertFalse',
    'static org.junit.jupiter.api.Assertions.assertThrows',
    'static org.junit.jupiter.api.Assertions.assertTrue'
  ]);
  const use = { enum: (name) => imports.add(`${packages.types[name]}.${name}`), type: (name) => imports.add(`${packages.types[name]}.${name}`) };
  const roots = conditionalRoots(model);
  const fields = [];
  if (!document) {
    imports.add('org.springframework.transaction.PlatformTransactionManager');
    imports.add('org.springframework.transaction.TransactionDefinition');
    imports.add('org.springframework.transaction.support.TransactionTemplate');
    fields.push('    @Autowired\n    private PlatformTransactionManager transactions;');
  }
  const tests = [];
  let seed = 501;
  for (const entity of roots) {
    imports.add(`${packages.types[entity.name]}.${entity.name}`);
    imports.add(`${packages.port}.${entity.name}Repository`);
    imports.add(`${packages.adapters}.${entity.name}RepositoryImpl`);
    const port = decap(`${entity.name}Repository`);
    const id = `get${entity.idField.name[0].toUpperCase()}${entity.idField.name.slice(1)}()`;
    fields.push(`    @Autowired\n    private ${entity.name}Repository ${port};`);
    const saved = () => `        ${entity.name} saved = ${port}.save(new ${entity.name}(${constructorArgs(model, entity, seed++, {}, use).join(', ')}));
        long version = version(saved);`;
    const name = entity.name;
    tests.push(`
    @Test
    void cw1_${name}_cargarConLaVersionVigenteDevuelveElAgregado() {
${saved()}
        var current = ${port}.loadExpecting(saved.${id}, List.of(version));
        assertTrue(current.isPresent(), "CW-1: no cargó con la versión vigente");
        assertEquals(version, version(current.get()), "CW-1: cargó otra versión");
    }

    @Test
    void cw2_${name}_cargarConOtraVersionEsLaPrecondicionYNoTocaLaFila() {
${saved()}
        assertThrows(PreconditionFailedException.class, () -> ${port}.loadExpecting(saved.${id}, List.of(version + 1)), "CW-2: otra versión no es la precondición");
        // Una cabecera con solo elementos débiles o ilegibles llega como lista vacía: no casa con nada.
        assertThrows(PreconditionFailedException.class, () -> ${port}.loadExpecting(saved.${id}, List.of()), "CW-2: la lista vacía casa");
        assertEquals(version, version(${port}.findById(saved.${id}).orElseThrow()), "CW-2: la precondición tocó la fila");
    }

    @Test
    void cw3_${name}_cargarSinVersionEsperadaNoCompara() {
${saved()}
        var unchecked = ${port}.loadExpecting(saved.${id}, null);
        assertTrue(unchecked.isPresent(), "CW-3: con null no cargó");
        assertEquals(version, version(unchecked.get()), "CW-3: con null cargó otra versión");
    }

    @Test
    void cw4_${name}_saveDevuelveLaVersionNuevaLaQueVeUnaLecturaPosterior() {
${saved()}
        ${entity.name} mine = ${port}.loadExpecting(saved.${id}, List.of(version)).orElseThrow();
        long returned = version(${port}.save(mine));
        long read = version(${port}.findById(saved.${id}).orElseThrow());
        assertEquals(version + 1, returned, "CW-4: save devuelve la versión " + returned + " y la persistida es " + read);
        assertEquals(version + 1, read, "CW-4: la lectura posterior ve la versión " + read);
    }

    @Test
    void cw5_${name}_otraEscrituraEntreLaCargaYElGuardadoEsEl409NoEl412() {
${saved()}
${document
  ? `        ${entity.name} late = ${port}.loadExpecting(saved.${id}, List.of(version)).orElseThrow();
        ${port}.save(${port}.findById(saved.${id}).orElseThrow());
        RuntimeException thrown = assertThrows(RuntimeException.class, () -> ${port}.save(late), "CW-5: se guardó encima de otra escritura");`
  : `        // Como en un handler: cargar y guardar en UNA transacción (la del mediator), y otra escritura confirmada en medio.
        TransactionTemplate handler = new TransactionTemplate(transactions);
        TransactionTemplate other = new TransactionTemplate(transactions);
        other.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        RuntimeException thrown = assertThrows(RuntimeException.class, () -> handler.executeWithoutResult(status -> {
            ${entity.name} late = ${port}.loadExpecting(saved.${id}, List.of(version)).orElseThrow();
            other.executeWithoutResult(inner -> ${port}.save(${port}.findById(saved.${id}).orElseThrow()));
            ${port}.save(late);
        }), "CW-5: se guardó encima de otra escritura");`}
        assertFalse(thrown instanceof PreconditionFailedException, "CW-5: el conflicto de la ventana salió como 412");
        assertTrue(thrown instanceof OptimisticLockingFailureException, "CW-5: no es el conflicto de concurrencia (409): " + thrown);
    }`);
  }
  // Lo que el adaptador pide en su constructor y no trae la rebanada de Spring Data (la tienda del reclamo de
  // reconciliación, la configuración de transacciones de Mongo): `collaborators`, con su nombre cualificado.
  // La tienda del reclamo se trae con su paquete: su escritor es package-private.
  for (const collaborator of collaborators) imports.add(collaborator.fqn);
  const scanned = collaborators.filter((collaborator) => collaborator.type === 'ReconciliationClaimStore');
  const adapters = [...roots.map((entity) => `${entity.name}RepositoryImpl.class`), ...collaborators.filter((c) => !scanned.includes(c)).map((collaborator) => `${collaborator.type}.class`)].join(', ');
  if (scanned.length > 0) {
    imports.add('org.springframework.boot.test.context.TestConfiguration');
    imports.add('org.springframework.context.annotation.ComponentScan');
    fields.unshift(`    @TestConfiguration
    @ComponentScan(basePackageClasses = ${scanned.map((c) => `${c.type}.class`).join(', ')})
    static class Collaborators {
    }`);
  }
  const header = document
    ? `@DataMongoTest(properties = {
        ${java(`spring.mongodb.uri=${datasource.uri}`)},
        // El perfil test arranca un mongod EMBEBIDO: sin apagarlo, la sonda mediría una base en memoria.
        "spring.profiles.active=local"
})
@ImportAutoConfiguration(exclude = EmbeddedMongoAutoConfiguration.class)
@Import({ ${adapters} })`
    : `@DataJpaTest(properties = {
        ${java(`spring.datasource.url=${datasource.url}`)},
        ${java(`spring.datasource.username=${datasource.username}`)},
        ${java(`spring.datasource.password=${datasource.password ?? ''}`)},${conexionPerezosa(datasource).map((p) => `\n        ${p},`).join('')}
        "spring.jpa.hibernate.ddl-auto=create-drop",
        "spring.flyway.enabled=false",
        // Los parámetros que el adaptador lee (los plazos de sus barridos), los del perfil local.
        "spring.profiles.active=local"
})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Import({ ${adapters} })
// Sin transacción de test: cada llamada al adaptador es la suya, como en un handler despachado por el mediator.
@Transactional(propagation = Propagation.NOT_SUPPORTED)`;
  if (document) {
    imports.add('org.springframework.boot.data.mongodb.test.autoconfigure.DataMongoTest');
    imports.add('org.springframework.boot.autoconfigure.ImportAutoConfiguration');
    imports.add('de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration');
  } else {
    imports.add('org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest');
    imports.add('org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase');
    imports.add('org.springframework.transaction.annotation.Propagation');
    imports.add('org.springframework.transaction.annotation.Transactional');
  }
  return `package ${model.service.basePackage}.${PACKAGE_LEAF};

${[...imports].sort().map((entry) => `import ${entry};`).join('\n')}

/**
 * La escritura condicional (api.concurrency) contra el adaptador generado y el motor real que levanta infra/: CW-1 a
 * CW-5. Lo escribe scripts/precondition-check.js desde src/lib/precondition-probes.js: no es parte del proyecto.
 */
${header}
class ${ADAPTER_CLASS} {

${fields.join('\n\n')}
${tests.join('\n')}

    /** La versión de la raíz como número: un Long con 'all', un int con 'declared' (T5). */
    private static long version(Object aggregate) {
        try {
            return ((Number) aggregate.getClass().getMethod("getLockVersion").invoke(aggregate)).longValue();
        } catch (ReflectiveOperationException failure) {
            throw new IllegalStateException(failure);
        }
    }
}
`;
}

/**
 * CW-6 a CW-11, sin base. `controller` es el controller de la escritura del caso CW-6 con los tipos de su constructor
 * (`{ name, pkg, params: [{ type, fqn }] }`), o null si no hay URL de muestra para ella.
 */
export function edgeTestClass(model, { packages, controller }) {
  const cases = conditionalWriteCases(model);
  const imports = new Set([
    'java.util.List',
    'org.junit.jupiter.api.Test',
    'org.springframework.http.ResponseEntity',
    `${packages.errors}.PreconditionFailedException`,
    `${packages.rest}.ApiExceptionHandler`,
    `${packages.rest}.ConditionalRequests`,
    `${packages.rest}.ErrorResponse`,
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertTrue'
  ]);
  const tests = [];
  if (cases.required && cases.write && controller) {
    const { required } = cases.errors;
    imports.add(`${controller.pkg}.${controller.name}`);
    imports.add(`${packages.rest}.IfMatchInterceptor`);
    imports.add('org.mockito.Mockito');
    imports.add('org.springframework.http.MediaType');
    imports.add('org.springframework.test.web.servlet.MockMvc');
    imports.add('org.springframework.test.web.servlet.setup.MockMvcBuilders');
    imports.add('org.springframework.test.web.servlet.request.MockMvcRequestBuilders');
    imports.add('static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath');
    imports.add('static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status');
    for (const param of controller.params) imports.add(param.fqn);
    const mocks = controller.params.map((param) => `Mockito.mock(${param.type}.class)`);
    const verb = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' }[cases.write.method];
    const body = ['POST', 'PUT', 'PATCH'].includes(cases.write.method) ? '.contentType(MediaType.APPLICATION_JSON).content("{}")' : '';
    tests.push(`
    @Test
    void cw6_unaEscrituraCondicionalSinIfMatchEs428YNoLlegaAlCasoDeUso() throws Exception {
        Object[] collaborators = { ${mocks.join(', ')} };
        ${controller.name} controller = new ${controller.name}(${controller.params.map((param, at) => `(${param.type}) collaborators[${at}]`).join(', ')});
        MockMvc mvc = MockMvcBuilders.standaloneSetup(controller)
                .addInterceptors(new IfMatchInterceptor())
                .setControllerAdvice(new ApiExceptionHandler())
                .build();
        mvc.perform(MockMvcRequestBuilders.${verb}(${java(cases.write.url)})${body})
                .andExpect(status().is(${required.status}))
                .andExpect(jsonPath("$.status").value(${required.status}))
                .andExpect(jsonPath("$.error").value(${java(required.error)}))
                .andExpect(jsonPath("$.code").value(${java(required.code)}))
                .andExpect(jsonPath("$.message").value(${java(required.message)}));
        // El 428 sale del interceptor, antes de resolver los argumentos: el caso de uso no se despacha.
        for (Object collaborator : collaborators) {
            Mockito.verifyNoInteractions(collaborator);
        }
    }`);
  }
  for (const entry of cases.headerCases) {
    const expected = entry.expected == null ? 'null' : `List.of(${entry.expected.map((version) => `${version}L`).join(', ')})`;
    const header = entry.header == null ? 'null' : java(entry.header);
    const id = entry.id.replaceAll('-', '_');
    const matches = entry.outcome === 'absent'
      ? ''
      : `
        // Lo mismo que compara loadExpecting: null no compara; si no, la vigente tiene que estar en la lista.
        assertEquals(${entry.outcome === 'match'}, stamped == null || stamped.contains(${entry.current}L), "CW-7 ${entry.id}: la vigente ${entry.current}");`;
    tests.push(`
    @Test
    void cw7_${id}() {
        List<Long> stamped = ConditionalRequests.expectedVersions(${header});
        assertEquals(${expected}, stamped, "CW-7 ${entry.id}: lo que se estampa");
        assertEquals(${entry.outcome === 'absent'}, ConditionalRequests.absent(${header}), "CW-7 ${entry.id}: ausente");${matches}
    }`);
  }
  const { failed } = cases.errors;
  tests.push(`
    @Test
    void cw8_laPrecondicionSaleComo412ConSuCodeYSuTexto() {
        ResponseEntity<ErrorResponse> response = new ApiExceptionHandler().onDomainException(new PreconditionFailedException());
        assertEquals(${failed.status}, response.getStatusCode().value(), "CW-8: status");
        ErrorResponse body = response.getBody();
        assertEquals(${failed.status}, body.status(), "CW-8: status del cuerpo");
        assertEquals(${java(failed.error)}, body.error(), "CW-8: error");
        assertEquals(${java(failed.code)}, body.code(), "CW-8: code");
        assertEquals(${java(failed.message)}, body.message(), "CW-8: message");
    }`);
  if (model.security?.cors) {
    imports.add(`${packages.security}.CorsConfig`);
    imports.add('org.springframework.mock.web.MockHttpServletRequest');
    imports.add('org.springframework.test.util.ReflectionTestUtils');
    tests.push(`
    @Test
    void cw9_corsExponeElEtag() {
        CorsConfig config = new CorsConfig();
        ReflectionTestUtils.setField(config, "allowedOrigins", List.of("http://localhost:5173"));
        var cors = config.corsConfigurationSource().getCorsConfiguration(new MockHttpServletRequest("GET", "/"));
        assertTrue(cors.getExposedHeaders() != null && cors.getExposedHeaders().contains(${java(cases.exposedHeader)}), "CW-9: CORS no expone ETag: " + cors.getExposedHeaders());
    }`);
  }
  for (const entry of WIRE_ETAG_CASES) {
    tests.push(`
    @Test
    void cw10_${entry.id.replaceAll('-', '_')}() {
        assertEquals(${java(entry.etag)}, ConditionalRequests.etagOf(${entry.version}L), "CW-10: el ETag de la versión ${entry.version}");
    }`);
  }
  const cached = cachedReader(model);
  if (cached) {
    imports.add(`${packages.cache}.RedisOperationCache`);
    imports.add(`${packages.support}.CachedOperations`);
    imports.add(`${packages.interfaces}.Versioned`);
    imports.add(`${packages.dtos}.${cached.dto}`);
    imports.add('org.springframework.cache.concurrent.ConcurrentMapCacheManager');
    imports.add('tools.jackson.databind.json.JsonMapper');
    tests.push(`
    @Test
    void cw11_unAciertoDeCacheDevuelveElMismoEtagQueLaLecturaQueLaLleno() {
        ConcurrentMapCacheManager manager = new ConcurrentMapCacheManager();
        RedisOperationCache cache = new RedisOperationCache(manager, JsonMapper.builder().build());
        String name = CachedOperations.${cached.constant};
        Versioned<${cached.dto}> first = cache.getOrLoad(name, "k", () -> new Versioned<${cached.dto}>(7L, null));
        Versioned<${cached.dto}> hit = cache.getOrLoad(name, "k", () -> {
            throw new AssertionError("CW-11: la entrada no se leyó: se volvió a cargar");
        });
        assertEquals(first.version(), hit.version(), "CW-11: el acierto devuelve otra versión");
        // Una entrada sin la versión (la de un servicio que guardaba solo el cuerpo) no se lee: es un miss, no un ETag
        // inventado.
        manager.getCache(name).put("sin-version", "{\\"value\\":null}");
        Versioned<${cached.dto}> reloaded = cache.getOrLoad(name, "sin-version", () -> new Versioned<${cached.dto}>(9L, null));
        assertEquals(9L, reloaded.version(), "CW-11: una entrada sin versión se leyó como versión " + reloaded.version());
    }`);
  }
  return `package ${model.service.basePackage}.${PACKAGE_LEAF};

${[...imports].sort().map((entry) => `import ${entry};`).join('\n')}

/**
 * La escritura condicional (api.concurrency) en el borde, sin base: CW-6 a CW-11 con los casos de keel-core/gen/wire.js.
 * Lo escribe scripts/precondition-check.js desde src/lib/precondition-probes.js: no es parte del proyecto.
 */
class ${EDGE_CLASS} {
${tests.join('\n')}
}
`;
}

/** La lectura que da el ETag y además se cachea, con su constante y su DTO; o null. */
export function cachedReader(model) {
  const readers = new Set((conditionalWritesOf(model)?.readers ?? []).map((reader) => reader.name));
  const cache = cachedOperations(model).find((entry) => readers.has(entry.operation));
  if (!cache) return null;
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.name === cache.operation);
  return { constant: cache.constant, dto: operation.responseDto.name };
}
