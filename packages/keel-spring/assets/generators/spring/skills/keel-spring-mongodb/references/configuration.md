# Configuración de MongoDB

Todo lo de aquí vive en `parameters/<perfil>/db.yaml` (fragmentos por perfil), nunca
quemado en el código. Build ya dejó lo imprescindible; esto es para cuando un
escenario concreto pida más.

## La URI y por qué es distinta en cada perfil

```yaml
spring:
  data:
    mongodb:
      uri: mongodb://<db>:changeme@localhost:27017/<db>?authSource=admin&directConnection=true&uuidRepresentation=standard
      auto-index-creation: false
```

Tres parámetros de la URI no son decorativos:

| Parámetro | Por qué |
|---|---|
| `directConnection=true` | Solo en `local`. La app corre en el **host** y el miembro del replica set se anuncia como `db:27017` (el nombre dentro de la red de compose), que el host no resuelve. Con conexión directa el driver no descubre la topología y habla con el miembro al que ya está conectado. Las transacciones siguen funcionando: lo que exigen es que el **servidor** sea miembro de un replica set, no que el driver conozca el conjunto. |
| `replicaSet=rs0` | En `develop`/`deploy`, donde la app corre **dentro** de la red y sí resuelve `db`. Ahí conviene el conjunto completo: el driver reconecta solo tras un failover. |
| `uuidRepresentation=standard` | Sin esto el driver escribe los UUID en la representación *legacy* (subtipo 3, con los bytes permutados). Los documentos siguen funcionando desde la app, pero el mismo id se ve distinto desde `mongosh` o desde cualquier otro cliente — y quien depure un escenario perseguirá un fantasma. |

`auto-index-creation: false` está apagado a propósito: los índices los crea
`MongoIndexConfig` (ver `indexes.md`). No lo enciendas.

## Pool del driver

El driver de Mongo trae su propio pool; no hay Hikari aquí. Se ajusta por URI:

```
?maxPoolSize=100&minPoolSize=0&maxIdleTimeMS=60000&waitQueueTimeoutMS=5000
```

`maxPoolSize` por defecto es 100, que suele sobrar. Solo súbelo con evidencia:
saturación del pool aparece como `MongoTimeoutException` esperando conexión, no
como lentitud general.

## Write concern y read concern

Los valores por defecto (`w: majority` en un replica set, `readConcern: local`) son
los correctos para este servicio y **no** hay que tocarlos sin un motivo escrito.

- Bajar a `w: 1` gana latencia a cambio de que un failover pueda perder la última
  escritura confirmada. Con outbox eso significa perder un evento que el servicio ya
  dio por publicado.
- `readConcern: majority` solo hace falta si una lectura no puede ver datos que
  podrían revertirse. Dentro de una transacción ya está garantizado.

Se fijan por bean, no por propiedad:

```java
@Bean
public MongoClientSettingsBuilderCustomizer concerns() {
    return builder -> builder
            .writeConcern(WriteConcern.MAJORITY.withJournal(true))
            .readConcern(ReadConcern.MAJORITY);
}
```

## Lo que NO se configura aquí

- **Índices** → `MongoIndexConfig`, generado. Ver `indexes.md`.
- **Transacciones** → `MongoTransactionConfig`, generado. Ver `transactions.md`.
- **Perfil `test`** → flapdoodle, y arranca *standalone*: ahí no hay transacciones
  reales y el gestor es un no-op. No lo uses para probar atomicidad.
