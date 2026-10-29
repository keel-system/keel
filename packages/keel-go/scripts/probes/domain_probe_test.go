package domain

// La sonda del DOMINIO que emite keel-go para product-catalog: Go de verdad, no una plantilla. go-check la copia
// dentro de internal/domain del proyecto generado (prueba interna: llega a transitionTo, que no se exporta) y la
// ejecuta; después aplica cada sabotaje de test/helpers/domain-sabotages.js y comprueba que cae la prueba que
// nombra. Calca los casos de las sondas de keel-dotnet (scripts/probes/DomainProbes) y de keel-nest
// (test/domain.test.js): escala normalizada, rechazo con 400 VALIDATION_ERROR, el ancla del formato, la
// transición negada con 409 y los centinelas que errors.Is distingue.

import (
	"errors"
	"testing"

	"product-catalog/internal/platform/wire"
)

// asDomain devuelve el *Error de err, o falla.
func asDomain(t *testing.T, err error) *Error {
	t.Helper()
	var domainErr *Error
	if !errors.As(err, &domainErr) {
		t.Fatalf("%v no es un error de dominio", err)
	}
	return domainErr
}

func TestProbeMoneyNormalizesScale(t *testing.T) {
	for _, tt := range []struct{ in, want string }{
		{"2.5", "2.50"},
		{"2.345", "2.35"},
		{"2", "2.00"},
		{"2.50", "2.50"},
	} {
		money, err := NewMoney(wire.MustDecimal(tt.in), "EUR")
		if err != nil {
			t.Fatalf("%s: %v", tt.in, err)
		}
		if got := money.Amount().String(); got != tt.want {
			t.Errorf("NewMoney(%s).Amount() = %s, se esperaba %s", tt.in, got, tt.want)
		}
	}
	a, _ := NewMoney(wire.MustDecimal("2.5"), "EUR")
	b, _ := NewMoney(wire.MustDecimal("2.50"), "EUR")
	if !a.Equal(b) {
		t.Error("2.5 y 2.50 normalizados no son el mismo Money")
	}
}

func TestProbeMoneyRejectsWithValidationError(t *testing.T) {
	for _, tt := range []struct {
		name     string
		amount   string
		currency string
	}{
		{"importe negativo", "-0.01", "EUR"},
		{"divisa corta", "1", "EU"},
		{"divisa larga", "1", "EURO"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewMoney(wire.MustDecimal(tt.amount), tt.currency)
			if !errors.Is(err, ErrInvalidValue) {
				t.Fatalf("se esperaba ErrInvalidValue, llegó %v", err)
			}
			if got := asDomain(t, err); got.Code() != "VALIDATION_ERROR" || got.Status() != 400 {
				t.Errorf("code %s y status %d, se esperaba VALIDATION_ERROR y 400", got.Code(), got.Status())
			}
		})
	}
}

func TestProbeMoneyTravelsThroughItsConstructor(t *testing.T) {
	var money Money
	if err := wire.Unmarshal([]byte(`{"amount":2.5,"currency":"EUR"}`), &money); err != nil {
		t.Fatal(err)
	}
	out, err := wire.Marshal(money)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"amount":2.50,"currency":"EUR"}` {
		t.Errorf("Money viaja como %s", out)
	}
	if err := wire.Unmarshal([]byte(`{"amount":-1,"currency":"EUR"}`), &money); !errors.Is(err, ErrInvalidValue) {
		t.Errorf("un Money negativo por el cable: se esperaba ErrInvalidValue, llegó %v", err)
	}
}

func TestProbeEnumRejectsUnknownValue(t *testing.T) {
	if _, err := ParseProductStatus("archived"); !errors.Is(err, ErrInvalidValue) {
		t.Errorf("ParseProductStatus(archived): se esperaba ErrInvalidValue, llegó %v", err)
	}
	var status ProductStatus
	if err := wire.Unmarshal([]byte(`"active"`), &status); err != nil || status != ProductStatusActive {
		t.Errorf("leer \"active\": %v, %q", err, status)
	}
	if err := wire.Unmarshal([]byte(`"ACTIVE"`), &status); err == nil {
		t.Error("el enum viaja por su valor: ACTIVE no lo es")
	}
}

func TestProbeFormatIsAnchored(t *testing.T) {
	for _, tt := range []struct {
		value string
		ok    bool
	}{
		{"ABC-1234", true},
		{"", true},
		{"abc-1234", false},
		{"ABC-1234\n", false},
		{"xABC-1234", false},
	} {
		err := SKUFormat.Validate(tt.value)
		if tt.ok && err != nil {
			t.Errorf("%q: %v", tt.value, err)
		}
		if !tt.ok && !errors.Is(err, ErrValueFormat) {
			t.Errorf("%q: se esperaba ErrValueFormat, llegó %v", tt.value, err)
		}
	}
}

func TestProbeTransitionGuard(t *testing.T) {
	draft := RehydrateProduct(ProductState{Status: ProductStatusDraft})
	if err := draft.transitionTo(ProductStatusActive); err != nil || draft.Status() != ProductStatusActive {
		t.Fatalf("DRAFT → ACTIVE: %v, %s", err, draft.Status())
	}
	retired := RehydrateProduct(ProductState{Status: ProductStatusRetired})
	err := retired.transitionTo(ProductStatusActive)
	if !errors.Is(err, ErrInvalidStateTransition) {
		t.Fatalf("RETIRED → ACTIVE: se esperaba ErrInvalidStateTransition, llegó %v", err)
	}
	if got := asDomain(t, err); got.Code() != "INVALID_STATE_TRANSITION" || got.Status() != 409 {
		t.Errorf("code %s y status %d, se esperaba INVALID_STATE_TRANSITION y 409", got.Code(), got.Status())
	}
	if retired.Status() != ProductStatusRetired {
		t.Errorf("una transición negada cambió el estado a %s", retired.Status())
	}
}

func TestProbeSentinelsAreDistinguished(t *testing.T) {
	err := Errorf(ErrProductNotFound, "no existe el producto %s", "p-1")
	if !errors.Is(err, ErrProductNotFound) {
		t.Error("errors.Is no reconoce su centinela")
	}
	if errors.Is(err, ErrSkuAlreadyExists) {
		t.Error("errors.Is confunde dos centinelas")
	}
	got := asDomain(t, err)
	if got.Code() != "PRODUCT_NOT_FOUND" || got.Status() != 404 || got.Kind() != KindNotFound || got.Message() != "no existe el producto p-1" {
		t.Errorf("%s %d %v %q", got.Code(), got.Status(), got.Kind(), got.Message())
	}
}

func TestProbeStateIsCopied(t *testing.T) {
	version := int64(3)
	product := RehydrateProduct(ProductState{LockVersion: &version})
	*product.LockVersion() = 99
	if *product.LockVersion() != 3 {
		t.Error("el accesor de un campo opcional deja cambiar el estado por la espalda")
	}
}
