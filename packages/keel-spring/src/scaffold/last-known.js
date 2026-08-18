// Almacén del último valor conocido de una llamada saliente: el mecanismo de
// `dependencies.needs.<n>.onUnavailable.action: lastKnown`.
//
// Existe porque el diseño puede decir «si el proveedor no contesta, sirve el último
// valor que llegaste a leer» — y eso, sin cota, no tiene final: un precio de hace tres
// días se sirve igual que uno de hace un minuto. Por eso el DSL exige `maxAgeSeconds`
// junto al `error` que cierra la ventana, y por eso el que aplica los dos es este
// módulo y no el agente. En una corrida real, con la política escrita solo como prosa
// en el `fallback` de la llamada, lo que salió fue un `ConcurrentHashMap` sin
// expiración.
//
// En memoria a propósito, y no sobre la caché del stack: el fallback tiene que seguir
// sirviendo con el proveedor caído Y con la caché caída, y lo que promete es «lo último
// que ESTA instancia llegó a ver». Una caché compartida prometería otra cosa —lo último
// que vio cualquiera— y añadiría una dependencia más al camino de degradación, que es
// justo el que no puede tener dependencias nuevas.

import { javaFile, javaPath, subPackage } from './render.js';

const HTTP_PKG = 'infrastructure.http';

/** Los needs que declaran `lastKnown`, con la llamada por la que se resuelven. */
export function lastKnownNeeds(model) {
  const found = [];
  for (const dependency of model.dependencies ?? []) {
    for (const need of dependency.needs ?? []) {
      if (need.onUnavailable?.action !== 'lastKnown') continue;
      if (!need.fetch) continue;
      found.push({ dependency: dependency.id, need });
    }
  }
  return found;
}

/** ¿Alguna llamada de ESTE cliente sirve un need con `lastKnown`? */
export function clientRemembers(model, client) {
  return lastKnownNeeds(model).some(({ need }) => need.fetch.clientId === client.id);
}

/** ¿La llamada concreta es la que resuelve un need con `lastKnown`? */
export function callPolicy(model, client, call) {
  const match = lastKnownNeeds(model).find(
    ({ need }) => need.fetch.clientId === client.id && need.fetch.call === call.name
  );
  return match ?? null;
}

export function generate(model) {
  if (lastKnownNeeds(model).length === 0) return [];
  return [renderStore(model)];
}

function renderStore(model) {
  const body = `/**
 * Último valor conocido de cada llamada saliente, para la política
 * {@code onUnavailable: lastKnown} del diseño.
 *
 * <p><b>Acotado por edad y por tamaño, y las dos cotas importan.</b> La edad la declara
 * el diseño ({@code maxAgeSeconds} del need) y se aplica al LEER: pasado ese tiempo el
 * valor deja de existir para quien pregunta, y el fallback lanza el error declarado en
 * vez de servir algo que ya no significa nada. El tamaño lo pone este almacén: la clave
 * la forman los parámetros de la llamada, así que un catálogo grande produce tantas
 * entradas como recursos distintos se consulten, y sin tope eso es una fuga de memoria
 * lenta que solo se manifiesta en producción.
 *
 * <p>En memoria y por instancia a propósito: lo que promete es «lo último que ESTE
 * proceso llegó a leer». Ponerlo sobre la caché compartida prometería otra cosa y
 * metería una dependencia más justo en el camino que se recorre cuando algo ya está
 * caído.
 */
@Component
public class LastKnownValues {

    /** Tope de entradas vivas. Ver el javadoc de la clase: la clave la forman los parámetros. */
    private static final int MAX_ENTRIES = 10_000;

    private final Map<String, Entry> entries = new ConcurrentHashMap<>();

    /**
     * Recuerda lo que la llamada acaba de devolver. Se invoca en el camino FELIZ del
     * adaptador: si solo se escribiera al fallar no habría nada que recordar.
     */
    public void remember(String scope, Object key, Object value) {
        if (value == null) {
            return;
        }
        if (entries.size() >= MAX_ENTRIES) {
            evictOldest();
        }
        entries.put(entryKey(scope, key), new Entry(value, Instant.now()));
    }

    /**
     * El último valor de esa llamada si aún está dentro de {@code maxAge}; vacío si no
     * hay ninguno o si el que hay ya es demasiado viejo para servirlo.
     *
     * <p>El caducado se borra al detectarlo: seguir ocupando sitio con algo que ya nunca
     * se va a devolver es lo que hace que el tope de tamaño expulse valores útiles.
     */
    public <T> Optional<T> recall(String scope, Object key, Duration maxAge, Class<T> type) {
        String id = entryKey(scope, key);
        Entry entry = entries.get(id);
        if (entry == null) {
            return Optional.empty();
        }
        if (Duration.between(entry.storedAt(), Instant.now()).compareTo(maxAge) > 0) {
            entries.remove(id);
            return Optional.empty();
        }
        return Optional.of(type.cast(entry.value()));
    }

    private static String entryKey(String scope, Object key) {
        return scope + "|" + key;
    }

    /** Deja sitio tirando las entradas más viejas, que son las que menos van a servir. */
    private void evictOldest() {
        entries.entrySet().stream()
                .sorted(Comparator.comparing(entry -> entry.getValue().storedAt()))
                .limit(Math.max(1, entries.size() - (MAX_ENTRIES * 3 / 4)))
                .map(Map.Entry::getKey)
                .toList()
                .forEach(entries::remove);
    }

    private record Entry(Object value, Instant storedAt) {
    }
}`;
  return {
    path: javaPath(model, HTTP_PKG, 'LastKnownValues'),
    content: javaFile(
      subPackage(model, HTTP_PKG),
      [
        'java.time.Duration',
        'java.time.Instant',
        'java.util.Comparator',
        'java.util.Map',
        'java.util.Optional',
        'java.util.concurrent.ConcurrentHashMap',
        'org.springframework.stereotype.Component'
      ],
      body
    )
  };
}
