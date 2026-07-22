# Golden example

Aquí vivirá el **ejemplo de referencia** del generador: el resultado de generar un diseño fijo multi-artefacto (previsiblemente `product-catalog`) con las convenciones de este repo.

Propósito:

- **Referencia de estilo**: ante dudas durante una generación, se imita el golden.
- **Detección de regresiones**: tras cambiar la skill o las conventions, se regenera el diseño fijo y se compara contra el golden; diferencias no intencionales = regresión del generador.

Se poblará en la fase 2, con la primera generación real de `product-catalog`.

Contenido previsto:

```
golden/
├── specs/product-catalog/    # copia congelada del diseño de referencia (manifiesto + capas)
└── product-catalog-spring/   # resultado de la generación, revisado y aprobado
```
