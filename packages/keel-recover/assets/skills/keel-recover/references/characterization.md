# Escenarios de caracterización (paso 4)

`validation-scenarios.md` es el contrato de equivalencia de Keel, y en un diseño recuperado sus flujos salen de las **grabaciones**: cada uno dice qué hace el legacy y si el servicio nuevo hará lo mismo. Se escriben con las reglas de siempre (`{{keel:skills}}/keel-design/references/scenario-authoring.md`: Given/When/Then por operación del diseño, nunca por ruta del legacy) más una línea que solo existe aquí, justo debajo del título del flujo:

```markdown
### FL-PRF-002: un username ocupado es un conflicto
**Caracterización**: `fix` (`fix-unique-409`: el legacy responde `422`). Evidencia: recordings/round-1/R1-001.
**Given**: …
```

| Marca | Qué afirma | Qué la sostiene |
|---|---|---|
| `keep` | el servicio nuevo hace **lo mismo** que el legacy | la grabación que el flujo cita; contra el legacy en marcha tiene que pasar |
| `fix` (`fix-*`) | el legacy hace otra cosa, y el nuevo la **corrige a propósito** | una entrada en `provenance.yaml → fixes` con lo que hace el legacy, el porqué y quién lo decidió |
| `frontier` (`F-*`) | el legacy lo hace y el DSL **no lo puede decir** | una entrada en `provenance.yaml → frontier`; contra el nuevo se informa sin contar |
| `new` | solo existe en el servicio nuevo (una decisión `asked` que el legacy no tenía) | la decisión del humano |

`keel validate --ready` (criterio `provenance`) sale en rojo con un flujo sin marca, con un `fix` o un `F-*` que no existen en `provenance.yaml`, y con un `fix` que ningún flujo demuestra: un cambio sin escenario no es un cambio.

## Cómo se decide

1. **Por defecto, `keep`.** Lo que el legacy hace y nadie ha dicho que esté mal es comportamiento del sistema, aunque sea raro.
2. **Un `fix` lo decide el humano, nunca tú.** Propónlo con la grabación delante («el legacy responde 422 a un username repetido; Keel exige 409 para una unicidad: ¿se corrige?») y pregunta con `AskUserQuestion`. Para un refactor, la lista de `fix` **es** su backlog: que se vea entera.
3. **Lo que exige el método no es opcional**, pero sigue siendo un `fix`: el contrato del cable (envolturas, forma del error, paginación), la identidad delegada en un proveedor OIDC, el 409 de una unicidad. Se declaran igual, con su flujo, para que la paridad del paso 7 sepa que esa diferencia es buscada.
4. **Un `keep` que no puedes demostrar con una grabación no es un `keep`**: es una sonda que falta. Escríbela en la ronda siguiente antes de escribir el flujo.

## Lo que viene después

Los flujos `keep` se ejecutan contra el legacy en marcha (incremento 6 de keel-recover, criterio `characterized`): tienen que pasar todos. Si uno falla, el diseño dice algo que el legacy no hace, y se corrige el diseño, no el escenario.
