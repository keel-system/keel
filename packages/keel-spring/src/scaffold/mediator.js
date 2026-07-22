// Infraestructura del patrón mediator (portada del prototipo de referencia,
// sin paquete shared: keel genera UN microservicio independiente): contratos
// CQRS en application/interfaces, anotaciones propias @ApplicationComponent /
// @DomainComponent (la capa application no importa Spring) registradas por el
// @ComponentScan filtrado de UseCaseConfig, y UseCaseMediator + UseCaseContainer
// + UseCaseAutoRegister en infrastructure/configurations/usecase. La frontera
// TRANSACCIONAL vive en el mediator (Query→readOnly, Command→escritura), no en
// los handlers — esto completa el desacople que el prototipo dejó a medias
// (sus handlers seguían importando @Transactional).

import { javaFile, javaPath, subPackage } from './render.js';

export const INTERFACES_PKG = 'application.interfaces';
export const ANNOTATIONS_PKG = 'application.annotations';
export const MEDIATOR_PKG = 'infrastructure.configurations.usecase';
const CONFIG_PKG = MEDIATOR_PKG;

export function generate(model) {
  if (!model.services.some((service) => service.operations.length > 0)) return [];

  const interfacesPkg = subPackage(model, INTERFACES_PKG);
  const files = [];

  const iface = (name, body, imports = []) => ({
    path: javaPath(model, INTERFACES_PKG, name),
    content: javaFile(interfacesPkg, imports, body)
  });

  files.push(
    iface(
      'Dispatchable',
      `/**
 * Marca los mensajes que puede despachar el UseCaseMediator.
 */
public interface Dispatchable {
}`
    ),
    iface(
      'Handler',
      `/**
 * Marca los handlers registrables en el UseCaseContainer.
 */
public interface Handler {
}`
    ),
    iface(
      'Command',
      `/**
 * Comando sin valor de retorno.
 */
public interface Command extends Dispatchable {
}`
    ),
    iface(
      'Query',
      `/**
 * Consulta que devuelve un resultado de tipo R.
 */
public interface Query<R> extends Dispatchable {
}`
    ),
    iface(
      'ReturningCommand',
      `/**
 * Comando que devuelve un resultado de tipo R.
 */
public interface ReturningCommand<R> extends Dispatchable {
}`
    ),
    iface(
      'CommandHandler',
      `public interface CommandHandler<T extends Command> extends Handler {

    void handle(T command);
}`
    ),
    iface(
      'QueryHandler',
      `public interface QueryHandler<Q extends Query<R>, R> extends Handler {

    R handle(Q query);
}`
    ),
    iface(
      'ReturningCommandHandler',
      `public interface ReturningCommandHandler<C extends ReturningCommand<R>, R> extends Handler {

    R handle(C command);
}`
    )
  );

  files.push(...renderAnnotations(model));
  files.push(renderContainer(model), renderMediator(model), renderAutoRegister(model), renderUseCaseConfig(model));
  return files;
}

// Anotaciones propias: la capa application/dominio se marca sin importar
// Spring; UseCaseConfig las registra como beans con un component-scan filtrado.
function renderAnnotations(model) {
  const annotationImports = [
    'java.lang.annotation.ElementType',
    'java.lang.annotation.Retention',
    'java.lang.annotation.RetentionPolicy',
    'java.lang.annotation.Target'
  ];
  const annotationBody = (name, layer) => `/**
 * Marca un componente de la capa ${layer} sin acoplarlo a anotaciones de
 * Spring; UseCaseConfig lo registra como bean.
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface ${name} {
}`;

  return [
    {
      path: javaPath(model, ANNOTATIONS_PKG, 'ApplicationComponent'),
      content: javaFile(subPackage(model, ANNOTATIONS_PKG), annotationImports, annotationBody('ApplicationComponent', 'application'))
    },
    {
      path: javaPath(model, 'domain.annotations', 'DomainComponent'),
      content: javaFile(subPackage(model, 'domain.annotations'), annotationImports, annotationBody('DomainComponent', 'domain (servicios de dominio)'))
    }
  ];
}

function renderUseCaseConfig(model) {
  const body = `@Configuration
@ComponentScan(
        basePackages = { "${model.service.basePackage}" },
        includeFilters = {
                @ComponentScan.Filter(type = FilterType.ANNOTATION, value = ApplicationComponent.class),
                @ComponentScan.Filter(type = FilterType.ANNOTATION, value = DomainComponent.class)
        })
public class UseCaseConfig {
}`;

  return {
    path: javaPath(model, CONFIG_PKG, 'UseCaseConfig'),
    content: javaFile(
      subPackage(model, CONFIG_PKG),
      [
        `${subPackage(model, ANNOTATIONS_PKG)}.ApplicationComponent`,
        `${subPackage(model, 'domain.annotations')}.DomainComponent`,
        'org.springframework.context.annotation.ComponentScan',
        'org.springframework.context.annotation.Configuration',
        'org.springframework.context.annotation.FilterType'
      ],
      body
    )
  };
}

function renderContainer(model) {
  const body = `/**
 * Registro mensaje → handler que alimenta al UseCaseMediator.
 */
@Component
public class UseCaseContainer {

    private final Map<Class<? extends Dispatchable>, Handler> instances = new HashMap<>();

    public void register(Class<? extends Dispatchable> type, Handler useCase) {
        instances.put(type, useCase);
    }

    public Handler resolve(Class<? extends Dispatchable> type) {
        Handler instance = instances.get(type);
        if (instance == null) {
            throw new IllegalArgumentException("No hay handler registrado para el tipo: " + type.getName());
        }
        return instance;
    }
}`;

  return {
    path: javaPath(model, CONFIG_PKG, 'UseCaseContainer'),
    content: javaFile(
      subPackage(model, CONFIG_PKG),
      [
        `${subPackage(model, INTERFACES_PKG)}.Dispatchable`,
        `${subPackage(model, INTERFACES_PKG)}.Handler`,
        'java.util.HashMap',
        'java.util.Map',
        'org.springframework.stereotype.Component'
      ],
      body
    )
  };
}

function renderMediator(model) {
  const transactional = model.layersPresent.persistence;

  const javadocHeader = `/**
 * Fachada única de despacho de casos de uso: resuelve el handler registrado
 * para la clase del mensaje y lo invoca. Los controllers dependen solo de
 * este componente, no de los handlers concretos.${transactional ? `
 *
 * La frontera transaccional del diseño vive aquí: las Query corren en
 * transacción readOnly y los Command en transacción de escritura, así los
 * handlers no dependen de Spring. Si una operación necesita semántica especial
 * (p. ej. REQUIRES_NEW), el agente puede anotar su handler con @Transactional.` : ''}
 */`;

  let members;
  let dispatchers;
  if (transactional) {
    members = `    private final UseCaseContainer useCaseContainer;
    private final TransactionTemplate writeTransaction;
    private final TransactionTemplate readTransaction;

    public UseCaseMediator(UseCaseContainer useCaseContainer, PlatformTransactionManager transactionManager) {
        this.useCaseContainer = useCaseContainer;
        this.writeTransaction = new TransactionTemplate(transactionManager);
        this.readTransaction = new TransactionTemplate(transactionManager);
        this.readTransaction.setReadOnly(true);
    }`;
    dispatchers = `    @SuppressWarnings("unchecked")
    public <R, Q extends Query<R>> R dispatch(Q query) {
        QueryHandler<Q, R> instance = (QueryHandler<Q, R>) useCaseContainer.resolve(query.getClass());
        return readTransaction.execute(status -> instance.handle(query));
    }

    @SuppressWarnings("unchecked")
    public <C extends Command> void dispatch(C command) {
        CommandHandler<C> instance = (CommandHandler<C>) useCaseContainer.resolve(command.getClass());
        writeTransaction.executeWithoutResult(status -> instance.handle(command));
    }

    @SuppressWarnings("unchecked")
    public <R, C extends ReturningCommand<R>> R dispatch(C command) {
        ReturningCommandHandler<C, R> instance = (ReturningCommandHandler<C, R>) useCaseContainer.resolve(command.getClass());
        return writeTransaction.execute(status -> instance.handle(command));
    }`;
  } else {
    members = `    private final UseCaseContainer useCaseContainer;

    public UseCaseMediator(UseCaseContainer useCaseContainer) {
        this.useCaseContainer = useCaseContainer;
    }`;
    dispatchers = `    @SuppressWarnings("unchecked")
    public <R, Q extends Query<R>> R dispatch(Q query) {
        QueryHandler<Q, R> instance = (QueryHandler<Q, R>) useCaseContainer.resolve(query.getClass());
        return instance.handle(query);
    }

    @SuppressWarnings("unchecked")
    public <C extends Command> void dispatch(C command) {
        CommandHandler<C> instance = (CommandHandler<C>) useCaseContainer.resolve(command.getClass());
        instance.handle(command);
    }

    @SuppressWarnings("unchecked")
    public <R, C extends ReturningCommand<R>> R dispatch(C command) {
        ReturningCommandHandler<C, R> instance = (ReturningCommandHandler<C, R>) useCaseContainer.resolve(command.getClass());
        return instance.handle(command);
    }`;
  }

  const body = `${javadocHeader}
@Component
public class UseCaseMediator {

${members}

${dispatchers}
}`;

  const interfacesPkg = subPackage(model, INTERFACES_PKG);
  const imports = [
    `${interfacesPkg}.Command`,
    `${interfacesPkg}.CommandHandler`,
    `${interfacesPkg}.Query`,
    `${interfacesPkg}.QueryHandler`,
    `${interfacesPkg}.ReturningCommand`,
    `${interfacesPkg}.ReturningCommandHandler`,
    'org.springframework.stereotype.Component'
  ];
  if (transactional) {
    imports.push('org.springframework.transaction.PlatformTransactionManager', 'org.springframework.transaction.support.TransactionTemplate');
  }

  return {
    path: javaPath(model, CONFIG_PKG, 'UseCaseMediator'),
    content: javaFile(subPackage(model, CONFIG_PKG), imports, body)
  };
}

function renderAutoRegister(model) {
  const body = `/**
 * Al arrancar, descubre los handlers del contexto Spring y los registra en el
 * UseCaseContainer, deduciendo por reflexión el tipo de mensaje que maneja
 * cada uno.
 */
@Component
public class UseCaseAutoRegister implements CommandLineRunner {

    private final UseCaseContainer useCaseContainer;
    private final ApplicationContext applicationContext;

    public UseCaseAutoRegister(UseCaseContainer useCaseContainer, ApplicationContext applicationContext) {
        this.useCaseContainer = useCaseContainer;
        this.applicationContext = applicationContext;
    }

    @Override
    @SuppressWarnings("rawtypes")
    public void run(String... args) {
        Map<String, CommandHandler> commandHandlers = applicationContext.getBeansOfType(CommandHandler.class);
        commandHandlers.values().forEach(handler -> useCaseContainer.register(getGenericType(handler.getClass()), handler));

        Map<String, QueryHandler> queryHandlers = applicationContext.getBeansOfType(QueryHandler.class);
        queryHandlers.values().forEach(handler -> useCaseContainer.register(getGenericType(handler.getClass()), handler));

        Map<String, ReturningCommandHandler> returningCommandHandlers = applicationContext.getBeansOfType(ReturningCommandHandler.class);
        returningCommandHandlers.values().forEach(handler -> useCaseContainer.register(getGenericType(handler.getClass()), handler));
    }

    @SuppressWarnings("unchecked")
    private Class<Dispatchable> getGenericType(Class<?> handlerClass) {
        Class<?> currentClass = handlerClass;
        while (currentClass != null) {
            for (Type genericInterface : currentClass.getGenericInterfaces()) {
                if (genericInterface instanceof ParameterizedType parameterizedType
                        && parameterizedType.getRawType() instanceof Class<?> interfaceClass
                        && Handler.class.isAssignableFrom(interfaceClass)) {
                    return (Class<Dispatchable>) parameterizedType.getActualTypeArguments()[0];
                }
            }
            currentClass = currentClass.getSuperclass();
        }
        throw new IllegalArgumentException("No se puede deducir el tipo de mensaje del handler: " + handlerClass.getName());
    }
}`;

  const interfacesPkg = subPackage(model, INTERFACES_PKG);
  return {
    path: javaPath(model, CONFIG_PKG, 'UseCaseAutoRegister'),
    content: javaFile(
      subPackage(model, CONFIG_PKG),
      [
        `${interfacesPkg}.CommandHandler`,
        `${interfacesPkg}.Dispatchable`,
        `${interfacesPkg}.Handler`,
        `${interfacesPkg}.QueryHandler`,
        `${interfacesPkg}.ReturningCommandHandler`,
        'java.lang.reflect.ParameterizedType',
        'java.lang.reflect.Type',
        'java.util.Map',
        'org.springframework.boot.CommandLineRunner',
        'org.springframework.context.ApplicationContext',
        'org.springframework.stereotype.Component'
      ],
      body
    )
  };
}
