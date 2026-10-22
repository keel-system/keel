import { imageFacts, parseImage } from './images.js';

// Los criterios del juez que se deciden LEYENDO el sandbox, sin arrancarlo. Van primero porque
// no cuestan nada y porque uno de ellos (la red interna) es la única defensa que no depende de
// que haya internet: en una máquina sin red, la sonda de egreso saldría verde por la razón
// equivocada.

export const CI_SYSTEMS = new Set(['travis', 'circleci', 'github-actions', 'gitlab-ci', 'bitbucket']);

// Tecnologías de imagen que son un MOTOR: su versión importa (inc. 1: la app arrancaba sana y
// mentía con el motor equivocado). Los stubs, el correo y la traza no.
const ENGINE_TECHS = new Set(['mongodb', 'postgresql', 'mysql', 'mariadb', 'sqlserver', 'oracle', 'redis', 'valkey', 'rabbitmq', 'kafka', 'activemq', 'elasticsearch', 'cassandra', 'memcached']);

const criterion = (id, ok, detail) => ({ id, ok: Boolean(ok), detail });

export function staticCriteria(sandbox) {
  const { spec, compose } = sandbox;
  const services = compose.services ?? {};
  const out = [];

  // Los servicios que el juez usa existen y tienen nombre fijo de contenedor.
  const used = [spec.app.service, spec.tool.service, ...(spec.database ? [spec.database.service] : [])];
  const missing = used.filter((s) => !services[s]);
  const unnamed = used.filter((s) => services[s] && !services[s].container_name);
  out.push(
    criterion(
      'VER-COMPOSE',
      missing.length === 0 && unnamed.length === 0,
      missing.length ? `servicios que sandbox.yaml nombra y el compose no tiene: ${missing.join(', ')}` : unnamed.length ? `sin container_name: ${unnamed.join(', ')}` : 'app, herramienta y base declaradas'
    )
  );

  // Red interna: toda red que use un servicio, interna; nada de red del host ni red por defecto.
  const networks = compose.networks ?? {};
  const leaks = [];
  for (const [name, svc] of Object.entries(services)) {
    if (svc.network_mode) {
      leaks.push(`${name} usa network_mode: ${svc.network_mode}`);
      continue;
    }
    const nets = Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks ?? {});
    if (nets.length === 0) leaks.push(`${name} va en la red por defecto del compose, que sale a internet`);
    for (const n of nets) {
      if (!networks[n]) leaks.push(`${name} usa la red ${n}, que el compose no declara`);
      else if (networks[n].internal !== true) leaks.push(`la red ${n} (de ${name}) no es internal: true`);
    }
  }
  out.push(criterion('VER-NET-INTERNAL', leaks.length === 0, leaks.length ? leaks.join('; ') : 'todas las redes son internal: true'));

  // Imágenes por digest y sin build en el compose del runtime.
  const unpinned = Object.entries(services).filter(([, s]) => s.image && !parseImage(s.image).pinned && !isLocalImage(s.image)).map(([n, s]) => `${n} (${s.image})`);
  const noImage = Object.entries(services).filter(([, s]) => !s.image).map(([n]) => n);
  out.push(criterion('VER-DIGEST', unpinned.length === 0 && noImage.length === 0, unpinned.length ? `imágenes sin digest: ${unpinned.join(', ')}` : noImage.length ? `servicios sin imagen: ${noImage.join(', ')}` : 'todas fijadas por digest'));
  const builds = Object.entries(services).filter(([, s]) => s.build).map(([n]) => n);
  out.push(criterion('VER-NO-BUILD', builds.length === 0, builds.length ? `el compose construye ${builds.join(', ')}: el build va aparte, con red, y el runtime solo ejecuta` : 'el compose solo ejecuta'));

  out.push(engineCriterion(sandbox));
  return out;
}

// La imagen que construye build.sh se queda en el almacén local (`recover/<legacy>:sandbox`): no
// tiene digest de registro, y no hace falta, porque sale de un Dockerfile cuyas bases sí lo tienen.
function isLocalImage(ref) {
  const repo = parseImage(ref).repo;
  return repo.startsWith('recover/') || repo.startsWith('localhost/recover/');
}

/**
 * La versión de cada motor del compose, cruzada con la que declara la CI del repo (runtime.yaml).
 * Si la CI no la declara, o el sandbox usa otra, tiene que haber una adaptación escrita que la
 * nombre: «nunca la última por defecto» (plan, paso 0c).
 */
export function engineCriterion(sandbox) {
  const services = sandbox.compose.services ?? {};
  const declared = (sandbox.runtime?.services ?? []).filter((s) => CI_SYSTEMS.has(s.via) && s.version);
  const adaptations = sandbox.environment?.adaptations ?? [];
  const problems = [];
  const notes = [];
  for (const [name, svc] of Object.entries(services)) {
    if (!svc.image) continue;
    const fact = imageFacts(svc.image).find((f) => f.what === 'service' && ENGINE_TECHS.has(f.name));
    if (!fact) continue;
    const img = parseImage(svc.image);
    const version = fact.version;
    const ci = declared.filter((d) => d.tech === fact.name);
    const justified = adaptations.some((a) => mentions(a.what, img, version));
    if (ci.length && ci.some((d) => compatible(d.version, version))) {
      notes.push(`${name}: ${fact.name} ${version} = la de la CI (${ci[0].evidence})`);
    } else if (justified) {
      notes.push(`${name}: ${fact.name} ${version ?? img.tag} justificado en environment.yaml`);
    } else if (ci.length) {
      problems.push(`${name}: ${fact.name} ${version ?? img.tag ?? 'latest'} y la CI declara ${ci.map((d) => `${d.version} (${d.evidence})`).join(', ')}, sin adaptación que lo justifique`);
    } else {
      problems.push(`${name}: ${fact.name} ${version ?? img.tag ?? 'latest'} sin versión en la CI ni adaptación en environment.yaml que diga por qué esa`);
    }
  }
  return criterion('VER-ENGINE', problems.length === 0, problems.length ? problems.join('; ') : notes.join('; ') || 'sin motores en el sandbox');
}

// `3.4` y `3.4.9` son compatibles; `3.6` y `3.4.9`, no.
function compatible(a, b) {
  if (!a || !b) return false;
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const n = Math.min(pa.length, pb.length);
  return pa.slice(0, n).join('.') === pb.slice(0, n).join('.');
}

function mentions(text, img, version) {
  const t = String(text ?? '').toLowerCase();
  const name = img.name.toLowerCase();
  const tag = String(img.tag ?? version ?? '').toLowerCase();
  return t.includes(`${name}:${tag}`) || (version && t.includes(name) && t.includes(String(version)));
}
