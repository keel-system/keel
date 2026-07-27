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
  return [renderModule(model), renderConfig(model)];
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
 * .claude/conventions/mapping.md).
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
