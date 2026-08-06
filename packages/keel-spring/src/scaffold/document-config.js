// Transaccionalidad del modelo documental.
//
// Spring Boot NO autoconfigura un gestor de transacciones con
// spring-boot-starter-data-mongodb, y este proyecto lo necesita por dos motivos
// distintos, cada uno suficiente por sí solo:
//
//  1. El UseCaseMediator abre cada caso de uso con un TransactionTemplate, que exige
//     un PlatformTransactionManager en el contexto. Sin bean, el contexto no
//     arranca — no es una degradación silenciosa, es un fallo al levantar.
//  2. Con reliability: outbox, el documento del agregado y su outbox_event tienen
//     que entrar en el mismo commit. Esa atomicidad es la razón por la que la
//     infraestructura arranca como replica set incluso en local: las transacciones
//     multi-documento de Mongo solo existen sobre uno.
//
// El perfil `test` es la excepción, y por eso hay dos beans: ahí la base es
// flapdoodle embebido, que arranca STANDALONE. Un MongoTransactionManager real
// fallaría en la primera operación transaccional ("Transaction numbers are only
// allowed on a replica set member"). Ese perfil existe solo para que el contexto
// cargue (contextLoads); montar flapdoodle como replica set sería complejidad sin
// contrapartida, así que ahí se registra un gestor que no hace nada.

import { javaFile, javaPath, subPackage } from './render.js';

const CONFIG_PKG = 'infrastructure.persistence.config';

export function generate(model) {
  if (!model.layersPresent.persistence || model.persistenceKind !== 'document') return [];
  return [renderTransactionConfig(model)];
}

function renderTransactionConfig(model) {
  const imports = [
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.context.annotation.Profile',
    'org.springframework.data.mongodb.MongoDatabaseFactory',
    'org.springframework.data.mongodb.MongoTransactionManager',
    'org.springframework.transaction.PlatformTransactionManager',
    'org.springframework.transaction.TransactionDefinition',
    'org.springframework.transaction.TransactionStatus',
    'org.springframework.transaction.support.SimpleTransactionStatus'
  ];

  const body = `/**
 * Gestor de transacciones de MongoDB. Ver la cabecera de document-config.js del
 * generador para el porqué de los dos beans.
 */
@Configuration
public class MongoTransactionConfig {

    /**
     * Transacciones reales sobre el replica set. Es lo que hace que el guardado del
     * agregado y la escritura en outbox_event sean un solo commit.
     */
    @Bean
    @Profile("!test")
    public PlatformTransactionManager mongoTransactionManager(MongoDatabaseFactory databaseFactory) {
        return new MongoTransactionManager(databaseFactory);
    }

    /**
     * Perfil test: flapdoodle arranca standalone y no admite transacciones. Este
     * gestor las acepta y no hace nada, que es exactamente lo que necesita un
     * contextLoads(). NO uses este perfil para probar atomicidad: lo que aquí
     * "funciona" es que nadie abre transacción de verdad.
     */
    @Bean
    @Profile("test")
    public PlatformTransactionManager noopTransactionManager() {
        return new PlatformTransactionManager() {
            @Override
            public TransactionStatus getTransaction(TransactionDefinition definition) {
                return new SimpleTransactionStatus();
            }

            @Override
            public void commit(TransactionStatus status) {
                // Sin transacción real que confirmar.
            }

            @Override
            public void rollback(TransactionStatus status) {
                // Sin transacción real que deshacer.
            }
        };
    }
}`;

  return {
    path: javaPath(model, CONFIG_PKG, 'MongoTransactionConfig'),
    content: javaFile(subPackage(model, CONFIG_PKG), imports, body)
  };
}
