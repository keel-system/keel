# contracts/ — contratos de los servidores de los que dependemos

Aquí vive el `INTEGRATION.md` de cada **proveedor externo**: un servidor diseñado por otro equipo, en otro
repositorio, del que este workspace consume datos o eventos. Uno por directorio:

```
contracts/
  catalog/INTEGRATION.md      # contrato publicado por el equipo de catalog
  payments/INTEGRATION.md
```

## Por qué se copian aquí

- **`/keel-consume` los lee** para derivar las capas `dependencies`, `http-clients` y `messaging` del servicio
  que se está diseñando.
- **Quedan versionados en git**, así que el equipo puede auditar a qué contrato exacto está acoplado cada diseño
  (la versión concreta se declara además en `dependencies.<proveedor>.contract.version`).
- **Habilitan el modo diff**: cuando el proveedor publica una versión nueva, reemplaza el archivo y vuelve a
  ejecutar `/keel-consume`, que compara con la versión declarada y te enseña qué cambió antes de tocar nada.

## Qué NO va aquí

- **Los contratos que produce este workspace.** El `INTEGRATION.md` de un servicio diseñado aquí lo escribe
  `/keel-integrate` en `docs/<servicio>/INTEGRATION.md`. `contracts/` es entrada; `docs/` es salida.
- **Proveedores diseñados en este mismo workspace.** Si dependes de un servicio que también vive aquí,
  `/keel-consume` lee su `docs/<servicio>/INTEGRATION.md` en sitio: copiarlo abriría divergencia entre dos copias
  del mismo contrato.
- **Credenciales, URLs de entorno o tokens.** Un contrato describe el mecanismo de autenticación, nunca sus valores.
