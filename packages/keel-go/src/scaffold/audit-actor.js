// La AUTORÍA de las escrituras (`persistence.audit.authorship`, tramo 13g): quién crea y quién modifica cada agregado. Es
// el AuditorAware de keel-spring, el `currentActor()` de keel-nest y el `AuditActor` de keel-dotnet, con la misma regla,
// porque lo que queda en `created_by` y `updated_by` es contrato de los datos —lo lee quien audita, con cualquiera de los
// cuatro servidores—:
//
//   · con un token, el SUJETO (`sub`): el identificador estable, no el nombre del principal, que es para mostrar y puede
//     cambiar; el nombre solo si el token no trae `sub`;
//   · con una clave de API, el cliente que autenticó (el nombre del principal);
//   · sin petición autenticada detrás (un listener, un barrido, el relay): el centinela `system`, con la correlación si la
//     hay (`system:<correlationId>`), que dice la verdad —«esto no lo hizo una persona»— en vez de un vacío que obligue a
//     adivinarlo. Nunca vacío: las columnas son NOT NULL.
//
// Va en el paquete del almacén (`postgres`, `mysql` o `mongo`), un solo archivo para todos sus adaptadores, y su prueba
// emitida (`audit_actor_test.go`) EJECUTA la regla caso a caso con lo que el servicio tiene (seguridad, correlación).

import { SYSTEM_ACTOR } from '@keel-system/keel-core/gen/relational';
import { usesPersistence } from '@keel-system/keel-core/gen/features';
import { goString } from '../lib/go-source.js';
import { usesCorrelation } from './correlation.js';
import { usesHttpSecurity } from './security.js';
import { layout, packageFile } from './render.js';

/** ¿Alguna entidad persistida registra QUIÉN escribe, por política (`all`) o en campos que declara (`declared`)? */
export function usesAuthorship(model) {
  if (!usesPersistence(model)) return false;
  return (model.entities ?? []).some((entity) => entity.persisted && (entity.auditAuthorship === 'all' || entity.auditAuthorship === 'declared'));
}

/** Los campos de autoría que una entidad DECLARA en su dominio (`declared`): los estampa el adaptador como los de la política. */
export function declaredAuthorship(entity) {
  if (entity.auditAuthorship !== 'declared') return [];
  return ['createdBy', 'updatedBy'].filter((name) => (entity.fields ?? []).some((field) => field.name === name));
}

/** ¿Declara alguna entidad un campo de autoría? El adaptador documental lleva entonces el actor en su encoder. */
export function usesDeclaredAuthorship(model) {
  return usesPersistence(model) && (model.entities ?? []).some((entity) => entity.persisted && declaredAuthorship(entity).length > 0);
}

export function generate(model) {
  if (!usesAuthorship(model)) return [];
  const { store } = layout(model);
  const security = usesHttpSecurity(model);
  const correlation = usesCorrelation(model);
  // createdAuthor solo con un createdBy declarado: en Go una función sin usar es un hallazgo de staticcheck.
  const declared = model.entities.some((entity) => entity.persisted && declaredAuthorship(entity).includes('createdBy'));
  return [
    { path: `${store.dir}/audit_actor.go`, content: packageFile(model, store, { imports: actorImports(security, correlation), body: actorBody(security, correlation, declared) }) },
    { path: `${store.dir}/audit_actor_test.go`, content: packageFile(model, store, { imports: testImports(security, correlation), body: testBody(security, correlation, declared) }) }
  ];
}

function actorImports(security, correlation) {
  return ['context', ...(correlation ? ['internal/platform/correlation'] : []), ...(security ? ['internal/platform/security'] : [])];
}

function actorBody(security, correlation, declared) {
  const principal = security
    ? `	if principal, ok := security.PrincipalFrom(ctx); ok {
		// Con un token, el sujeto; con una clave de API, el cliente que la presentó.
		if subject, found := security.ClaimText(principal.Claims, "sub"); principal.Kind == security.TokenPrincipal && found && subject != "" {
			return subject
		}
		if principal.Name != "" {
			return principal.Name
		}
	}
`
    : '';
  const fallback = correlation
    ? `	// Escritura sin petición autenticada detrás: no hay actor, pero sí traza.
	if id, ok := correlation.ID(ctx); ok {
		return systemActor + ":" + id
	}
	return systemActor`
    : '\treturn systemActor';
  return `// systemActor es el autor de las escrituras que no nacen de una petición autenticada.
const systemActor = ${goString(SYSTEM_ACTOR)}

// auditActor es quién escribe, para created_by y updated_by: la regla del AuditorAware de keel-spring. Nunca vacío.${
    security ? '' : '\n// Sin capa de seguridad no hay principal: toda escritura es del sistema.'
  }
func auditActor(ctx context.Context) string {
${principal}${fallback}
}${declared ? `

// createdAuthor es la autoría de un alta: la que ya trae el agregado (la que leyó de la base), o el actor si viene
// vacía. Vacía es AUSENTE: el dominio no conoce al llamante y en el alta la deja sin escribir.
func createdAuthor(current, actor string) string {
	if current == "" {
		return actor
	}
	return current
}` : ''}`;
}

function testImports(security, correlation) {
  return [
    'context',
    'testing',
    ...(correlation ? ['internal/platform/correlation'] : []),
    ...(security ? ['encoding/json/jsontext', 'internal/platform/security'] : [])
  ];
}

function testBody(security, correlation, declared) {
  const cases = [];
  if (security) {
    cases.push(`// Con un token, el sujeto y no el nombre: el nombre es para mostrar y puede cambiar.
func TestAuditActorConUnTokenEsElSujetoNoElNombre(t *testing.T) {
	ctx := security.WithPrincipal(context.Background(), token("nombre-visible", map[string]jsontext.Value{"sub": jsontext.Value(\`"sujeto-estable"\`)}))
	if got := auditActor(ctx); got != "sujeto-estable" {
		t.Fatalf("auditActor = %q, se esperaba el sub", got)
	}
}

// Un token sin sub: el nombre del principal.
func TestAuditActorConUnTokenSinSujetoEsElNombre(t *testing.T) {
	ctx := security.WithPrincipal(context.Background(), token("nombre-visible", map[string]jsontext.Value{"name": jsontext.Value(\`"x"\`)}))
	if got := auditActor(ctx); got != "nombre-visible" {
		t.Fatalf("auditActor = %q, se esperaba el nombre", got)
	}
}

// Con una clave de API, el cliente que la presentó.
func TestAuditActorConUnaClaveDeAPIEsElCliente(t *testing.T) {
	ctx := security.WithPrincipal(context.Background(), &security.Principal{Kind: security.KeyPrincipal, Name: "cliente-de-la-clave"})
	if got := auditActor(ctx); got != "cliente-de-la-clave" {
		t.Fatalf("auditActor = %q, se esperaba el cliente", got)
	}
}`);
  }
  if (correlation) {
    cases.push(`// Sin principal, el sistema con la correlación: dice quién no fue y deja la traza.
func TestAuditActorSinPrincipalEsElSistemaConLaCorrelacion(t *testing.T) {
	ctx := correlation.WithID(context.Background(), "pedido-42")
	if got := auditActor(ctx); got != "system:pedido-42" {
		t.Fatalf("auditActor = %q", got)
	}
}`);
  }
  cases.push(`// Sin principal ni correlación, el sistema: nunca vacío, las columnas son NOT NULL.
func TestAuditActorSinPrincipalNiCorrelacionEsElSistema(t *testing.T) {
	if got := auditActor(context.Background()); got != systemActor {
		t.Fatalf("auditActor = %q, se esperaba %q", got, systemActor)
	}
}`);
  if (declared) {
    cases.push(`// La autoría del alta: la que ya trae el agregado se conserva; vacía es ausente y se estampa el actor.
func TestCreatedAuthorVaciaEsAusente(t *testing.T) {
	if got := createdAuthor("", "quien-escribe"); got != "quien-escribe" {
		t.Fatalf("createdAuthor vacía = %q", got)
	}
	if got := createdAuthor("quien-creo", "quien-escribe"); got != "quien-creo" {
		t.Fatalf("createdAuthor = %q, se esperaba la que ya traía", got)
	}
}`);
  }
  if (security) {
    cases.push(`func token(name string, claims map[string]jsontext.Value) *security.Principal {
	return &security.Principal{Kind: security.TokenPrincipal, Name: name, Claims: claims}
}`);
  }
  return cases.join('\n\n');
}
