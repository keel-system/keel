// @LogExceptions implementada DE VERDAD (el prototipo dejó la anotación sin
// aspecto): anotación + LogLevel en application/annotations y el @Aspect en
// infrastructure/configurations/logging. Loguea la excepción con el nivel
// declarado y la relanza; los handlers generados la llevan sobre handle(...).

import { javaFile, javaPath, subPackage } from './render.js';
import { ANNOTATIONS_PKG } from './mediator.js';

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
  const body = `@Aspect
@Component
public class LogExceptionsAspect {

    private static final Logger log = LoggerFactory.getLogger(LogExceptionsAspect.class);

    @Around("@annotation(logExceptions)")
    public Object logExceptions(ProceedingJoinPoint joinPoint, LogExceptions logExceptions) throws Throwable {
        try {
            return joinPoint.proceed();
        } catch (Throwable exception) {
            String method = joinPoint.getSignature().toShortString();
            switch (logExceptions.level()) {
                case TRACE -> log.trace("Excepción en {}: {}", method, exception.getMessage(), exception);
                case DEBUG -> log.debug("Excepción en {}: {}", method, exception.getMessage(), exception);
                case INFO -> log.info("Excepción en {}: {}", method, exception.getMessage(), exception);
                case WARN -> log.warn("Excepción en {}: {}", method, exception.getMessage(), exception);
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
        'org.springframework.stereotype.Component'
      ],
      body
    )
  };
}
