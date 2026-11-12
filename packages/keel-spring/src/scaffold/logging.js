// @LogExceptions implementada DE VERDAD (el prototipo dejó la anotación sin
// aspecto): anotación + LogLevel en application/annotations y el @Aspect en
// infrastructure/configurations/logging. Loguea la excepción con el nivel
// declarado y la relanza; los handlers generados la llevan sobre handle(...).

import { javaFile, javaPath, subPackage } from './render.js';
import { ANNOTATIONS_PKG } from './mediator.js';
import { usesPersonalData } from '@keel-system/keel-core/gen/personal-data';

const LOGGING_PKG = 'infrastructure.configurations.logging';

export function generate(model) {
  if (!model.services.some((service) => service.operations.length > 0)) return [];

  const annotationsPkg = subPackage(model, ANNOTATIONS_PKG);
  return [
    {
      path: javaPath(model, ANNOTATIONS_PKG, 'LogLevel'),
      content: javaFile(
        annotationsPkg,
        [],
        `public enum LogLevel {
    TRACE,
    DEBUG,
    INFO,
    WARN
}`
      )
    },
    {
      path: javaPath(model, ANNOTATIONS_PKG, 'LogExceptions'),
      content: javaFile(
        annotationsPkg,
        [
          'java.lang.annotation.ElementType',
          'java.lang.annotation.Retention',
          'java.lang.annotation.RetentionPolicy',
          'java.lang.annotation.Target'
        ],
        `/**
 * Loguea (y relanza) cualquier excepción del método anotado con el nivel
 * indicado; la implementa LogExceptionsAspect.
 */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface LogExceptions {

    LogLevel level() default LogLevel.WARN;
}`
      )
    },
    renderAspect(model)
  ];
}

function renderAspect(model) {
  const annotationsPkg = subPackage(model, ANNOTATIONS_PKG);
  // Con datos personales (DSL 2.28, D10) el mensaje de una excepción de acceso a datos NO sale: lleva el texto del motor,
  // y el de una unicidad violada lleva el valor (`Key (email)=(ana@x.com) already exists`, PD-2).
  const personal = usesPersonalData(model);
  const detail = personal ? 'detail' : 'exception.getMessage()';
  const body = `/**
 * OJO con el sitio donde se captura la firma: va ANTES del proceed(), no dentro del catch.
 *
 * getSignature() carga MethodInvocationProceedingJoinPoint$MethodSignatureImpl la primera vez
 * que se llama. Dentro del catch esa primera vez es la primera EXCEPCIÓN que el aspecto captura,
 * y si cae durante el apagado el LaunchedURLClassLoader ya cerró los jars anidados: el logging
 * del error muere con un NoClassDefFoundError y se lleva por delante justo el diagnóstico que se
 * estaba escribiendo. Sacarla fuera la carga en la primera invocación normal y cierra la ventana.
 *
 * Esto es una MITIGACIÓN DE UNA HIPÓTESIS, no un fallo reproducido. Lo observado: un solo
 * NoClassDefFoundError de esa clase, durante el apagado, en una corrida. Lo descartado: el
 * empaquetado (la clase está en el spring-aop anidado del fat jar y solo hay un spring-aop) y el
 * drenaje de las tareas @Scheduled (SchedulingConfig ya espera a que terminen). Lo que no se ha
 * podido reproducir: el fallo en sí, así que ningún escenario lo ve y ninguna mutación lo mide.
 */
@Aspect
@Component
public class LogExceptionsAspect {

    private static final Logger log = LoggerFactory.getLogger(LogExceptionsAspect.class);

    @Around("@annotation(logExceptions)")
    public Object logExceptions(ProceedingJoinPoint joinPoint, LogExceptions logExceptions) throws Throwable {
        String method = joinPoint.getSignature().toShortString();
        try {
            return joinPoint.proceed();
        } catch (Throwable exception) {${personal ? `
            // El detalle del motor puede llevar el valor de un campo personal (DSL 2.28): de una excepción de acceso a
            // datos solo sale su clase. La traduce después el ApiExceptionHandler, que no lo loguea.
            String detail = exception instanceof DataAccessException
                    ? "(detalle del motor omitido: puede llevar datos personales)"
                    : exception.getMessage();` : ''}
            switch (logExceptions.level()) {
                // Sin la pila, a propósito: la imprime UNA vez el adaptador por el que entró el
                // fallo (ApiExceptionHandler, el contenedor del listener, el scheduler). Con ella
                // aquí cada fallo salía con dos pilas idénticas en el mismo log.
                case TRACE -> log.trace("Excepción en {}: {} ({})", method, ${detail}, exception.getClass().getSimpleName());
                case DEBUG -> log.debug("Excepción en {}: {} ({})", method, ${detail}, exception.getClass().getSimpleName());
                case INFO -> log.info("Excepción en {}: {} ({})", method, ${detail}, exception.getClass().getSimpleName());
                case WARN -> log.warn("Excepción en {}: {} ({})", method, ${detail}, exception.getClass().getSimpleName());
            }
            throw exception;
        }
    }
}`;

  return {
    path: javaPath(model, LOGGING_PKG, 'LogExceptionsAspect'),
    content: javaFile(
      subPackage(model, LOGGING_PKG),
      [
        `${annotationsPkg}.LogExceptions`,
        'org.aspectj.lang.ProceedingJoinPoint',
        'org.aspectj.lang.annotation.Around',
        'org.aspectj.lang.annotation.Aspect',
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory',
        'org.springframework.stereotype.Component',
        ...(personal ? ['org.springframework.dao.DataAccessException'] : [])
      ],
      body
    )
  };
}
