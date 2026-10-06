# Reglas inviolables

Estas reglas no se negocian ni se "acomodan" para que un caso particular compile o pase un test. Si
algo del diseño o de un escenario obliga a romper una de ellas, **no la rompas**: repórtalo como
bloqueo o como hueco del diseño (ver "Ante ambigüedad" al final).

## Fuente de verdad

- El diseño (`specs/*.keel.yaml` + `specs/validation-scenarios.md`) es la única fuente de verdad
  funcional. Nada de entidades, campos, endpoints, roles o reglas que no estén en sus artefactos.
- Los `code` de error y los nombres de evento se copian **exactos**: son contrato público.
- Una contradicción entre artefactos o un caso borde sin `error` declarado no se resuelve en silencio
  en el código: es un defecto del diseño y se reporta.
- **El servidor es equivalente al de keel-spring del mismo diseño.** Lo que el contrato fija (rutas,
  status, cuerpo de error, paginación, forma del JSON, nombres de constraint) no se cambia aquí: lo
  decide el núcleo neutral de Keel y lo emite build.

## Idioma

- Todo lo que se genera va **en inglés**: directorios, archivos, clases, métodos, variables, tablas y
  columnas. Los comentarios, la documentación y los mensajes al usuario van en español.
- Un identificador del diseño en español no se traduce por tu cuenta: es un defecto del diseño.

## Frontera hexagonal

- `src/domain` no importa ni `src/application` ni `src/infrastructure`, ni ningún paquete salvo
  `decimal.js` y los módulos `node:`. `src/application` no importa `src/infrastructure` ni ningún
  framework. Lo comprueba `npm run check:architecture`, y un `KO` ahí no se arregla tocando la regla.
- Un handler de `application` **nunca invoca a otro handler**: si necesita otro caso de uso, despacha
  su mensaje por el `UseCaseMediator` (a través de un puerto si hace falta).
- Los controladores **solo traducen**: el lector generado valida, el controlador despacha. Cero
  lógica de negocio; los errores quedan para `ApiExceptionFilter`.
- El mapeo dominio ↔ TypeORM vive **únicamente** en `<Raíz>RepositoryImpl` (`toDomain`/`toOrm`). Ni
  los handlers ni los controladores importan una entidad ORM, un `EntityManager` ni un `DataSource`.
- Datos de **otro servicio** llegan por `http-clients` o por eventos de `messaging`, nunca inyectando
  persistencia ajena.

## Modelo de dominio

- El estado de un agregado se muta **únicamente** por sus métodos de negocio: sin setters. El
  constructor recibe el `<Raíz>State` de la persistencia (rehidratación); la creación de negocio pasa
  por un factory estático que aplica los invariantes.
- Todo `invariants` declarado en `domain.keel.yaml` tiene una guarda en dominio que lanza el error del
  diseño. Un invariante sin guarda es generación incompleta, no criterio del agente.

Cómo se escriben: `conventions/domain-modeling.md`.

## Aritmética y precisión

- Todo valor **monetario, contable, de tasas o porcentajes y todo cálculo científico** es un
  `Decimal` (`domain/support/decimal.ts`). `number` está **prohibido** para esos valores, en dominio,
  en DTOs, en entidades y en cualquier cálculo intermedio: es binario, no representa exactamente los
  decimales y pierde la escala (`2.50` es `2.5`). Ni de paso (`Number(...)`, `parseFloat`, `+x`).
- Un `long` del diseño es `bigint`, nunca `number`: por encima de 2^53 un `number` pierde dígitos.
- Toda operación que pueda producir más decimales que la escala declarada (`dividedBy`, `times` por
  una tasa, prorrateos) lleva **escala y redondeo explícitos**. La escala sale del diseño; el modo, de
  las Convenciones de determinación de `specs/validation-scenarios.md` y, si no lo declara,
  **`HALF_UP`**.
- Los importes se comparan con **`compareTo(...)`**, nunca con `===` ni con `equals` entre escalas
  distintas.
- La escala del diseño es **contrato observable**: se conserva en dominio, en la columna y en la
  respuesta HTTP. No se normaliza "por limpieza".

## Consistencia y transacciones

- La transacción la abre `UseCaseMediator`: un handler no abre, no confirma y no deshace nada. Un
  repositorio se une a ella solo, por `TransactionContext`.
- `consistency.transactionalBoundary: per-aggregate` (si el diseño lo declara): un command muta una
  sola raíz de agregado.
- **Lo no transaccional va después de las guardas.** Una llamada saliente o cualquier efecto fuera de
  la base no participa de la transacción: si sale antes de que el agregado valide y la guarda rechaza,
  el rollback deshace la fila y deja el efecto hecho fuera. El orden es siempre: cargar → guardas e
  invariantes → efectos externos → confirmar.
- El bloqueo optimista (`lockVersion`) ya lo genera build, con su round-trip y su 409. Es
  infraestructura: no sale al contrato y nadie lo toca. Un `version` que declare el diseño es otro
  contador, de dominio, y lo incrementa el agregado.

## Configuración y secretos

- Ninguna credencial real en `local`/`develop`: el gradiente de perfiles va de literal (local) a
  `${VAR:default}` (develop) a `${VAR}` sin default (production). Una variable obligatoria sin valor
  impide arrancar, nombrándola.
- Configuración nueva va en el fragmento `config/parameters/<perfil>/*.yaml` que corresponda, en los
  tres perfiles, y se lee de la `Configuration` inyectada; nunca un literal en el código ni un
  `process.env` suelto.

## Esquema y topología

- En `local` el esquema lo crea TypeORM (`synchronize`); en `develop` y `production`, **solo** las
  migraciones de `src/migrations/`. Nunca se activa `synchronize` fuera de `local`.
- El código no crea ni altera topología que la plataforma posee (esquemas, topics, buckets) fuera de
  lo que build ya declara.

## Ante ambigüedad

Orden de autoridad: **diseño > conventions > criterio del agente** (documentado en el README del
proyecto). Nunca se inventa comportamiento no declarado en los artefactos para tapar un hueco.
