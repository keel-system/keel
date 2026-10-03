// Precisión de los instantes en el JSON de salida.
//
// El tipo `timestamp` del DSL mapea a java.time.Instant, y el serializador por
// defecto de JSR-310 emite tantos dígitos fraccionarios como traiga el valor:
// milisegundos en una máquina, microsegundos o nanosegundos en otra, según de
// dónde venga el Instant (Instant.now() en JDK 9+ da microsegundos; un
// TIMESTAMP leído de PostgreSQL, otra cosa). Eso convierte el formato temporal
// —convención de determinación del diseño y contrato observable— en un detalle
// de plataforma.
//
// spring.jackson no expone la precisión fraccionaria (solo timestamp numérico
// vs. ISO-8601), así que se fija en código: appendInstant(3) emite SIEMPRE tres
// dígitos y sufijo Z. Es una sola definición para todo el servicio, y la caché
// (cache.js) registra el mismo módulo para no divergir de la respuesta.

import { javaFile, javaPath, subPackage } from './render.js';
import { cachedOperations } from './cache.js';

const SERIALIZATION_PKG = 'infrastructure.serialization';
// En application y no en infrastructure: lo anotan los DTO y los commands, que no pueden
// depender de la infraestructura (la frontera hexagonal va de fuera hacia dentro).
const RAW_JSON_PKG = 'application.support';

// Sin api, messaging ni caché no hay nada que serializar fuera del proceso.
export function usesJackson(model) {
  return Boolean(
    model.layersPresent.api || model.layersPresent.messaging || cachedOperations(model).length > 0
  );
}

export function timestampModuleImport(model) {
  return `${subPackage(model, SERIALIZATION_PKG)}.TimestampModule`;
}

export function generate(model) {
  if (!usesJackson(model)) return [];
  const files = [renderModule(model), renderConfig(model)];
  if (usesRawJson(model)) files.push(renderRawJsonDeserializer(model));
  return files;
}

// ─── Campos `json` en el cable ───────────────────────────────────────────────
//
// Un campo `json` del DSL es un documento JSON opaco: se guarda como texto (String en
// Java, columna text) pero en el cable viaja EMBEBIDO como valor JSON, no como una cadena
// con el JSON escapado dentro. Con String a secas Jackson haría lo segundo, y quien consume
// tendría que parsear dos veces lo que el contrato declara como objeto (la acción del
// cliente de un cobro, por ejemplo). Se resuelve en el borde y no en el tipo: dentro del
// proceso sigue siendo un String que nadie interpreta.

/** ¿Es este campo un `json` que viaja embebido? Las listas de `json` quedan fuera. */
export function isRawJsonField(field) {
  return field?.base === 'json' && !field.list;
}

/**
 * Las anotaciones que hacen viajar un campo `json` como valor embebido, en las dos
 * direcciones; vacío para cualquier otro campo. Añade sus imports a `imports`.
 */
export function rawJsonAnnotations(model, field, imports) {
  if (!isRawJsonField(field)) return '';
  imports.add('com.fasterxml.jackson.annotation.JsonRawValue');
  imports.add('com.fasterxml.jackson.databind.annotation.JsonDeserialize');
  imports.add(`${subPackage(model, RAW_JSON_PKG)}.RawJsonDeserializer`);
  return '@JsonRawValue @JsonDeserialize(using = RawJsonDeserializer.class) ';
}

// Hay deserializador que emitir si algún campo resuelto del modelo es `json`. Se busca en el
// modelo entero y no registro por registro: todo emisor que llame a rawJsonAnnotations
// necesita la clase, y quedarse corto aquí es un main que no compila.
export function usesRawJson(model) {
  const seen = new Set();
  const stack = [model];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (typeof node.javaType === 'string' && isRawJsonField(node)) return true;
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return false;
}

function renderRawJsonDeserializer(model) {
  const body = `/**
 * Lee un campo \`json\` del cable y lo guarda como el texto del documento.
 *
 * Es la otra mitad de {@code @JsonRawValue}: al escribir, el String se emite tal cual,
 * embebido; al leer, un objeto o un array llega aquí como árbol y se vuelve a texto. Una
 * cadena también se acepta, y se toma como el documento ya serializado, para no romper a
 * un emisor que todavía lo mande escapado.
 */
public class RawJsonDeserializer extends JsonDeserializer<String> {

    @Override
    public String deserialize(JsonParser parser, DeserializationContext context) throws IOException {
        JsonNode node = parser.readValueAsTree();
        if (node == null || node.isNull()) {
            return null;
        }
        return node.isTextual() ? node.textValue() : node.toString();
    }
}`;

  return {
    path: javaPath(model, RAW_JSON_PKG, 'RawJsonDeserializer'),
    content: javaFile(
      subPackage(model, RAW_JSON_PKG),
      [
        'com.fasterxml.jackson.core.JsonParser',
        'com.fasterxml.jackson.databind.DeserializationContext',
        'com.fasterxml.jackson.databind.JsonDeserializer',
        'com.fasterxml.jackson.databind.JsonNode',
        'java.io.IOException'
      ],
      body
    )
  };
}

function renderModule(model) {
  const body = `/**
 * Serializa todo Instant en ISO-8601 UTC con exactamente tres dígitos de
 * fracción de segundo ("2026-07-26T09:21:07.482Z").
 *
 * El formato temporal es contrato: lo fijan las Convenciones de determinación
 * de specs/validation-scenarios.md, y un escenario que compara la forma de un
 * createdAt no puede depender de si el Instant nació de Instant.now() o de una
 * columna TIMESTAMP. appendInstant(3) rellena o trunca hasta los milisegundos.
 *
 * Si el diseño declara otra precisión, se cambia el 3 aquí y en ningún otro
 * sitio: este módulo es el único punto donde el servicio decide el formato.
 */
public class TimestampModule extends SimpleModule {

    private static final DateTimeFormatter ISO_MILLIS = new DateTimeFormatterBuilder()
            .appendInstant(3)
            .toFormatter();

    public TimestampModule() {
        addSerializer(Instant.class, new JsonSerializer<Instant>() {
            @Override
            public void serialize(Instant value, JsonGenerator gen, SerializerProvider serializers)
                    throws IOException {
                gen.writeString(ISO_MILLIS.format(value));
            }
        });
    }
}`;

  return {
    path: javaPath(model, SERIALIZATION_PKG, 'TimestampModule'),
    content: javaFile(
      subPackage(model, SERIALIZATION_PKG),
      [
        'com.fasterxml.jackson.core.JsonGenerator',
        'com.fasterxml.jackson.databind.JsonSerializer',
        'com.fasterxml.jackson.databind.SerializerProvider',
        'com.fasterxml.jackson.databind.module.SimpleModule',
        'java.io.IOException',
        'java.time.Instant',
        'java.time.format.DateTimeFormatter',
        'java.time.format.DateTimeFormatterBuilder'
      ],
      body
    )
  };
}

function renderConfig(model) {
  const body = `/**
 * Instala {@link TimestampModule} en el ObjectMapper de la aplicación.
 *
 * Ese mapper es el que usan las respuestas REST y —por autoconfiguración— el
 * MessageConverter del broker, así que el formato de los instantes es el mismo
 * en el cuerpo de una respuesta y en el payload de un evento de integración.
 *
 * Deliberadamente NO se toca la inclusión de propiedades nulas: "ausencia vs.
 * nulo" es una convención de determinación del diseño y se implementa con
 * @JsonInclude en las clases que la necesiten, no como default global (ver
 * docs/keel/conventions/mapping.md).
 */
@Configuration
public class JacksonConfig {

    @Bean
    public Jackson2ObjectMapperBuilderCustomizer timestampPrecisionCustomizer() {
        return builder -> builder.modulesToInstall(TimestampModule.class);
    }
}`;

  return {
    path: javaPath(model, SERIALIZATION_PKG, 'JacksonConfig'),
    content: javaFile(
      subPackage(model, SERIALIZATION_PKG),
      [
        'org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer',
        'org.springframework.context.annotation.Bean',
        'org.springframework.context.annotation.Configuration'
      ],
      body
    )
  };
}
