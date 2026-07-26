// Binding y serialización HTTP transversales al stack:
//
//  - Conversión de enums en @RequestParam/@PathVariable. Los enums de domain
//    preservan el literal del diseño con @JsonValue, pero @JsonValue solo lo usa
//    Jackson (el cuerpo JSON): el ConversionService de Spring hace
//    Enum.valueOf(name()), así que ?status=active se rechaza con 400 cuando la
//    constante es ACTIVE. El ConverterFactory de aquí cierra esa asimetría.
//  - Tri-estado de las actualizaciones parciales (PATCH): módulo de Jackson que
//    (de)serializa JsonNullable<T> y value extractor para que Bean Validation
//    siga viendo el valor envuelto.

import { javaFile, javaPath, subPackage } from './render.js';
import { usesPartialUpdate } from './services.js';

const WEB_PKG = 'infrastructure.web';
const CONFIG_PKG = 'infrastructure.configurations';

export function generate(model) {
  const files = [];
  const hasEnums = model.enums.length > 0;
  const partial = usesPartialUpdate(model);
  if (!hasEnums && !partial) return files;

  if (hasEnums) files.push(renderEnumConverterFactory(model));
  if (partial) {
    files.push(renderValueExtractor(model));
    files.push(renderValueExtractorService(model));
  }
  files.push(renderWebConfig(model, { hasEnums, partial }));
  return files;
}

// ConverterFactory genérico: sirve a todo enum del dominio sin generar una clase
// por enum. Resuelve por el accesor @JsonValue (el literal del contrato) y, como
// red de seguridad, por el nombre de la constante sin distinguir mayúsculas.
function renderEnumConverterFactory(model) {
  const body = `/**
 * Convierte el literal del contrato (@JsonValue) al enum de dominio en los
 * parámetros de query y de ruta, igual que hace Jackson con el cuerpo JSON.
 */
public class JsonValueEnumConverterFactory implements ConverterFactory<String, Enum> {

    @Override
    public <T extends Enum> Converter<String, T> getConverter(Class<T> targetType) {
        return new JsonValueEnumConverter<>(targetType);
    }

    private static final class JsonValueEnumConverter<T extends Enum> implements Converter<String, T> {

        private final Class<T> enumType;
        private final Method jsonValueAccessor;

        private JsonValueEnumConverter(Class<T> enumType) {
            this.enumType = enumType;
            this.jsonValueAccessor = findJsonValueAccessor(enumType);
        }

        @Override
        public T convert(String source) {
            String value = source.trim();
            if (value.isEmpty()) {
                return null;
            }
            for (T constant : enumType.getEnumConstants()) {
                if (value.equals(literalOf(constant)) || value.equalsIgnoreCase(constant.name())) {
                    return constant;
                }
            }
            throw new IllegalArgumentException(
                    "Valor no admitido para " + enumType.getSimpleName() + ": " + source);
        }

        private String literalOf(T constant) {
            if (jsonValueAccessor == null) {
                return constant.name();
            }
            try {
                Object literal = jsonValueAccessor.invoke(constant);
                return literal != null ? literal.toString() : null;
            } catch (ReflectiveOperationException exception) {
                return constant.name();
            }
        }

        private static Method findJsonValueAccessor(Class<?> enumType) {
            for (Method method : enumType.getMethods()) {
                if (method.getParameterCount() == 0 && method.isAnnotationPresent(JsonValue.class)) {
                    method.setAccessible(true);
                    return method;
                }
            }
            return null;
        }
    }
}`;

  return {
    path: javaPath(model, WEB_PKG, 'JsonValueEnumConverterFactory'),
    content: javaFile(
      subPackage(model, WEB_PKG),
      [
        'com.fasterxml.jackson.annotation.JsonValue',
        'java.lang.reflect.Method',
        'org.springframework.core.convert.converter.Converter',
        'org.springframework.core.convert.converter.ConverterFactory'
      ],
      body
    )
  };
}

// Sin este extractor, una constraint declarada sobre un campo JsonNullable<T>
// (@Size, @Pattern…) no se evalúa nunca: Bean Validation ve el envoltorio.
function renderValueExtractor(model) {
  const body = `/**
 * Deja que Bean Validation valide el valor envuelto en JsonNullable, no el
 * envoltorio. Se descubre por ServiceLoader
 * (META-INF/services/jakarta.validation.valueextraction.ValueExtractor).
 */
public class JsonNullableValueExtractor implements ValueExtractor<JsonNullable<@ExtractedValue ?>> {

    @Override
    public void extractValues(JsonNullable<?> originalValue, ValueReceiver receiver) {
        if (originalValue != null && originalValue.isPresent()) {
            receiver.value(null, originalValue.get());
        }
    }
}`;

  return {
    path: javaPath(model, WEB_PKG, 'JsonNullableValueExtractor'),
    content: javaFile(
      subPackage(model, WEB_PKG),
      [
        'jakarta.validation.valueextraction.ExtractedValue',
        'jakarta.validation.valueextraction.ValueExtractor',
        'org.openapitools.jackson.nullable.JsonNullable'
      ],
      body
    )
  };
}

function renderValueExtractorService(model) {
  return {
    path: 'src/main/resources/META-INF/services/jakarta.validation.valueextraction.ValueExtractor',
    content: `${subPackage(model, WEB_PKG)}.JsonNullableValueExtractor\n`
  };
}

function renderWebConfig(model, { hasEnums, partial }) {
  const imports = ['org.springframework.context.annotation.Configuration'];
  const declarations = [];

  let classDeclaration = 'public class WebConfig {';
  if (hasEnums) {
    imports.push(
      'org.springframework.format.FormatterRegistry',
      'org.springframework.web.servlet.config.annotation.WebMvcConfigurer',
      `${subPackage(model, WEB_PKG)}.JsonValueEnumConverterFactory`
    );
    classDeclaration = 'public class WebConfig implements WebMvcConfigurer {';
    declarations.push(`
    @Override
    public void addFormatters(FormatterRegistry registry) {
        registry.addConverterFactory(new JsonValueEnumConverterFactory());
    }`);
  }
  if (partial) {
    imports.push(
      'org.springframework.context.annotation.Bean',
      'org.openapitools.jackson.nullable.JsonNullableModule'
    );
    declarations.push(`
    /**
     * (De)serialización de JsonNullable: un campo ausente queda undefined y un
     * null explícito queda presente con valor null, que es la distinción que
     * exige el contrato de las actualizaciones parciales.
     */
    @Bean
    public JsonNullableModule jsonNullableModule() {
        return new JsonNullableModule();
    }`);
  }

  const body = `/**
 * Configuración de binding y serialización HTTP del servicio.
 */
@Configuration
${classDeclaration}
${declarations.join('\n')}
}`;

  return {
    path: javaPath(model, CONFIG_PKG, 'WebConfig'),
    content: javaFile(subPackage(model, CONFIG_PKG), imports, body)
  };
}
