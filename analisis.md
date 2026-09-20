Estado actual

┌─────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────┐
│        Señal        │                                           Medida                                           │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────┤
│ npm test            │ 1964 tests en verde (637 core + 1327 spring), 93 archivos de test, 0 fallos                │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────┤
│ Tiempo de suite     │ core 5 s · spring 9 min 14 s                                                               │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────┤
│ npm run matrix      │ 50 celdas · 35 verificadas · 9 sin ejecutar · 2 degradadas · 4 no aplican; de las          │
│                     │ verificadas, 32 falsadas y 3 sin falsar                                                    │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────┤
│ capability-coverage │ 9 excepciones, 0 huecos — ninguna capacidad del DSL sin fixture ni test                    │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────┤
│ Observabilidad      │ integrada con red propia (telemetry-check, deploy-check 8/8), convención instalada por     │
│                     │ stack, guía dual con test de paridad byte a byte y gate de cardinalidad                    │
└─────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────┘

Lo que está sólido no hace falta tocarlo: la medición por mutación, la frontera build/agente con keel-generated.json, y la paridad relacional↔documental atada por pares byte a byte son, con diferencia, lo mejor del sistema.

Dónde está la debilidad, por orden de lo que yo haría

1. No hay CI. No existe .github/ ni equivalente. Todo el aparato determinista que este repo construyó precisamente para ser puerta —npm test, keel index --check, keel system check, npm run matrix— se ejecuta a mano, con dos paquetes ya publicados en npm. Y la suite de spring tarda 9 minutos: el coste de no tenerlo ya se está pagando localmente. Es el mayor ratio valor/esfuerzo del repo hoy. Un workflow con npm test más un job opt-in con servicios de contenedor (store-check sobre PostgreSQL, que es el más denso por minuto).

2. El cuestionario ofrece motores que nadie ha ejecutado, y no lo dice. Las 9 celdas «sin ejecutar» están todas en sqlserver / oracle / mariadb, y stack-catalog.js, prompt.js y build.js no contienen la palabra «verificado»: elegir Oracle es heredar en silencio código que ninguna red ha corrido. El patrón para arreglarlo ya existe y es tuyo — engine-limits.js deriva de engine-support.js el aviso de lo degradado; falta la proyección hermana para el estado de verificación. Aparte, cerrar SQL Server con claim-check/store-check cierra cuatro mecanismos de un golpe (claim-dialect, harness-sql-literals, partial-unique-index, unique-collation).

3. El segundo generador — el riesgo estructural. KNOWN_GENERATORS tiene una sola entrada. La tesis del producto («el mismo diseño en más de un stack, entre organizaciones») descansa en que keel-core sea agnóstico, y eso no lo ha comprobado nadie: write.js, design-delta.js, harness.js y spec-files.js se diseñaron con un único consumidor, y una abstracción con un solo cliente no es una abstracción. No hace falta un keel-nest completo: basta uno que llegue al scaffolding y a los escenarios, sin el pipeline de cinco agentes. Su valor no es la tecnología, es el informe de qué tuvo que mudarse de keel-spring a keel-core.

4. Lo que acabas de integrar tiene la única evidencia no repetible del sistema. telemetry-store-spans sale SIN FALSAR en las dos ramas, y la matriz explica por qué: telemetry-check arranca la app pero el span del almacén necesita una consulta dentro de un caso de uso, y el handler recién generado lanza antes de tocar la base. Hoy esa garantía se sostiene sobre dos corridas del 2026-09-19, no sobre un script. Es el hueco más propio del trabajo recién cerrado.

5. El lado del diseño está menos instrumentado que el del generador. Siete obligaciones, todas kind: decision; kind: review está soportado y vacío, así que la revisión semántica de /keel-validate sigue siendo prosa sin ids que recorrer. Y no hay ninguna medición por mutación en keel-core: nadie ha roto una regla de crossrefs.js para ver si su test se pone rojo. Es exactamente el argumento que ya ganó en keel-spring.

6. Menor, pero es lo primero que se lee. El README declara «46 celdas · 31 verificadas · 30 falsadas», «8 redes que ejecutan de verdad» y «87 suites»; los números reales son 50/35/32, 11 scripts en vivo y 93 archivos de test. Se quedó atrás con el trabajo de observabilidad.

Mi orden: 1 → 2 → 3, con 4 y 5 como relleno entre tandas. El 1 y el 2 son de días; el 3 es el que decide si Keel es un generador de Spring con buena disciplina o la metodología que dice ser.