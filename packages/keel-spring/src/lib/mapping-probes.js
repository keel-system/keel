// Conformidad EN VIVO del ESPEJO de persistencia: que la columna que el diseño pidió sea la
// columna que el motor creó.
//
// Por qué hace falta una red aquí. `persistence-adapter` es la superficie generada más grande y,
// hasta ahora, la única cuya red era **compilar**: `compile-check` la pasa por javac y las corridas
// la rozan de refilón. Pero un `@Column` es una anotación, y una anotación incompleta compila
// perfectamente. El defecto que este módulo persigue está documentado y ya ocurrió: una columna
// compuesta a mano «se quedaba en el nombre y perdía `nullable`, `length`, `precision/scale` y
// `columnDefinition`», que es lo único que llega al DDL.
//
// Y su modo de fallo es el de siempre — silencioso, y del lado que no se nota: la cota que el
// diseño declaró **deja de existir**. Hibernate da a un `String` sin `length` una columna
// `varchar(255)`, así que el servicio ACEPTA lo que el diseño dijo que no cabía. No falla nada, no
// se registra nada, y el escenario que escribiría alguien —guardar algo válido y leerlo— pasa
// igual. Lo único que lo distingue es preguntarle al motor.
//
// Qué se mide, y por qué esto y no la paginación. La primera idea fue el desempate de la
// paginación, que es el otro defecto silencioso famoso de esta capa. Se descartó por método: sin
// desempate el orden que devuelve el motor es ARBITRARIO, no incorrecto, así que un caso que
// buscara la fila repetida saldría verde por suerte más veces de las que saldría rojo — y un check
// que solo falla a veces enseña a ignorarlo. La cota de longitud, en cambio, el motor la responde
// sin ambigüedad: o rechaza la escritura o no la rechaza.
//
// Las DOS mitades son obligatorias, y es la lección de siempre: sin el caso del límite, una
// columna que rechazara TODO —o un motor que rechazara por otra razón— pasaría el caso del
// exceso con nota.

import { snakeCase } from './naming.js';
import { claimScenarios } from './claim-probes.js';

/**
 * La cota que el DISEÑO pidió, leída de la validación y NO del `@Column`.
 *
 * Esta distinción es el check entero, y la primera versión la tenía mal: sacaba la cota del mismo
 * `@Column` que iba a medir, así que al quitarle el `length` el sujeto DESAPARECÍA —«no hay columna
 * que medir»— en vez de ponerse rojo. Es la trampa de `mongo-check` otra vez: una red que deriva su
 * expectativa de la cosa que mide se mide a sí misma.
 *
 * `@Size(max = N)` y `@Column(length = N)` son DOS proyecciones independientes del mismo dato del
 * diseño (`maxLength` del tipo), emitidas por caminos distintos. Comparar una contra la otra a
 * través del motor es lo que hace que perder cualquiera de las dos se vea.
 */
const designMaxLength = (field) => {
  const size = (field.validation ?? []).join(' ').match(/@Size\(max = (\d+)\)/);
  return size ? Number(size[1]) : null;
};

export const PACKAGE_LEAF = 'mappingcheck';
export const CLASS_NAME = 'MappingCheckTest';

/**
 * El sujeto: una entidad persistida con un campo de texto OBLIGATORIO cuya columna declara una
 * cota. Obligatorio porque la siembra tiene que poder rellenarlo, y de texto porque la cota de un
 * decimal se mide de otra forma (por escala, no por rechazo) y es la siguiente tajada.
 *
 * Se elige la cota más PEQUEÑA disponible: cuanto más corta, más barato es fabricar el valor que
 * se pasa y menos posibilidades hay de que otra restricción de la fila se dispare antes.
 */
export function mappingSubject(model) {
  if (model.persistenceKind === 'document') return documentSubject(model);

  const candidatos = [];
  for (const entity of model.entities ?? []) {
    if (!entity.persisted) continue;
    // Solo raíces de agregado: son las únicas con puerto y repositorio de Spring Data propios.
    // Una hija se guarda a través de su raíz, y sembrarla suelta exigiría montar la raíz entera.
    if (!entity.isAggregateRoot) continue;
    // Y la fila entera tiene que poder sembrarse. `requiredLiterals` sabe fabricar escalares y
    // enums; un value object obligatorio —un `Money` en Product— no, y el Java saldría sin
    // compilar. Se descarta la ENTIDAD, no el campo: el fallo aparecería en la siembra y se
    // leería como «el motor rechazó», que es indistinguible de lo que este check mide.
    if (!seedable(model, entity)) continue;
    for (const field of entity.fields ?? []) {
      if (field.isId || field.list || !field.required) continue;
      if (field.javaType !== 'String') continue;
      const max = designMaxLength(field);
      // Se descarta la cota por defecto de Hibernate: no la puso el diseño, así que exigirla
      // mediría al ORM y no al generador.
      if (max === null || max >= 255) continue;
      candidatos.push({ entity, field, maxLength: max });
    }
  }
  if (candidatos.length === 0) return null;
  candidatos.sort((a, b) => a.maxLength - b.maxLength || a.field.name.localeCompare(b.field.name));
  return candidatos[0];
}

/**
 * Los tipos que la siembra compartida sabe fabricar. La lista es la de `literalFor` en
 * claim-probes.js, y se comprueba aquí en vez de dejar que falle el compilador porque el mensaje
 * de javac ("cannot find symbol: Money") no dice lo que pasa: que esta fixture no sirve de sujeto.
 */
const ESCALARES = new Set(['String', 'Integer', 'int', 'Long', 'long', 'BigDecimal', 'Boolean', 'boolean', 'Instant', 'UUID']);

/**
 * ¿Se puede sembrar una fila entera de esta entidad con la derivación compartida?
 *
 * Un enum del diseño SÍ —`values()[0]` no depende de cómo se llamen sus constantes— y por eso se
 * mira contra los enums del modelo: distinguirlo de un value object por el nombre del tipo Java es
 * imposible, y darlo por sembrable produce un `Money.values()[0]` que no compila.
 *
 * Una lista obligatoria queda fuera porque `requiredLiterals` lanza sobre ella a propósito: una
 * fila a medias entraría mal y el rechazo del motor se leería como el defecto que se persigue.
 */
const seedable = (model, entity) => {
  const enums = new Set((model.enums ?? []).map((e) => e.name ?? e));
  return (entity.fields ?? []).every(
    (field) =>
      field.isId ||
      !field.required ||
      (!field.list && (ESCALARES.has(field.javaType) || enums.has(field.javaType)))
  );
};

/**
 * El sujeto de la rama DOCUMENTAL, que es otro y no por gusto.
 *
 * En Mongo la cota de un texto no la impone el almacén —el documento acepta lo que sea—, así que
 * medirla ahí sería medir Bean Validation y no el mapeo. Lo que sí es del mapeo, y solo lo dice el
 * motor, es **con qué NOMBRE se guarda cada campo**.
 *
 * Y hay un camino que no pasa por la anotación: el reclamo. Su `Update` nombra el campo por su
 * PROPIEDAD JAVA y confía en que Spring Data lo traduzca al `@Field`. Si esa traducción no
 * ocurriera, se escribiría un campo PARALELO en camelCase: nadie falla, el reloj real queda nulo, y
 * lo que se ve después es un rescate que no encuentra jamás una fila atascada — un síntoma que no
 * se parece en nada a su causa. No es hipotético: es la sonda que la corrida
 * `notification-mailer-mongo` tuvo que añadir a mano (FL-SND-001-B), y esto la convierte en algo
 * repetible.
 *
 * La expectativa (el nombre almacenado) sale del mapeo; lo que se MIDE es el `Update` del reclamo.
 * Son dos caminos distintos, que es lo que hace que la comparación signifique algo.
 */
function documentSubject(model) {
  const scenarios = claimScenarios(model);
  const claim = (scenarios?.claims ?? []).find((candidate) => candidate.stamps?.field);
  if (!claim) return null;
  const javaName = claim.stamps.field;
  return {
    kind: 'document',
    entity: scenarios.entity,
    enumType: scenarios.enumType,
    statusField: scenarios.statusField,
    claim,
    javaName,
    storedName: snakeCase(javaName)
  };
}

export const hasSubject = (subject) => Boolean(subject);

const accessor = (prefix, field) => `${prefix}${field.charAt(0).toUpperCase()}${field.slice(1)}`;

/**
 * La clase JUnit, con los nombres sacados del MODELO y no escritos a mano.
 *
 * `requiredLiterals` viene de `claim-probes.js` a propósito: es la MISMA derivación de «qué hay
 * que rellenar para que la fila entre», y una segunda copia de esa regla se separaría el día que
 * una fixture añada un campo obligatorio — con el síntoma disfrazado de «el motor rechazó», que es
 * justo lo que este check mide.
 */
export function mappingTestClass(model, subject, options) {
  return subject.kind === 'document' ? documentClass(model, subject, options) : relationalClass(model, subject, options);
}

function relationalClass(model, subject, { datasource, packages, requiredLiterals }) {
  const base = model.service.basePackage;
  const { entity, field, maxLength } = subject;
  const espejo = `${entity.name}Jpa`;
  const repo = `${entity.name}JpaRepository`;
  const idField = entity.idField?.name ?? 'id';

  const imports = [
    'java.util.UUID',
    'java.time.Instant',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase',
    'org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest',
    `${packages.entities}.${espejo}`,
    `${packages.jpaRepositories}.${repo}`,
    // Import con comodín a propósito: la siembra nombra los enums del diseño que la entidad
    // declare, y enumerarlos aquí sería una segunda copia de esa derivación.
    `${base}.domain.enums.*`,
    'static org.junit.jupiter.api.Assertions.assertDoesNotThrow',
    'static org.junit.jupiter.api.Assertions.assertThrows'
  ];

  const propiedades = [
    `"spring.datasource.url=${datasource.url}"`,
    `"spring.datasource.username=${datasource.username}"`,
    `"spring.datasource.password=${datasource.password}"`,
    '"spring.jpa.hibernate.ddl-auto=update"'
  ];

  return {
    className: CLASS_NAME,
    package: `${base}.${PACKAGE_LEAF}`,
    content: `package ${base}.${PACKAGE_LEAF};

${imports.map((i) => (i.startsWith('static ') ? `import ${i};` : `import ${i};`)).join('\n')}

/**
 * ¿La cota que el diseño declaró para ${entity.name}.${field.name} (${maxLength}) existe de verdad
 * en la columna?
 *
 * Generado por scripts/mapping-check.js. No se edita: se regenera en cada pasada.
 *
 * <p>Un \`@Column\` al que le falte su \`length\` compila igual y produce un \`varchar(255)\`: el
 * servicio acepta lo que el diseño dijo que no cabía, y no lo delata nada. Las dos mitades hacen
 * falta —la del límite y la del exceso—: una columna que rechazara todo pasaría la segunda sola.
 */
@DataJpaTest(properties = {
        ${propiedades.join(',\n        ')}
})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
class ${CLASS_NAME} {

    private static final int COTA = ${maxLength};

    @Autowired
    private ${repo} repository;

    /** Una fila válida salvo por el campo que se mide, que lo pone cada caso. */
    private ${espejo} fila(String valor) {
        ${espejo} row = new ${espejo}();
        row.${accessor('set', idField)}(UUID.randomUUID());
${requiredLiterals.join('\n')}
        row.${accessor('set', field.name)}(valor);
        return row;
    }

    private static String texto(int largo) {
        return "x".repeat(largo);
    }

    @Test
    void elValorEnElLimiteEntra() {
        // La mitad positiva. Sin ella, una columna que rechazara CUALQUIER valor —o un motor que
        // rechazara por otra restricción de la fila— pasaría el caso de abajo con nota.
        assertDoesNotThrow(() -> repository.saveAndFlush(fila(texto(COTA))),
                "el valor que cabe justo en la cota declarada no entró: la columna no es la que el diseño pidió");
    }

    @Test
    void elValorQueSePasaLoRechazaElMotor() {
        // Y la que mide lo que ninguna otra red ve: si el @Column perdió su length, la columna es
        // varchar(255) y esto ENTRA — el servicio acepta lo que el diseño declaró imposible.
        assertThrows(Exception.class, () -> repository.saveAndFlush(fila(texto(COTA + 1))),
                "un valor de " + (COTA + 1) + " caracteres entró en una columna declarada de " + COTA
                        + ": la cota del diseño no llegó al DDL");
    }
}
`
  };
}

/**
 * La clase JUnit de la rama DOCUMENTAL.
 *
 * Ejecuta el reclamo GENERADO —el `findAndModify` del adaptador, no una copia— y después lee el
 * documento CRUDO. Leerlo por el mapeo no serviría: Spring Data usa la misma anotación para
 * escribir y para leer, así que un `@Field` equivocado pero consistente daría la vuelta entera sin
 * que se note. Lo único que distingue el campo bueno del PARALELO es preguntarle a la colección
 * por sus claves.
 */
function documentClass(model, subject, { datasource, packages, requiredLiterals }) {
  const base = model.service.basePackage;
  const { entity, claim, javaName, storedName, enumType } = subject;
  const espejo = `${entity.name}Document`;
  const adaptador = `${entity.name}RepositoryImpl`;
  // El nombre de la colección NO se adivina: lo dice el mapeo. Componerlo aquí (snakeCase del
  // nombre de la entidad) daba `job` donde la colección real es `jobs`, y el síntoma era el peor
  // posible: el documento sembrado aparecía intacto y parecía que el reclamo no lo movía.
  const desde = (claim.from ?? [])[0] ?? '';
  const hasta = claim.to ?? '';

  const imports = [
    'java.util.UUID',
    'java.time.Instant',
    'org.bson.Document',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.autoconfigure.ImportAutoConfiguration',
    'org.springframework.boot.test.autoconfigure.data.mongo.DataMongoTest',
    'org.springframework.context.annotation.Import',
    'org.springframework.data.mongodb.core.MongoTemplate',
    'de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration',
    `${packages.documents}.${espejo}`,
    `${packages.adapters}.${adaptador}`,
    `${base}.domain.enums.*`,
    'static org.junit.jupiter.api.Assertions.assertFalse',
    'static org.junit.jupiter.api.Assertions.assertNotNull',
    'static org.junit.jupiter.api.Assertions.assertTrue'
  ];

  // El lote del barrido va explícito: @DataMongoTest no carga los fragmentos de , así
  // que sin esto el @Value del adaptador se queda a 0 y el reclamo no recorre ninguna vuelta — un
  // rojo que habla del contexto de prueba y no del mapeo.
  const propiedades = [
    `"spring.data.mongodb.uri=${datasource.uri}"`,
    '"spring.profiles.active="',
    `"sweep.${claim.sweepKey}.batch-size=5"`
  ];

  return {
    className: CLASS_NAME,
    package: `${base}.${PACKAGE_LEAF}`,
    content: `package ${base}.${PACKAGE_LEAF};

${imports.map((i) => `import ${i};`).join('\n')}

/**
 * ¿El reclamo escribe el campo con el NOMBRE que el mapeo declara?
 *
 * Generado por scripts/mapping-check.js. No se edita: se regenera en cada pasada.
 *
 * <p>El {@code Update} del reclamo nombra {@code ${javaName}} —la propiedad Java— y confía en que
 * Spring Data lo traduzca a {@code ${storedName}}. Si no lo hiciera escribiría un campo PARALELO:
 * nadie falla, el reloj real queda nulo, y lo que se ve después es un rescate que no encuentra
 * jamás una fila atascada — un síntoma que no se parece en nada a su causa. Es la sonda que la
 * corrida notification-mailer-mongo tuvo que añadir a mano, hecha repetible.
 *
 * <p>El perfil {@code test} de este proyecto arranca flapdoodle (mongod embebido y STANDALONE):
 * sin apagarlo, esto mediría una base en memoria y saldría verde sin tocar el contenedor.
 */
@DataMongoTest(properties = {
        ${propiedades.join(',\n        ')}
})
@ImportAutoConfiguration(exclude = EmbeddedMongoAutoConfiguration.class)
@Import(${adaptador}.class)
class ${CLASS_NAME} {

    private String coleccion() {
        // El nombre lo dice el MAPEO, no una conjetura: componerlo a mano daba el singular donde la
        // colección real es el plural, y el síntoma era el peor posible: el documento sembrado
        // aparecía intacto y parecía que el reclamo no lo movía.
        return mongoTemplate.getCollectionName(${espejo}.class);
    }

    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private ${adaptador} adaptador;

    @Test
    void laBaseEsLaDelContenedorYNoUnaEnMemoria() {
        // Primero de todo, y por lo mismo que en store-check: si esto midiera una base embebida el
        // verde no diría nada del contenedor. Se afirma lo único que hace fallable la decisión.
        Document hello = mongoTemplate.executeCommand(new Document("hello", 1));
        assertTrue(hello.containsKey("setName"),
                "el servidor no es miembro de un replica set: se está midiendo una base en memoria");
    }

    @Test
    void elReclamoEscribeElCampoConSuNombreAlmacenado() {
        mongoTemplate.getCollection(coleccion()).deleteMany(new Document());
        UUID id = UUID.randomUUID();
        ${espejo} row = new ${espejo}();
        row.setId(id);
        row.setStatus(${enumType}.${desde.toUpperCase()});
${requiredLiterals.join('\n')}
        mongoTemplate.save(row);

        // El reclamo GENERADO, no una copia suya: es su Update el que se está midiendo.
        adaptador.${claim.method}();

        Document crudo = mongoTemplate.getCollection(coleccion()).find(new Document("_id", id)).first();
        assertNotNull(crudo, "el documento sembrado desapareció");
        assertTrue("${hasta.toUpperCase()}".equals(String.valueOf(crudo.get("status"))),
                "el reclamo no movió el estado, así que no hay nada que medir sobre el reloj: " + crudo.toJson());

        // La mitad positiva: el campo se escribió, y con el nombre del mapeo.
        assertNotNull(crudo.get("${storedName}"),
                "el reclamo no dejó ${storedName} en el documento: " + crudo.keySet());

        // Y la que caza el campo PARALELO, que es el defecto silencioso de esta rama.
        assertFalse(crudo.containsKey("${javaName}"),
                "el documento trae ${javaName} ADEMÁS de ${storedName}: el Update escribió por el nombre Java y la "
                        + "traducción del mapeo no ocurrió — el reloj real queda nulo y no lo dice nadie");
    }
}
`
  };
}
