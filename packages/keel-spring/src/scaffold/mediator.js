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
  files.push(...renderCommandDispatcher(model));
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

// El cuarto camino de despacho, y el único que no abre transacción. Se emite SIEMPRE
// —también sin capa persistence, donde es idéntico a dispatch(Command)— para que el
// scheduler pueda llamarlo sin preguntar por la capa: quién lo usa lo decide el DSL
// (una operación con `schedule` que reconcilia una activación saliente), no el stack.
//
// Existe porque la garantía del barrido es un ORDEN de commits, no una transacción:
// reclamar y confirmar, llamar fuera de toda transacción, confirmar el desenlace. Con
// el handle() envuelto en una sola transacción de escritura, el reclamo no confirma
// hasta el final del lote —así que no aísla a ninguna réplica— y la llamada al
// proveedor retiene una conexión del pool por la latencia de un tercero. Ver
// conventions/dependencies.md § El orden dentro del barrido.
const DISPATCH_WITHOUT_TRANSACTION = `    /**
     * Despacha un Command <b>sin abrir transacción</b>: las abre el adaptador de repositorio
     * en cada llamada, así que el barrido controla dónde cae cada commit.
     *
     * <p>Es para las operaciones con {@code schedule} que ACTÚAN sobre lo que encuentran —un
     * barrido de reconciliación—, donde la llamada al proveedor va EN MEDIO del trabajo. Su
     * garantía es un orden de commits: (1) reclamar los candidatos y confirmar, que es lo que
     * hace el reclamo visible a las demás réplicas; (2) llamar al proveedor, fuera de toda
     * transacción; (3) confirmar el desenlace. Una transacción abarcadora rompe (1) —el
     * reclamo no confirmaría hasta el final del lote— y rompe (2) —una conexión del pool
     * retenida por la latencia de un tercero, multiplicada por el tamaño del lote—.
     *
     * <p>Las demás operaciones con {@code schedule} (una purga, un cierre diario) NO usan este
     * camino: no llaman a nadie en medio y su transacción única es lo correcto.
     *
     * <p>Mismo razonamiento que el {@code OutboxRelay} de la rama documental, que tampoco es
     * {@code @Transactional}: abrir una transacción solo serviría para mantenerla abierta
     * durante I/O externo.
     *
     * <p>Ver docs/keel/conventions/dependencies.md § El orden dentro del barrido.
     */
    @SuppressWarnings("unchecked")
    public <C extends Command> void dispatchWithoutTransaction(C command) {
        CommandHandler<C> instance = (CommandHandler<C>) useCaseContainer.resolve(command.getClass());
        instance.handle(command);
    }

    /** Igual que el anterior, para un barrido cuya operación declara \`output\`. */
    @SuppressWarnings("unchecked")
    public <R, C extends ReturningCommand<R>> R dispatchWithoutTransaction(C command) {
        ReturningCommandHandler<C, R> instance = (ReturningCommandHandler<C, R>) useCaseContainer.resolve(command.getClass());
        return instance.handle(command);
    }`;

function renderMediator(model) {
  const transactional = model.layersPresent.persistence;

  const javadocHeader = `/**
 * Fachada única de despacho de casos de uso: resuelve el handler registrado
 * para la clase del mensaje y lo invoca. Los controllers dependen solo de
 * este componente, no de los handlers concretos.${transactional ? `
 *
 * La frontera transaccional del diseño vive aquí: las Query corren en
 * transacción readOnly y los Command en transacción de escritura, así los
 * handlers no dependen de Spring.
 *
 * <p>Con una excepción, {@link #dispatchWithoutTransaction}: los barridos que
 * llaman a un proveedor EN MEDIO de su trabajo no pueden correr bajo una
 * transacción abarcadora. Su javadoc explica por qué.
 *
 * <p>Si una operación necesita semántica transaccional especial, se resuelve en
 * el ADAPTADOR de repositorio, que sí vive en infraestructura y puede hablar con
 * Spring. El handler no: no importa Spring (constitution.md).` : ''}
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
    }

${DISPATCH_WITHOUT_TRANSACTION}`;
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
    }

${DISPATCH_WITHOUT_TRANSACTION}`;
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

const PORT_PKG = 'application.port.out';

/**
 * Las operaciones internas a las que no llega ningún disparador generado.
 *
 * No tienen `schedule`, el schema les prohíbe endpoint y ninguna suscripción las
 * dispara: la única forma de que se ejecuten es que OTRO handler las invoque. Y un
 * handler no puede llamar a otro handler (constitution.md), así que ese enlace necesita
 * un puerto — que build no generaba, y que por tanto se inventaba el agente.
 */
function orphanInternalOperations(model) {
  const bySubscription = new Set((model.subscriptions ?? []).map((subscription) => subscription.trigger).filter(Boolean));
  return (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .filter((operation) => operation.internal && !operation.schedule && !bySubscription.has(operation.name));
}

/**
 * El puerto de despacho entre casos de uso, y su adaptador sobre el mediator.
 *
 * Se genera —y no se deja al agente— por lo que pasó cuando no existía: el agente lo
 * escribió con UN solo método, el transaccional, porque es el que necesitaba para
 * compilar. Con eso, la operación invocada corre SIEMPRE dentro de la transacción del
 * llamante, y si produce un efecto externo irreversible (un correo) la única salida
 * —sacarla de esa transacción— exigía ampliar un puerto que él mismo acababa de
 * escribir: nadie hace eso a mitad de un handler. El camino de menor resistencia era
 * dejar el envío dentro de la transacción, y ahí está el segundo correo.
 *
 * Build no infiere QUIÉN llama a quién —adivinarlo sacaría de su transacción a barridos
 * que sí la necesitan— pero sí sabe que ALGUIEN tiene que llamar, que es lo único que
 * hace falta para dar las dos variantes y decir cuándo va cada una.
 */
function renderCommandDispatcher(model) {
  const orphans = orphanInternalOperations(model);
  if (orphans.length === 0) return [];

  const interfacesPkg = subPackage(model, INTERFACES_PKG);
  const names = orphans.map((operation) => operation.name).join(', ');
  const irreversible = orphans.filter((operation) => operation.guardClaim);

  const portBody = `/**
 * Puerto de despacho de OTRO caso de uso desde un handler. Un handler nunca invoca a
 * otro handler directamente (constitution.md); cuando lo necesita, despacha su mensaje
 * por este puerto, que implementa un adaptador de infraestructura sobre el
 * {@code UseCaseMediator}.
 *
 * <p>Existe porque el diseño declara ${orphans.length === 1 ? 'una operación interna' : 'operaciones internas'}
 * sin disparador propio (${names}): no ${orphans.length === 1 ? 'tiene' : 'tienen'} ni {@code schedule}, ni
 * endpoint, ni suscripción, así que ${orphans.length === 1 ? 'solo puede ejecutarla' : 'solo pueden ejecutarlas'}
 * otro caso de uso.
 *
 * <p><b>Las dos variantes no son intercambiables</b>, y elegir la primera «porque es la
 * de siempre» tiene consecuencias que no se ven hasta producción:
 *
 * <ul>
 *   <li>{@code dispatch}: la operación invocada se une a la transacción del llamante.
 *       Es lo correcto cuando todo el trabajo es de base de datos y quieres que sea
 *       atómico con el del llamante.</li>
 *   <li>{@code dispatchWithoutTransaction}: la operación invocada abre sus propias
 *       transacciones, una por llamada al adaptador. Es lo correcto cuando hace <b>I/O
 *       externo</b> —un correo, una llamada a un proveedor—: bajo la transacción del
 *       llamante, una tanda de N elementos retiene una conexión del pool durante N
 *       latencias de un tercero, y ningún estado intermedio existe para las demás
 *       réplicas hasta que la tanda entera confirma.</li>
 * </ul>${
   irreversible.length > 0
     ? `
 *
 * <p>Aquí ${irreversible.length === 1 ? 'la hay' : 'las hay'}: ${irreversible
         .map((operation) => operation.name)
         .join(', ')} produce${irreversible.length === 1 ? '' : 'n'} un efecto que no se deshace.
 * Su guarda contra la repetición es un reclamo con transacción propia
 * (${irreversible.map((operation) => `${operation.guardClaim.method}()`).join(', ')}), así que
 * está a salvo con cualquiera de las dos — pero el argumento del pool sigue en pie.`
     : ''
 }
 */
public interface CommandDispatcher {

    /** Despacha un Command dentro de la transacción del llamante. */
    void dispatch(Command command);

    /** Igual, para una operación que declara {@code output}. */
    <R> R dispatch(ReturningCommand<R> command);

    /** Despacha un Command <b>sin transacción abarcadora</b>: los commits los coloca el invocado. */
    void dispatchWithoutTransaction(Command command);

    /** Igual que el anterior, para una operación que declara {@code output}. */
    <R> R dispatchWithoutTransaction(ReturningCommand<R> command);
}`;

  const adapterBody = `/**
 * Adaptador del puerto {@link CommandDispatcher} sobre el {@link UseCaseMediator}. Vive
 * en infraestructura porque es aquí donde se conoce el mediator; la capa application
 * solo ve el puerto.
 */
@Component
public class CommandDispatcherAdapter implements CommandDispatcher {

    private final UseCaseMediator mediator;

    public CommandDispatcherAdapter(UseCaseMediator mediator) {
        this.mediator = mediator;
    }

    @Override
    public void dispatch(Command command) {
        mediator.dispatch(command);
    }

    @Override
    public <R> R dispatch(ReturningCommand<R> command) {
        return mediator.dispatch(command);
    }

    @Override
    public void dispatchWithoutTransaction(Command command) {
        mediator.dispatchWithoutTransaction(command);
    }

    @Override
    public <R> R dispatchWithoutTransaction(ReturningCommand<R> command) {
        return mediator.dispatchWithoutTransaction(command);
    }
}`;

  return [
    {
      path: javaPath(model, PORT_PKG, 'CommandDispatcher'),
      content: javaFile(subPackage(model, PORT_PKG), [`${interfacesPkg}.Command`, `${interfacesPkg}.ReturningCommand`], portBody)
    },
    {
      path: javaPath(model, MEDIATOR_PKG, 'CommandDispatcherAdapter'),
      content: javaFile(
        subPackage(model, MEDIATOR_PKG),
        [
          `${subPackage(model, PORT_PKG)}.CommandDispatcher`,
          `${interfacesPkg}.Command`,
          `${interfacesPkg}.ReturningCommand`,
          'org.springframework.stereotype.Component'
        ],
        adapterBody
      )
    }
  ];
}
