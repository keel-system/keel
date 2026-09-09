// El JUnit con el que se mide, contra un Mongo de verdad, si el índice único CONDICIONADO que
// emite `build` en `MongoIndexConfig.java` sostiene la garantía que el diseño declaró.
//
// Por qué esta rama es Java y la relacional no. En relacional el artefacto es un `.sql` que el
// motor sabe ejecutar solo, así que el runner se lo manda por el cliente y no hace falta JDK. En
// Mongo el artefacto es una CLASE, y la única forma de no medir una copia de sí mismo es
// ejecutarla: renderizar aquí unos `createIndex` equivalentes en mongosh comprobaría que Mongo
// sabe crear índices parciales —que ya lo sabíamos— y no que el generador acierta. Es el defecto
// que tuvo `mongo-check` meses en verde.
//
// Lo que se ejecuta es, literalmente, el `@Bean ApplicationRunner` que build escribió.
// `@DataMongoTest` **no** corre los ApplicationRunner (solo lo hace SpringApplication), y eso es
// justo lo que hace falta: se invoca a mano, y se puede invocar DOS veces.
//
// El modo de fallo que esto cierra es el silencioso: un `partialFilterExpression` cuyo literal no
// case con lo que el mapeo guarda se crea SIN ERROR y no restringe ninguna fila. Es el mismo
// defecto que en PostgreSQL estuvo meses tapando otro (`= 'active'` contra una columna que guarda
// `ACTIVE`), y en Mongo no lo ve nadie: no pasa por javac, `java-syntax` solo tokeniza y el arnés
// corre el perfil `test`.

import { documentAssertions } from './index-probes.js';
import { accessor, requiredLiterals } from './claim-probes.js';

export const PACKAGE_LEAF = 'documentindexcheck';
export const CLASS_NAME = 'DocumentIndexCheckTest';

/** El id del caso que mide el literal del filtro. Se nombra aquí porque el runner lo cita. */
export const LITERAL_CASE = 'elLiteralDelFiltroCasaConLoQueElMapeoGuarda';

/** Un valor JS como literal Java. */
function javaLiteral(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * Un documento CRUDO como expresión Java.
 *
 * Las rutas con punto se ANIDAN en vez de escribirse tal cual: `new Document("a.b", v)` crea un
 * campo que se LLAMA "a.b", que no es lo que indexa un `partialFilterExpression` sobre `a.b`. Con
 * el sujeto de hoy (rutas planas) da igual; el día que una fixture indexe dentro de un value
 * object, escribirlo plano habría hecho que el índice no casara con nada y el caso saldría verde
 * culpando al generador.
 */
function bsonOf(pairs) {
  const tree = {};
  for (const [path, value] of pairs) {
    const parts = path.split('.');
    let node = tree;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = value;
  }
  const render = (node) => {
    const entries = Object.entries(node);
    const [first, ...rest] = entries;
    const cell = (v) => (v !== null && typeof v === 'object' ? render(v) : javaLiteral(v));
    return `new Document(${javaLiteral(first[0])}, ${cell(first[1])})${rest
      .map(([k, v]) => `.append(${javaLiteral(k)}, ${cell(v)})`)
      .join('')}`;
  };
  return render(tree);
}

/** El método de un caso de efecto: pasos en orden, cada uno con su desenlace esperado. */
function effectTest(assertion) {
  const steps = assertion.steps.map((step, n) => {
    const doc = bsonOf(step.doc);
    if (step.expect === 'ok') {
      return `        entra(${doc},
                "paso ${n + 1}: tenía que entrar y el motor la rechazó");`;
    }
    // Se exige el NOMBRE del índice que rechaza. Con la clave natural viva sobre la misma
    // colección, un E11000 a secas no distingue al condicionado del natural, y el caso podría
    // salir verde sin haber medido el índice que dice medir.
    return `        rechaza(${doc},
                ${javaLiteral(step.index)},
                "paso ${n + 1}: tenía que ser RECHAZADA por ${step.index}");`;
  });
  return `
    @Test
    void ${assertion.id}() {
        reset();
${steps.join('\n')}
    }`;
}

/**
 * El JUnit que ejercita `MongoIndexConfig` contra el Mongo real.
 *
 * @param {object} model            modelo del servicio
 * @param {object} spec             salida de `documentIndexSubject`
 * @param {object} opts.datasource  la conexión que build emitió en parameters/local/db.yaml
 * @param {object} opts.packages    paquete real de cada clase, leído del proyecto generado
 */
export function documentIndexTestClass(model, spec, { datasource, packages }) {
  const entity = model.entities.find((candidate) => candidate.name === spec.entity);
  const enumType = spec.whenField?.kind === 'enum' ? spec.whenField.javaType : null;

  // El valor con el que se construye el documento REAL, y de dónde sale importa más que cuál es.
  //
  // Tomarlo de `spec.partialFilter.equals` —lo que el emisor puso en el filtro— haría que este
  // caso se midiera a sí mismo: las dos mitades de la comparación vendrían del mismo sitio, así
  // que saldría verde diga lo que diga `storedWhenValue`. Se comprobó rompiéndolo: con la
  // traducción saboteada, el caso no se ponía rojo, la CLASE dejaba de compilar y el runner moría
  // con exit 2 —«el check no pudo correr», que no es lo mismo que «el generador está mal»—.
  //
  // Así que sale del ENUM del diseño, que es la vía independiente: el constante Java es
  // literalmente lo que `name()` devuelve, o sea lo que Spring Data va a escribir. Si el filtro y
  // el almacén dejan de coincidir, las dos mitades difieren y el caso lo dice.
  const enumDef = enumType ? (model.enums ?? []).find((candidate) => candidate.name === enumType) : null;
  const constante = enumDef?.values?.find((value) => value.literal === spec.when.equals)?.constant;
  if (enumType && !constante) {
    throw new Error(
      `index-check: '${spec.when.equals}' no es un valor de ${enumType}, así que no sé construir el documento del caso del literal`
    );
  }
  const whenValue = enumType ? `${enumType}.${constante}` : javaLiteral(spec.when.equals);

  const imports = [
    `${packages.config}.MongoIndexConfig`,
    `${packages.entities}.${spec.documentClass}`,
    ...(enumType ? [`${packages.enums}.${enumType}`] : []),
    'java.time.Instant',
    'java.util.UUID',
    'org.bson.Document',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.ApplicationRunner',
    'org.springframework.boot.autoconfigure.ImportAutoConfiguration',
    'org.springframework.boot.test.autoconfigure.data.mongo.DataMongoTest',
    'org.springframework.context.annotation.Import',
    'org.springframework.data.mongodb.core.MongoTemplate',
    'com.mongodb.MongoWriteException',
    'de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration',
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertNotNull',
    'static org.junit.jupiter.api.Assertions.assertThrows',
    'static org.junit.jupiter.api.Assertions.assertTrue',
    'static org.junit.jupiter.api.Assertions.fail'
  ];

  const properties = [
    `"spring.data.mongodb.uri=${datasource.uri}"`,
    // El perfil `test` trae el mongod EMBEBIDO (flapdoodle), standalone y en memoria. Sin
    // apagarlo esta suite mediría otra base y saldría verde sin tocar el contenedor. El primer
    // caso es lo que hace fallable la decisión.
    '"spring.profiles.active="'
  ];

  const effects = documentAssertions(spec).map((assertion) => effectTest(assertion));

  return {
    package: `${model.service.basePackage}.${PACKAGE_LEAF}`,
    className: CLASS_NAME,
    content: `package ${model.service.basePackage}.${PACKAGE_LEAF};

${imports.map((entry) => `import ${entry};`).join('\n')}

/**
 * Los índices DOCUMENTALES generados, ejercitados contra el Mongo real que levanta infra/.
 *
 * <p>Lo escribe scripts/index-check.js desde src/lib/document-index-probes.js: no es parte del
 * proyecto generado y no se versiona con él.
 *
 * <p><b>Se ejecuta la clase generada, no una copia suya.</b> {@code MongoIndexConfig} se importa
 * y su {@code ApplicationRunner} se invoca a mano —{@code @DataMongoTest} no corre los runners—,
 * que además es lo que permite invocarlo DOS veces para medir la idempotencia.
 *
 * <p><b>Contra el contenedor, no contra el embebido.</b> El perfil {@code test} de un proyecto
 * documental arranca flapdoodle; aquí se desactiva el perfil y se excluye su autoconfiguración.
 * Si eso fallara, la suite entera pasaría midiendo una base que no es la de infra/: por eso el
 * primer caso lo AFIRMA.
 */
@DataMongoTest(properties = {
        ${properties.join(',\n        ')}
})
@ImportAutoConfiguration(exclude = EmbeddedMongoAutoConfiguration.class)
@Import(MongoIndexConfig.class)
class ${CLASS_NAME} {

    private static final String COLECCION = ${javaLiteral(spec.collection)};
    private static final String INDICE = ${javaLiteral(spec.name)};
    private static final String RUTA_CONDICION = ${javaLiteral(spec.partialFilter.path)};

    @Autowired
    private MongoTemplate mongo;

    /** El @Bean que build escribió. Se resuelve por nombre: es el que crea los índices. */
    @Autowired
    private ApplicationRunner ensureMongoIndexes;

    /**
     * Colección vacía y con los índices recién creados.
     *
     * <p>Se rehace entera en vez de solo vaciarse porque JUnit NO garantiza el orden de los
     * casos y los de idempotencia dejan la colección sin índices: un caso de efecto que corriera
     * después mediría una colección sin índice y saldría verde por ausencia de garantía, que es
     * el desenlace exacto que este check existe para cazar.
     *
     * <p>Y vaciar entre aserciones no es higiene: aquí la clave natural está VIVA sobre la misma
     * colección, así que un documento que dejara puesto un caso haría que el siguiente muriera
     * por el índice natural y el rojo acusaría al condicionado.
     */
    private void reset() {
        mongo.getDb().getCollection(COLECCION).drop();
        creaIndices();
    }

    private void creaIndices() {
        try {
            ensureMongoIndexes.run(null);
        } catch (Exception e) {
            throw new IllegalStateException("MongoIndexConfig no pudo crear los índices: " + e, e);
        }
    }

    private void entra(Document doc, String porque) {
        try {
            mongo.getDb().getCollection(COLECCION).insertOne(doc);
        } catch (MongoWriteException e) {
            fail(porque + " — " + e.getError().getMessage());
        }
    }

    private void rechaza(Document doc, String indice, String porque) {
        MongoWriteException e = assertThrows(MongoWriteException.class,
                () -> mongo.getDb().getCollection(COLECCION).insertOne(doc), porque);
        // El nombre del índice viaja dentro del mensaje del driver (E11000 … index: uk_… dup key),
        // que es el MISMO contrato del que vive el ApiExceptionHandler para traducir la violación
        // al error del diseño.
        assertTrue(e.getError().getMessage().contains(indice),
                porque + ", y la rechazó otro índice: " + e.getError().getMessage());
    }

    /**
     * La aserción que hace fallable todo lo demás: contra el mongod embebido esta suite entera
     * mediría una base en memoria y saldría en verde sin haber tocado el contenedor.
     */
    @Test
    void seMideLaBaseDelContenedorYNoUnMongodEmbebido() {
        assertEquals("${model.service.name.replaceAll('-', '_')}", mongo.getDb().getName(),
                "la suite está hablando con otra base: el mongod embebido del perfil test");
        assertNotNull(mongo.getDb().runCommand(new Document("hello", 1)).getString("setName"),
                "el servidor no es miembro de un replica set: es el embebido, no el de infra/");
    }

    /**
     * Primera creación sobre una colección sin índices. Caza la colisión entre los specs que el
     * PROPIO emisor produce: dos nombres iguales con distinta definición (IndexOptionsConflict) o
     * dos nombres distintos con las mismas claves (IndexKeySpecsConflict). Ninguna de las dos la
     * ve nadie más — un nombre mal derivado es Java perfectamente válido.
     */
    @Test
    void idempotenciaPasada1() {
        mongo.getDb().getCollection(COLECCION).drop();
        creaIndices();
        assertTrue(indices().contains(INDICE), "MongoIndexConfig no creó " + INDICE);
    }

    /**
     * Segunda invocación sin tocar nada, que es lo que ocurre en CADA arranque de la aplicación.
     * Afirma lo que el javadoc de MongoIndexConfig PROMETE («createIndex es idempotente mientras
     * la definición no cambie») en vez de darlo por hecho.
     */
    @Test
    void idempotenciaPasada2() {
        mongo.getDb().getCollection(COLECCION).drop();
        creaIndices();
        creaIndices();
        assertTrue(indices().contains(INDICE), "la segunda pasada dejó la colección sin " + INDICE);
    }

    /**
     * El redespliegue: el índice ya existe con OTRA forma, que es lo que pasa cuando el diseño
     * cambia la condición. Mongo rechaza recrear el mismo nombre con otra definición, y lo que
     * aquí se mide no es eso —es de Mongo— sino que el generador deje que el fallo LLEGUE: un
     * try/catch alrededor del bloque dejaría arrancar la aplicación con el invariante sin
     * sostener, que es cambiar un fallo ruidoso por uno silencioso.
     */
    @Test
    void idempotenciaRedespliegue() {
        mongo.getDb().getCollection(COLECCION).drop();
        creaIndices();
        mongo.getDb().getCollection(COLECCION).dropIndex(INDICE);
        // El mismo nombre y las mismas claves, pero SIN el filtro parcial: un cambio de forma.
        mongo.getDb().getCollection(COLECCION).createIndex(
                ${bsonOf(spec.paths.map((path) => [path, 1]))},
                new com.mongodb.client.model.IndexOptions().name(INDICE).unique(true));

        IllegalStateException e = assertThrows(IllegalStateException.class, this::creaIndices,
                "el índice ya existía con otra forma y la creación no se quejó: el fallo se está tragando");
        assertTrue(e.getMessage().contains(INDICE),
                "falló, pero sin nombrar el índice: " + e.getMessage());
    }
${effects.join('\n')}

    /**
     * El literal del filtro contra lo que el MAPEO guarda de verdad. Es el único caso que pasa
     * por el espejo, y el que cierra el fallo silencioso: un partialFilterExpression que no case
     * con ningún documento se crea sin error y deja el invariante sin efecto.
     *
     * <p>Se lee el documento CRUDO y no por el mapeo a propósito: Spring Data usa la misma
     * anotación para escribir y para leer, así que un valor equivocado pero consistente daría la
     * vuelta entera sin que se note. Es la lección de mapping-check.
     */
    @Test
    void ${LITERAL_CASE}() {
        reset();
        ${spec.documentClass} row = new ${spec.documentClass}();
        row.setId(UUID.randomUUID());
        row.${accessor('set', spec.when.field)}(${whenValue});
${requiredLiterals({ entity, statusField: spec.when.field }, null, null).join('\n')}
        mongo.save(row);

        Document crudo = mongo.getDb().getCollection(COLECCION).find(new Document()).first();
        assertNotNull(crudo, "el mapeo no guardó el documento en " + COLECCION);
        assertEquals(${javaLiteral(spec.partialFilter.equals)}, crudo.get(RUTA_CONDICION),
                "el filtro del índice compara " + RUTA_CONDICION + " con "
                        + ${javaLiteral(spec.partialFilter.equals)}
                        + ", y el mapeo guarda otra cosa: el índice no casa con ningún documento"
                        + " y el invariante no lo sostiene nadie. Documento: " + crudo.toJson());
    }

    private java.util.List<String> indices() {
        java.util.List<String> nombres = new java.util.ArrayList<>();
        mongo.getDb().getCollection(COLECCION).listIndexes().forEach(ix -> nombres.add(ix.getString("name")));
        return nombres;
    }
}
`
  };
}
