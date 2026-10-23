# conduit — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/conduit v0.1.1. **Renderizados** desde
> `realworld-node/characterization.yaml` del laboratorio de keel-recover (no se editan a mano). Son
> escenarios de **caracterización**: cada flujo dice si conserva el comportamiento del legacy (`keep`) o lo
> corrige a propósito (`fix`, con su decisión). Los pasos de cada flujo van en su bloque `keel-flow`:
> los ejecuta `keel-recover characterize` contra el legacy y `keel-recover parity` contra el regenerado.

## Convenciones de determinación

- **Identidad del llamante**: el titular es el claim `sub` del token de un proveedor OIDC. Los escenarios
  hablan de **personas** (`alice`, `bob`); «con perfil» significa que su `registerProfile` ya respondió
  `201` con `username` igual a su nombre. `ghost` tiene token válido y ningún perfil.
- **Identificadores**: los `id` son uuid del servidor; el `slug` de un artículo es su `title` en
  kebab-case, un guion y seis caracteres base36 aleatorios. Se reutilizan simbólicamente (`<slug>`).
- **Ausencia vs nulo**: un campo sin valor viaja como `null` (`conventions.nulls: include`).
- **Orden**: listados de artículos por `createdAt` descendente; comentarios igual.
- **Forma del cuerpo de error**: `{timestamp, status, error, code, message, details, correlationId}`; los
  escenarios fijan el `code` y el status.
- **Página**: `{items, page, size, totalElements, totalPages}` (`api.md`).

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| registerProfile | FL-PRF-002, FL-PRF-003, FL-PRF-008, FL-PRF-001, FL-PRF-004, FL-PRF-005, FL-PRF-006, FL-FOL-001, FL-FOL-002, FL-FOL-003, FL-FOL-004, FL-ART-001, FL-ART-002, FL-ART-004, FL-ART-005, FL-ART-006, FL-ART-007, FL-ART-008, FL-FAV-001, FL-FAV-002, FL-COM-001, FL-COM-002, FL-COM-003, FL-TAG-001 | usuarios |
| getMyProfile | FL-PRF-001, FL-PRF-004, FL-AUT-001, FL-AUT-002 | usuarios |
| updateMyProfile | FL-PRF-004 | usuarios |
| getProfile | FL-PRF-005, FL-PRF-006, FL-PRF-007 | usuarios |
| followProfile | FL-FOL-001, FL-FOL-002, FL-FOL-003, FL-FOL-004 | usuarios |
| unfollowProfile | FL-FOL-001 | usuarios |
| listArticles | FL-ART-006, FL-ART-007, FL-ART-008, FL-FAV-001 | usuarios |
| listFeed | FL-FOL-003, FL-FOL-004 | usuarios |
| createArticle | FL-FOL-003, FL-FOL-004, FL-ART-001, FL-ART-002, FL-ART-004, FL-ART-005, FL-ART-006, FL-ART-007, FL-ART-008, FL-FAV-001, FL-FAV-002, FL-COM-001, FL-COM-002, FL-COM-003, FL-TAG-001, FL-AUT-001, FL-AUT-002 | usuarios |
| getArticle | FL-ART-001, FL-ART-003, FL-ART-004, FL-ART-005, FL-FAV-002 | usuarios |
| updateArticle | FL-ART-002, FL-ART-004 | usuarios |
| deleteArticle | FL-ART-004, FL-ART-005 | usuarios |
| favoriteArticle | FL-FAV-001, FL-FAV-002 | usuarios |
| unfavoriteArticle | FL-FAV-001 | usuarios |
| listComments | FL-COM-001, FL-COM-002 | usuarios |
| addComment | FL-COM-001, FL-COM-002, FL-COM-003 | usuarios |
| deleteComment | FL-COM-002, FL-COM-003 | usuarios |
| listTags | FL-TAG-001 | usuarios |

## Perfiles

#### FL-PRF-001: el titular da de alta su perfil y lo lee

**Caracterización**: `keep`. Evidencia: round-0/newman Auth/Register, round-1/R1-010.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `getMyProfile` — `GET /api/v1/user` con el token de `alice`.
**Then**:
1. Status `200`.
2. `username` es `"alice"`.
3. `bio` es `null`.
4. `image` es `null`.

```keel-flow
actors:
  alice: profile
steps:
  - op: getMyProfile
    as: alice
    expect:
      status: ok
      body:
        username: alice
        bio: null
        image: null
```

#### FL-PRF-002: un username ocupado es un conflicto

**Caracterización**: `fix` (`fix-unique-409`: el legacy responde `422`). Evidencia: round-1/R1-001.

**Given**: `alice` con perfil, `bob` sin perfil; ningún artículo.

**When** (1): `registerProfile` — `POST /api/v1/users` con el token de `bob` y `{"username":"alice"}`.
**Then**:
1. Status `409` con `code: USERNAME_ALREADY_EXISTS`.

```keel-flow
actors:
  alice: profile
  bob: none
steps:
  - op: registerProfile
    as: bob
    input:
      username: alice
    legacy:
      status: 422
    expect:
      status: 409
      code: USERNAME_ALREADY_EXISTS
```

#### FL-PRF-003: un username con caracteres no válidos se rechaza en el borde

**Caracterización**: `fix` (`fix-validation-400`: el legacy responde `422`). Evidencia: round-1/R1-002.

**Given**: `bob` sin perfil; ningún artículo.

**When** (1): `registerProfile` — `POST /api/v1/users` con el token de `bob` y `{"username":"a b"}`.
**Then**:
1. Status `400`.

```keel-flow
actors:
  bob: none
steps:
  - op: registerProfile
    as: bob
    input:
      username: a b
    legacy:
      status: 422
    expect:
      status: 400
```

#### FL-PRF-004: actualizar el perfil cambia solo lo que llega

**Caracterización**: `keep`. Evidencia: round-1/R1-036, round-2/R2-004.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `updateMyProfile` — `PUT /api/v1/user` con el token de `alice` y `{"bio":"nueva","image":"http://i/x.png"}`.
**Then**:
1. Status `200`.
2. `username` es `"alice"`.
3. `bio` es `"nueva"`.
4. `image` es `"http://i/x.png"`.

**When** (2): `updateMyProfile` — `PUT /api/v1/user` con el token de `alice` y `{"bio":"otra"}`.
**Then**:
1. Status `200`.
2. `bio` es `"otra"`.
3. `image` es `"http://i/x.png"`.

**When** (3): `getMyProfile` — `GET /api/v1/user` con el token de `alice`.
**Then**:
1. Status `200`.
2. `bio` es `"otra"`.
3. `image` es `"http://i/x.png"`.

```keel-flow
actors:
  alice: profile
steps:
  - op: updateMyProfile
    as: alice
    input:
      bio: nueva
      image: http://i/x.png
    expect:
      status: ok
      body:
        username: alice
        bio: nueva
        image: http://i/x.png
  - op: updateMyProfile
    as: alice
    input:
      bio: otra
    expect:
      status: ok
      body:
        bio: otra
        image: http://i/x.png
  - op: getMyProfile
    as: alice
    expect:
      status: ok
      body:
        bio: otra
        image: http://i/x.png
```

#### FL-PRF-005: el perfil público sin imagen trae la imagen por defecto

**Caracterización**: `keep`. Evidencia: round-1/R1-014.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `getProfile` — `GET /api/v1/profiles/alice` sin token.
**Then**:
1. Status `200`.
2. `username` es `"alice"`.
3. `image` es `"https://static.productionready.io/images/smiley-cyrus.jpg"`.

```keel-flow
actors:
  alice: profile
steps:
  - op: getProfile
    params:
      username: alice
    expect:
      status: ok
      body:
        username: alice
        image: https://static.productionready.io/images/smiley-cyrus.jpg
```

#### FL-PRF-006: el username se busca sin distinguir mayúsculas

**Caracterización**: `fix` (`fix-profile-case`: el legacy responde `404`). Evidencia: round-1/R1-008.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `getProfile` — `GET /api/v1/profiles/Alice` sin token.
**Then**:
1. Status `200`.
2. `username` es `"alice"`.

```keel-flow
actors:
  alice: profile
steps:
  - op: getProfile
    params:
      username: Alice
    legacy:
      status: 404
    expect:
      status: ok
      body:
        username: alice
```

#### FL-PRF-007: un perfil que no existe es 404

**Caracterización**: `keep`. Evidencia: round-1/R1-007.

**Given**: ningún perfil; ningún artículo.

**When** (1): `getProfile` — `GET /api/v1/profiles/nadie` sin token.
**Then**:
1. Status `404` con `code: PROFILE_NOT_FOUND`.

```keel-flow
steps:
  - op: getProfile
    params:
      username: nadie
    expect:
      status: 404
      code: PROFILE_NOT_FOUND
```

## Seguidores

#### FL-FOL-001: seguir dos veces y dejar de seguir a quien no se sigue no fallan

**Caracterización**: `keep`. Evidencia: round-1/R1-020.

**Given**: `alice` con perfil, `bob` con perfil; ningún artículo.

**When** (1): `followProfile` — `POST /api/v1/profiles/alice/follow` con el token de `bob`.
**Then**:
1. Status `200`.
2. `username` es `"alice"`.
3. `following` es `true`.
4. `image` es `"https://static.productionready.io/images/smiley-cyrus.jpg"`.

**When** (2): `followProfile` — `POST /api/v1/profiles/alice/follow` con el token de `bob`.
**Then**:
1. Status `200`.
2. `username` es `"alice"`.
3. `following` es `true`.

**When** (3): `unfollowProfile` — `DELETE /api/v1/profiles/bob/follow` con el token de `alice`.
**Then**:
1. Status `200`.
2. `username` es `"bob"`.
3. `following` es `false`.

```keel-flow
actors:
  alice: profile
  bob: profile
steps:
  - op: followProfile
    as: bob
    params:
      username: alice
    expect:
      status: ok
      body:
        username: alice
        following: true
        image: https://static.productionready.io/images/smiley-cyrus.jpg
  - op: followProfile
    as: bob
    params:
      username: alice
    expect:
      status: ok
      body:
        username: alice
        following: true
  - op: unfollowProfile
    as: alice
    params:
      username: bob
    expect:
      status: ok
      body:
        username: bob
        following: false
```

#### FL-FOL-002: seguirse a uno mismo está permitido

**Caracterización**: `keep`. Evidencia: round-1/R1-034.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `followProfile` — `POST /api/v1/profiles/alice/follow` con el token de `alice`.
**Then**:
1. Status `200`.
2. `username` es `"alice"`.

```keel-flow
actors:
  alice: profile
steps:
  - op: followProfile
    as: alice
    params:
      username: alice
    expect:
      status: ok
      body:
        username: alice
```

#### FL-FOL-003: el feed trae los artículos de los perfiles seguidos

**Caracterización**: `keep`. Evidencia: round-1/R1-014.

**Given**: `alice` con perfil, `bob` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno"}`.

**When** (2): `listFeed` — `GET /api/v1/articles/feed` con el token de `bob`.
**Then**:
1. Status `200`.
2. `totalElements` es `0`.

**When** (3): `followProfile` — `POST /api/v1/profiles/alice/follow` con el token de `bob`.

**When** (4): `listFeed` — `GET /api/v1/articles/feed` con el token de `bob`.
**Then**:
1. Status `200`.
2. `totalElements` es `1`.
3. `items.0.slug` es `"<slug>"`.
4. `items.0.author.username` es `"alice"`.
5. `items.0.author.following` es `true`.
6. `items.0.favorited` es `false`.

```keel-flow
actors:
  alice: profile
  bob: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
    save:
      slug: slug
  - op: listFeed
    as: bob
    expect:
      status: ok
      body:
        totalElements: 0
  - op: followProfile
    as: bob
    params:
      username: alice
  - op: listFeed
    as: bob
    expect:
      status: ok
      body:
        totalElements: 1
        items.0.slug: "{{slug}}"
        items.0.author.username: alice
        items.0.author.following: true
        items.0.favorited: false
```

#### FL-FOL-004: el feed sale del más reciente al más antiguo

**Caracterización**: `fix` (`fix-feed-order`: el legacy responde `200` con `totalElements` = `2`, `items.0.slug` = `"{{s1}}"`). Evidencia: src/routes/api/articles.js:105.

**Given**: `alice` con perfil, `bob` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno"}`.

**When** (2): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art dos"}`.

**When** (3): `followProfile` — `POST /api/v1/profiles/alice/follow` con el token de `bob`.

**When** (4): `listFeed` — `GET /api/v1/articles/feed` con el token de `bob`.
**Then**:
1. Status `200`.
2. `totalElements` es `2`.
3. `items.0.slug` es `"<s2>"`.
4. `items.1.slug` es `"<s1>"`.

```keel-flow
actors:
  alice: profile
  bob: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
    save:
      s1: slug
  - op: createArticle
    as: alice
    input:
      title: art dos
    save:
      s2: slug
  - op: followProfile
    as: bob
    params:
      username: alice
  - op: listFeed
    as: bob
    legacy:
      status: ok
      body:
        totalElements: 2
        items.0.slug: "{{s1}}"
    expect:
      status: ok
      body:
        totalElements: 2
        items.0.slug: "{{s2}}"
        items.1.slug: "{{s1}}"
```

## Artículos

#### FL-ART-001: publicar un artículo

**Caracterización**: `keep`. Evidencia: round-0/newman Create Article, round-1/R1-012.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno","description":"d","body":"b","tagList":["t1","t2"]}`.
**Then**:
1. Status `201`.
2. `title` es `"art uno"`.
3. `description` es `"d"`.
4. `body` es `"b"`.
5. `tagList` es `["t1","t2"]`.
6. `favoritesCount` es `0`.
7. `favorited` es `false`.
8. `author.username` es `"alice"`.
9. `author.following` es `false`.
10. `author.image` es `"https://static.productionready.io/images/smiley-cyrus.jpg"`.
11. `author.subject` es `null`.
12. `slug` empieza por `art-uno-`.
13. `<slug>` es el `slug` de la respuesta.

**When** (2): `getArticle` — `GET /api/v1/articles/<slug>` sin token.
**Then**:
1. Status `200`.
2. `slug` es `"<slug>"`.
3. `title` es `"art uno"`.
4. `favorited` es `false`.
5. `author.image` es `"https://static.productionready.io/images/smiley-cyrus.jpg"`.
6. `author.subject` es `null`.

```keel-flow
actors:
  alice: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
      description: d
      body: b
      tagList:
        - t1
        - t2
    save:
      slug: slug
    expect:
      status: created
      body:
        title: art uno
        description: d
        body: b
        tagList:
          - t1
          - t2
        favoritesCount: 0
        favorited: false
        author.username: alice
        author.following: false
        author.image: https://static.productionready.io/images/smiley-cyrus.jpg
        author.subject: null
        slug:
          startsWith: art-uno-
  - op: getArticle
    params:
      slug: "{{slug}}"
    expect:
      status: ok
      body:
        slug: "{{slug}}"
        title: art uno
        favorited: false
        author.image: https://static.productionready.io/images/smiley-cyrus.jpg
        author.subject: null
```

#### FL-ART-002: cambiar el título no cambia el slug

**Caracterización**: `keep`. Evidencia: round-1/R1-030.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno"}`.

**When** (2): `updateArticle` — `PUT /api/v1/articles/<slug>` con el token de `alice` y `{"title":"otro titulo","tagList":["t9"]}`.
**Then**:
1. Status `200`.
2. `slug` es `"<slug>"`.
3. `title` es `"otro titulo"`.
4. `tagList` es `["t9"]`.

```keel-flow
actors:
  alice: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
    save:
      slug: slug
  - op: updateArticle
    as: alice
    params:
      slug: "{{slug}}"
    input:
      title: otro titulo
      tagList:
        - t9
    expect:
      status: ok
      body:
        slug: "{{slug}}"
        title: otro titulo
        tagList:
          - t9
```

#### FL-ART-003: un slug que no existe es 404

**Caracterización**: `keep`. Evidencia: round-1/R1-007.

**Given**: ningún perfil; ningún artículo.

**When** (1): `getArticle` — `GET /api/v1/articles/no-existe` sin token.
**Then**:
1. Status `404` con `code: ARTICLE_NOT_FOUND`.

```keel-flow
steps:
  - op: getArticle
    params:
      slug: no-existe
    expect:
      status: 404
      code: ARTICLE_NOT_FOUND
```

#### FL-ART-004: solo el autor edita y borra su artículo

**Caracterización**: `keep`. Evidencia: round-1/R1-012.

**Given**: `alice` con perfil, `bob` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno"}`.

**When** (2): `updateArticle` — `PUT /api/v1/articles/<slug>` con el token de `bob` y `{"title":"robado"}`.
**Then**:
1. Status `403` con `code: NOT_ARTICLE_AUTHOR`.

**When** (3): `deleteArticle` — `DELETE /api/v1/articles/<slug>` con el token de `bob`.
**Then**:
1. Status `403` con `code: NOT_ARTICLE_AUTHOR`.

**When** (4): `getArticle` — `GET /api/v1/articles/<slug>` sin token.
**Then**:
1. Status `200`.
2. `title` es `"art uno"`.

```keel-flow
actors:
  alice: profile
  bob: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
    save:
      slug: slug
  - op: updateArticle
    as: bob
    params:
      slug: "{{slug}}"
    input:
      title: robado
    expect:
      status: 403
      code: NOT_ARTICLE_AUTHOR
  - op: deleteArticle
    as: bob
    params:
      slug: "{{slug}}"
    expect:
      status: 403
      code: NOT_ARTICLE_AUTHOR
  - op: getArticle
    params:
      slug: "{{slug}}"
    expect:
      status: ok
      body:
        title: art uno
```

#### FL-ART-005: el autor borra su artículo

**Caracterización**: `keep`. Evidencia: round-0/newman Cleanup, round-1/R1-032.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno"}`.

**When** (2): `deleteArticle` — `DELETE /api/v1/articles/<slug>` con el token de `alice`.
**Then**:
1. Status `204`.

**When** (3): `getArticle` — `GET /api/v1/articles/<slug>` sin token.
**Then**:
1. Status `404`.

```keel-flow
actors:
  alice: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
    save:
      slug: slug
  - op: deleteArticle
    as: alice
    params:
      slug: "{{slug}}"
    expect:
      status: no-content
  - op: getArticle
    params:
      slug: "{{slug}}"
    expect:
      status: 404
```

#### FL-ART-006: el listado filtra por etiqueta y ordena del más reciente al más antiguo

**Caracterización**: `keep`. Evidencia: round-1/R1-031, src/routes/api/articles.js:69.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno","tagList":["t1"]}`.

**When** (2): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art dos","tagList":["t2"]}`.

**When** (3): `listArticles` — `GET /api/v1/articles` sin token.
**Then**:
1. Status `200`.
2. `totalElements` es `2`.
3. `items.0.slug` es `"<s2>"`.
4. `items.1.slug` es `"<s1>"`.

**When** (4): `listArticles` — `GET /api/v1/articles?tag=t1` sin token.
**Then**:
1. Status `200`.
2. `totalElements` es `1`.
3. `items.0.slug` es `"<s1>"`.

**When** (5): `listArticles` — `GET /api/v1/articles?author=alice` sin token.
**Then**:
1. Status `200`.
2. `totalElements` es `2`.

```keel-flow
actors:
  alice: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
      tagList:
        - t1
    save:
      s1: slug
  - op: createArticle
    as: alice
    input:
      title: art dos
      tagList:
        - t2
    save:
      s2: slug
  - op: listArticles
    expect:
      status: ok
      body:
        totalElements: 2
        items.0.slug: "{{s2}}"
        items.1.slug: "{{s1}}"
  - op: listArticles
    query:
      tag: t1
    expect:
      status: ok
      body:
        totalElements: 1
        items.0.slug: "{{s1}}"
  - op: listArticles
    query:
      author: alice
    expect:
      status: ok
      body:
        totalElements: 2
```

#### FL-ART-007: un autor que no existe deja el listado vacío

**Caracterización**: `fix` (`fix-author-filter`: el legacy responde `200` con `totalElements` = `1`). Evidencia: round-1/R1-031.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno"}`.

**When** (2): `listArticles` — `GET /api/v1/articles?author=nadie` sin token.
**Then**:
1. Status `200`.
2. `totalElements` es `0`.

```keel-flow
actors:
  alice: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
  - op: listArticles
    query:
      author: nadie
    legacy:
      status: ok
      body:
        totalElements: 1
    expect:
      status: ok
      body:
        totalElements: 0
```

#### FL-ART-008: favoritos de un perfil que no existe es un listado vacío

**Caracterización**: `keep`. Evidencia: round-1/R1-031.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno"}`.

**When** (2): `listArticles` — `GET /api/v1/articles?favorited=nadie` sin token.
**Then**:
1. Status `200`.
2. `totalElements` es `0`.

```keel-flow
actors:
  alice: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
  - op: listArticles
    query:
      favorited: nadie
    expect:
      status: ok
      body:
        totalElements: 0
```

## Favoritos

#### FL-FAV-001: marcar dos veces cuenta uno y desmarcar lo que no está no falla

**Caracterización**: `keep`. Evidencia: round-1/R1-020.

**Given**: `alice` con perfil, `bob` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno"}`.

**When** (2): `favoriteArticle` — `POST /api/v1/articles/<slug>/favorite` con el token de `bob`.
**Then**:
1. Status `200`.
2. `favoritesCount` es `1`.
3. `favorited` es `true`.

**When** (3): `favoriteArticle` — `POST /api/v1/articles/<slug>/favorite` con el token de `bob`.
**Then**:
1. Status `200`.
2. `favoritesCount` es `1`.

**When** (4): `unfavoriteArticle` — `DELETE /api/v1/articles/<slug>/favorite` con el token de `alice`.
**Then**:
1. Status `200`.
2. `favoritesCount` es `1`.
3. `favorited` es `false`.

**When** (5): `listArticles` — `GET /api/v1/articles?favorited=bob` sin token.
**Then**:
1. Status `200`.
2. `totalElements` es `1`.
3. `items.0.slug` es `"<slug>"`.

```keel-flow
actors:
  alice: profile
  bob: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
    save:
      slug: slug
  - op: favoriteArticle
    as: bob
    params:
      slug: "{{slug}}"
    expect:
      status: ok
      body:
        favoritesCount: 1
        favorited: true
  - op: favoriteArticle
    as: bob
    params:
      slug: "{{slug}}"
    expect:
      status: ok
      body:
        favoritesCount: 1
  - op: unfavoriteArticle
    as: alice
    params:
      slug: "{{slug}}"
    expect:
      status: ok
      body:
        favoritesCount: 1
        favorited: false
  - op: listArticles
    query:
      favorited: bob
    expect:
      status: ok
      body:
        totalElements: 1
        items.0.slug: "{{slug}}"
```

#### FL-FAV-002: dos perfiles que marcan el mismo artículo cuentan dos

**Caracterización**: `keep`. Evidencia: round-1/R1-023.

**Given**: `alice` con perfil, `bob` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno"}`.

**When** (2): `favoriteArticle` — `POST /api/v1/articles/<slug>/favorite` con el token de `alice`.

**When** (3): `favoriteArticle` — `POST /api/v1/articles/<slug>/favorite` con el token de `bob`.
**Then**:
1. Status `200`.
2. `favoritesCount` es `2`.

**When** (4): `getArticle` — `GET /api/v1/articles/<slug>` sin token.
**Then**:
1. Status `200`.
2. `favoritesCount` es `2`.

```keel-flow
actors:
  alice: profile
  bob: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
    save:
      slug: slug
  - op: favoriteArticle
    as: alice
    params:
      slug: "{{slug}}"
  - op: favoriteArticle
    as: bob
    params:
      slug: "{{slug}}"
    expect:
      status: ok
      body:
        favoritesCount: 2
  - op: getArticle
    params:
      slug: "{{slug}}"
    expect:
      status: ok
      body:
        favoritesCount: 2
```

## Comentarios

#### FL-COM-001: los comentarios se listan del más reciente al más antiguo

**Caracterización**: `keep`. Evidencia: round-2/R2-003.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno"}`.

**When** (2): `addComment` — `POST /api/v1/articles/<slug>/comments` con el token de `alice` y `{"body":"uno"}`.
**Then**:
1. Status `201`.
2. `body` es `"uno"`.
3. `author.username` es `"alice"`.
4. `author.following` es `false`.
5. `author.image` es `"https://static.productionready.io/images/smiley-cyrus.jpg"`.
6. `author.subject` es `null`.

**When** (3): `addComment` — `POST /api/v1/articles/<slug>/comments` con el token de `alice` y `{"body":"dos"}`.

**When** (4): `listComments` — `GET /api/v1/articles/<slug>/comments` sin token.
**Then**:
1. Status `200`.
2. `items.length` es `2`.
3. `items.0.body` es `"dos"`.
4. `items.1.body` es `"uno"`.

```keel-flow
actors:
  alice: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
    save:
      slug: slug
  - op: addComment
    as: alice
    params:
      slug: "{{slug}}"
    input:
      body: uno
    expect:
      status: created
      body:
        body: uno
        author.username: alice
        author.following: false
        author.image: https://static.productionready.io/images/smiley-cyrus.jpg
        author.subject: null
  - op: addComment
    as: alice
    params:
      slug: "{{slug}}"
    input:
      body: dos
  - op: listComments
    params:
      slug: "{{slug}}"
    expect:
      status: ok
      body:
        items.length: 2
        items.0.body: dos
        items.1.body: uno
```

#### FL-COM-002: solo el autor borra su comentario

**Caracterización**: `keep`. Evidencia: round-1/R1-013.

**Given**: `alice` con perfil, `bob` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno"}`.

**When** (2): `addComment` — `POST /api/v1/articles/<slug>/comments` con el token de `alice` y `{"body":"hola"}`.

**When** (3): `deleteComment` — `DELETE /api/v1/articles/<slug>/comments/<cid>` con el token de `bob`.
**Then**:
1. Status `403` con `code: NOT_COMMENT_AUTHOR`.

**When** (4): `deleteComment` — `DELETE /api/v1/articles/<slug>/comments/<cid>` con el token de `alice`.
**Then**:
1. Status `204`.

**When** (5): `listComments` — `GET /api/v1/articles/<slug>/comments` sin token.
**Then**:
1. Status `200`.
2. `items.length` es `0`.

```keel-flow
actors:
  alice: profile
  bob: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
    save:
      slug: slug
  - op: addComment
    as: alice
    params:
      slug: "{{slug}}"
    input:
      body: hola
    save:
      cid: id
  - op: deleteComment
    as: bob
    params:
      slug: "{{slug}}"
      commentId: "{{cid}}"
    expect:
      status: 403
      code: NOT_COMMENT_AUTHOR
  - op: deleteComment
    as: alice
    params:
      slug: "{{slug}}"
      commentId: "{{cid}}"
    expect:
      status: no-content
  - op: listComments
    params:
      slug: "{{slug}}"
    expect:
      status: ok
      body:
        items.length: 0
```

#### FL-COM-003: un comentario se borra solo por la ruta de su artículo

**Caracterización**: `fix` (`fix-comment-ownership`: el legacy responde `204`). Evidencia: round-1/R1-033.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno"}`.

**When** (2): `addComment` — `POST /api/v1/articles/<s1>/comments` con el token de `alice` y `{"body":"hola"}`.

**When** (3): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art dos"}`.

**When** (4): `deleteComment` — `DELETE /api/v1/articles/<s2>/comments/<cid>` con el token de `alice`.
**Then**:
1. Status `404` con `code: COMMENT_NOT_FOUND`.

```keel-flow
actors:
  alice: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
    save:
      s1: slug
  - op: addComment
    as: alice
    params:
      slug: "{{s1}}"
    input:
      body: hola
    save:
      cid: id
  - op: createArticle
    as: alice
    input:
      title: art dos
    save:
      s2: slug
  - op: deleteComment
    as: alice
    params:
      slug: "{{s2}}"
      commentId: "{{cid}}"
    legacy:
      status: no-content
    expect:
      status: 404
      code: COMMENT_NOT_FOUND
```

## Etiquetas

#### FL-TAG-001: las etiquetas son las distintas de todos los artículos

**Caracterización**: `keep`. Evidencia: round-2/R2-002.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art uno","tagList":["t1","t2"]}`.

**When** (2): `createArticle` — `POST /api/v1/articles` con el token de `alice` y `{"title":"art dos","tagList":["t2","t3"]}`.

**When** (3): `listTags` — `GET /api/v1/tags` sin token.
**Then**:
1. Status `200`.
2. `tags` contiene exactamente ["t1","t2","t3"] en cualquier orden.

```keel-flow
actors:
  alice: profile
steps:
  - op: createArticle
    as: alice
    input:
      title: art uno
      tagList:
        - t1
        - t2
  - op: createArticle
    as: alice
    input:
      title: art dos
      tagList:
        - t2
        - t3
  - op: listTags
    expect:
      status: ok
      body:
        tags:
          sameMembers:
            - t1
            - t2
            - t3
```

## Autenticación

#### FL-AUT-001: sin token, una operación que lo exige es 401

**Caracterización**: `keep`. Evidencia: round-1/R1-010.

**Given**: ningún perfil; ningún artículo.

**When** (1): `getMyProfile` — `GET /api/v1/user` sin token.
**Then**:
1. Status `401`.

**When** (2): `createArticle` — `POST /api/v1/articles` sin token y `{"title":"x"}`.
**Then**:
1. Status `401`.

```keel-flow
steps:
  - op: getMyProfile
    expect:
      status: 401
  - op: createArticle
    input:
      title: x
    expect:
      status: 401
```

#### FL-AUT-002: un token válido de alguien sin perfil es 401

**Caracterización**: `keep`. Evidencia: round-1/R1-011, round-2/R2-005.

**Given**: `ghost` sin perfil; ningún artículo.

**When** (1): `getMyProfile` — `GET /api/v1/user` con el token de `ghost`.
**Then**:
1. Status `401` con `code: PROFILE_NOT_REGISTERED`.

**When** (2): `createArticle` — `POST /api/v1/articles` con el token de `ghost` y `{"title":"x"}`.
**Then**:
1. Status `401` con `code: PROFILE_NOT_REGISTERED`.

```keel-flow
actors:
  ghost: none
steps:
  - op: getMyProfile
    as: ghost
    expect:
      status: 401
      code: PROFILE_NOT_REGISTERED
  - op: createArticle
    as: ghost
    input:
      title: x
    expect:
      status: 401
      code: PROFILE_NOT_REGISTERED
```

## Perfiles

#### FL-PRF-008: un titular no puede tener dos perfiles

**Caracterización**: `new`. Evidencia: decisions fix-identity.

**Given**: `alice` con perfil; ningún artículo.

**When** (1): `registerProfile` — `POST /api/v1/users` con el token de `alice` y `{"username":"otra"}`.
**Then**:
1. Status `409` con `code: PROFILE_ALREADY_EXISTS`.

```keel-flow
actors:
  alice: profile
steps:
  - op: registerProfile
    as: alice
    input:
      username: otra
    expect:
      status: 409
      code: PROFILE_ALREADY_EXISTS
```
