# Nombres y paquetes

## Identificadores

- `MixedCaps`, nunca `snake_case`. Una mayúscula inicial exporta; una minúscula, no.
- **Las siglas en un solo caso**: `ID`, `URL`, `HTTP`, `JSON`, `UUID`, `SQL`, `API`… (la lista de staticcheck,
  ST1003). El nombre del cable no cambia: va en el tag.

  ```go
  type Order struct {
  	CustomerID uuid.UUID `json:"customerId"`
  	ImageURLs  []string  `json:"imageUrls"`
  }

  func (o *Order) customerID() uuid.UUID // no exportado: la sigla, entera en minúsculas
  ```

- Sin tartamudeo: el paquete ya es parte del nombre. `domain.Order`, no `domain.DomainOrder`; `config.Load`, no
  `config.LoadConfig`.
- Getters sin `Get`: `o.Status()`, no `o.GetStatus()`. Un setter, si existe, es `SetStatus`.
- Receptores de una o dos letras, **los mismos** en todos los métodos del tipo: `func (o *Order)`, nunca `this`
  ni `self`.
- Interfaces de un método con sufijo `-er` cuando el nombre sale natural (`Publisher`, `Clock`); si no, el nombre
  del rol (`OrderRepository`).
- Constantes de enum con el tipo delante: `OrderStatusInReview`.

## Paquetes

- Cortos, en minúscula, en singular y sin guiones ni subrayados: `httpapi`, `postgres`, `health`.
- **Prohibidos** `util`, `utils`, `common`, `helpers`, `models`, `base` y `types`: no dicen qué hay dentro. El
  código va al paquete de lo que hace.
- Cada paquete lleva `doc.go` (o el comentario en su archivo principal) empezando por `// Package <nombre> …`.

## Comentarios

- Todo identificador exportado lleva comentario de documentación que **empieza por su nombre**:

  ```go
  // Load carga la configuración del perfil activo.
  func Load(files fs.FS, getenv func(string) string) (*Config, error)
  ```

- La prosa va en español; los identificadores, en inglés.

## Imports

- Tres grupos separados por una línea en blanco, cada uno ordenado: la biblioteca estándar, los terceros y el
  propio módulo (el orden de `goimports`).
- Un alias solo cuando dos paquetes se llaman igual, y entonces con un nombre que diga cuál es
  (`configfiles "…/config"`).
