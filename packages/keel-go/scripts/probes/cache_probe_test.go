// La sonda de cache-check: el store (internal/infrastructure/cache) y la caché (application.OperationCache) que emite
// keel-go para catalog-extended, contra un Redis o un Valkey REAL. La copia scripts/cache-check.js en
// internal/infrastructure/cache del proyecto generado (con __MODULE__ sustituido) y la ejecuta con -run TestCacheProbe.
//
// Sus pasos tienen orden (el store se pausa y vuelve), así que es UNA prueba que escribe una línea por paso:
// «OK   <paso>» o «FALLA <paso> — <detalle>». El script las lee.

package cache_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"__MODULE__/internal/application"
	"__MODULE__/internal/infrastructure/cache"
	"__MODULE__/internal/platform/wire"
)

// sampleJSON es una ficha con cada campo puesto, en el orden del cable; productCost se omite (nulls: omit).
const sampleJSON = `{"id":"0190f3a2-6c1e-7b3d-9a4f-2b8c1d0e5f61","sku":"SKU-1","name":"Silla","status":"active","version":3,` +
	`"createdAt":"2026-01-02T03:04:05.006Z","categoryId":"0190f3a2-6c1e-7b3d-9a4f-2b8c1d0e5f62",` +
	`"images":[{"id":"0190f3a2-6c1e-7b3d-9a4f-2b8c1d0e5f63","storageKey":"img/1.png","position":1,"primary":true,` +
	`"productId":"0190f3a2-6c1e-7b3d-9a4f-2b8c1d0e5f61"}],"currentPrice":{"amount":12.50,"currency":"EUR"}}`

// commandTimeout es el plazo de cada orden en la sonda: con el store sin contestar, la lectura tiene que ir al origen en
// él (un reintento lo multiplicaría).
const commandTimeout = time.Second

func TestCacheProbe(t *testing.T) {
	port, err := strconv.Atoi(os.Getenv("CACHE_CHECK_PORT"))
	if err != nil {
		t.Fatalf("CACHE_CHECK_PORT: %v", err)
	}
	runtime, container, flush, service := os.Getenv("CACHE_CHECK_RUNTIME"), os.Getenv("CACHE_CHECK_CONTAINER"), os.Getenv("CACHE_CHECK_FLUSH"), os.Getenv("CACHE_CHECK_SERVICE")
	ctx := t.Context()
	failed := false
	report := func(step string, ok bool, detail string) {
		if ok {
			fmt.Printf("OK    %s\n", step)
			return
		}
		failed = true
		fmt.Printf("FALLA %s — %s\n", step, detail)
	}
	cli := func(args ...string) string {
		out, err := exec.CommandContext(ctx, runtime, append([]string{"exec", container, "redis-cli"}, args...)...).CombinedOutput()
		if err != nil {
			return "error: " + err.Error() + ": " + string(out)
		}
		return strings.TrimSpace(string(out))
	}
	toggle := func(verb string) error {
		out, err := exec.CommandContext(ctx, runtime, verb, container).CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s %s: %w: %s", runtime, verb, err, out)
		}
		return nil
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	store := cache.NewStore(cache.Settings{Enabled: true, Host: "127.0.0.1", Port: port, ConnectTimeout: commandTimeout, CommandTimeout: commandTimeout}, logger)
	defer func() { _ = store.Close() }()
	operationCache := application.NewOperationCache(store, logger)

	var sample application.GetProductBySlugResponseDto
	if err := wire.Unmarshal([]byte(sampleJSON), &sample); err != nil {
		t.Fatalf("la muestra no se lee: %v", err)
	}
	want, err := wire.Marshal(sample)
	if err != nil {
		t.Fatal(err)
	}
	var loads atomic.Int32
	load := func(context.Context) (application.GetProductBySlugResponseDto, error) {
		loads.Add(1)
		return sample, nil
	}
	query := func(slug string) application.GetProductBySlugQuery { return application.GetProductBySlugQuery{Slug: slug} }
	entry := application.EntryKey(application.GetProductBySlugCache, "sillas")

	// 1. Un fallo carga y guarda: la entrada en el servidor, con su clave, su TTL y el JSON del cable.
	first, err := application.GetOrLoad(ctx, operationCache, application.GetProductBySlugCache, query("sillas"), load)
	report("un fallo va al origen", err == nil && loads.Load() == 1, fmt.Sprintf("err %v, %d cargas", err, loads.Load()))
	report("la entrada se llama <servicio>:<operación>::<clave>", entry == service+":get-product-by-slug::sillas", entry)
	stored := cli("GET", entry)
	report("la entrada guarda el JSON del cable, decimal con su escala", stored == string(want) && strings.Contains(stored, `"amount":12.50`), stored)
	ttl, _ := strconv.Atoi(cli("TTL", entry))
	report("la entrada caduca con el TTL del diseño (300 s)", ttl > 290 && ttl <= 300, fmt.Sprintf("TTL %d", ttl))

	// 2. Un acierto no vuelve al origen y sale igual en el cable.
	second, err := application.GetOrLoad(ctx, operationCache, application.GetProductBySlugCache, query("sillas"), load)
	got, _ := wire.Marshal(second)
	firstJSON, _ := wire.Marshal(first)
	report("un acierto no vuelve al origen", err == nil && loads.Load() == 1, fmt.Sprintf("err %v, %d cargas", err, loads.Load()))
	report("el acierto es byte a byte la respuesta del origen", string(got) == string(firstJSON), string(got))

	// 3. Vaciar una caché no toca las demás ni las de otro servicio.
	cli("SET", service+":otra::x", "{}")
	cli("SET", "otro-servicio:get::x", "{}")
	operationCache.Clear(ctx, application.GetProductBySlugCache)
	report("Clear vacía su caché", cli("EXISTS", entry) == "0", cli("EXISTS", entry))
	report("Clear no toca otra caché ni otro servicio", cli("EXISTS", service+":otra::x") == "1" && cli("EXISTS", "otro-servicio:get::x") == "1", "")

	// 4. La orden de infra/reset-db.sh borra lo de este servicio y nada más.
	out, err := exec.CommandContext(ctx, runtime, "exec", container, "sh", "-c", flush).CombinedOutput()
	report("la orden de reset-db.sh corre", err == nil, string(out))
	report("reset-db.sh borra las claves del servicio", cli("EXISTS", service+":otra::x") == "0", "")
	report("reset-db.sh no toca las de otro servicio", cli("EXISTS", "otro-servicio:get::x") == "1", "")
	cli("DEL", "otro-servicio:get::x")

	// 5. Con el store sin contestar, la lectura va al origen en el plazo de una orden.
	if err := toggle("pause"); err != nil {
		report("el store se pausa", false, err.Error())
	} else {
		before := loads.Load()
		started := time.Now()
		down, err := application.GetOrLoad(ctx, operationCache, application.GetProductBySlugCache, query("sillas"), load)
		elapsed := time.Since(started)
		report("con el store sin contestar, la lectura va al origen", err == nil && loads.Load() == before+1 && down.Sku == "SKU-1", fmt.Sprintf("err %v", err))
		// Una lectura y una escritura, cada una con su plazo: el doble del plazo de una orden, más margen.
		report("y no espera más que el plazo de sus órdenes", elapsed < 2*commandTimeout+time.Second, elapsed.String())
		if err := toggle("unpause"); err != nil {
			report("el store vuelve", false, err.Error())
		}
	}

	// 6. Con el store de vuelta, la caché vuelve a guardar sin reiniciar nada.
	back := application.EntryKey(application.GetProductBySlugCache, "mesas")
	var stored6 string
	for attempt := 0; attempt < 20 && stored6 != string(want); attempt++ {
		_, _ = application.GetOrLoad(ctx, operationCache, application.GetProductBySlugCache, query("mesas"), load)
		stored6 = cli("GET", back)
		if stored6 != string(want) {
			time.Sleep(250 * time.Millisecond)
		}
	}
	report("con el store de vuelta, la caché vuelve a guardar sin reiniciar nada", stored6 == string(want), stored6)
	cli("DEL", back)

	if failed {
		t.Fail()
	}
}
