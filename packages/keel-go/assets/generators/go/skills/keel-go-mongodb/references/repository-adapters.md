# Usar los puertos desde un handler (documental)

El puerto `domain.<Raíz>Repository` es el MISMO que en la rama relacional: `FindByID`, el finder de cada clave natural
(`FindBy<Campo>`), `List(pageable)` si alguna operación pagina, `Save` y `DeleteByID`. El adaptador de
`internal/infrastructure/mongo` lo implementa sobre el documento del agregado.

## Lectura

```go
job, found, err := h.jobRepository.FindByID(ctx, cmd.ID)
if err != nil {
	return err // ya traducido al contrato
}
if !found {
	return domain.Errorf(domain.ErrJobNotFound, "No existe un trabajo con el id %s", cmd.ID)
}
```

- El agregado se lee ENTERO en una lectura: sus entidades internas van dentro del documento. No hay N+1 dentro del
  agregado, pero sí entre agregados: una lectura por elemento en un bucle sobre una página sigue siendo un `designGap`
  si el puerto no tiene la lectura por lote.
- Una página ordena por la RUTA del documento (`location.label`, `sections.status`): las mismas propiedades que acepta
  el `?sort=` del contrato, con el `_id` como desempate. Una propiedad que no existe es un error.

## Escritura

```go
if err := job.Cancel(); err != nil { // el método semántico del _behavior.go
	return err
}
if _, err := h.jobRepository.Save(ctx, job); err != nil {
	return err
}
```

- **Cargar una vez, mutar, `Save` una vez.** `Save` hace `$set` sobre el documento entero (nunca lo reemplaza: la
  auditoría de la política se conserva) con la versión en el filtro, y lo RELEE en la misma transacción: la respuesta
  se construye desde lo que devuelve.
- Una unicidad que choca la traduce el adaptador al `code` del diseño. Dentro de una transacción, el choque la aborta
  entera: no se «recupera» y se sigue.

## Lo que no se hace

- Filtrar en memoria tras un `List`: si la condición no está en ningún finder, es un `designGap`.
- Escribir sin `Save`, o un método nuevo en el puerto o el adaptador: llevan la cabecera de código generado.
