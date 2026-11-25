// Los diagramas del diseño (`keel describe --diagram`): derivados de las capas, deterministas y sin poder contradecir
// a `keel validate`, que es el oráculo de lo que el diagrama marca como hallazgo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/lib/loader.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';
import { domainDiagram, lifecycleDiagrams, renderDiagramMarkdown } from '../src/lib/domain-diagram.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');
const layersOf = (name) => loadService(path.join(FIXTURES, name)).layers;
const fixtureNames = () => fs.readdirSync(FIXTURES).filter((name) => fs.existsSync(path.join(FIXTURES, name, 'domain.keel.yaml')));

test('el ciclo de vida lleva en cada arista la operación que la ejecuta y el plazo que la dispara', () => {
  const [lifecycle] = lifecycleDiagrams(layersOf('verification-codes'));
  assert.equal(lifecycle.entity, 'VerificationCode');
  assert.equal(
    lifecycle.diagram,
    [
      'stateDiagram-v2',
      '  [*] --> pending',
      '  pending --> verified : verifyCode',
      '  pending --> expired : expireCode, plazo codeTtlMinutes minutes desde issuedAt',
      '  verified --> [*]',
      '  expired --> [*]'
    ].join('\n')
  );
  assert.deepEqual(lifecycle.findings, []);
});

test('un namespace por agregado: composición hacia la hija interna y flecha discontinua entre agregados', () => {
  const { diagram, notes } = domainDiagram(layersOf('catalog-extended'));
  assert.match(diagram, /^ {2}namespace CatalogAggregate \{$/m);
  assert.match(diagram, /^ {4}class Product \{\n {6}<<raíz>>$/m);
  assert.match(diagram, /^ {2}Product "1" \*-- "\*" ProductImage : images$/m);
  assert.match(diagram, /^ {2}ProductImage "\*" --> "1" Product : product$/m);
  assert.match(diagram, /^ {2}Product "\*" \.\.> "1" Category : category$/m);
  assert.match(diagram, /sku: SKU · clave natural, único, requerido/);
  assert.match(diagram, /class ProductStatus \{\n {4}<<enumeration>>/);
  assert.deepEqual(notes, ['Fuera de todo agregado: Category, SupplierPrice.']);
});

test('sin agregados declarados lo dice, y los checks de la entidad van en una nota', () => {
  const { diagram, notes } = domainDiagram(layersOf('shop-api'));
  assert.doesNotMatch(diagram, /namespace/);
  assert.doesNotMatch(diagram, /<<raíz/);
  assert.match(diagram, /^ {2}note for ProductInOrder "checks: exactlyOne cart, order"$/m);
  assert.match(diagram, /email: string · clave natural, único, requerido/);
  assert.deepEqual(notes, ['El dominio no declara agregados: cada entidad es su propia frontera de consistencia.']);
});

test('las aristas «sin operación» son exactamente las que avisa CHK-DOMAIN-TRANSITION-UNEXECUTED, en todas las fixtures', () => {
  for (const name of fixtureNames()) {
    const layers = layersOf(name);
    const fromValidate = checkCrossRefs({ layers })
      .findings.filter((finding) => finding.id === 'CHK-DOMAIN-TRANSITION-UNEXECUTED')
      .map((finding) => {
        const [, entity, from, to] = finding.message.match(/domain: (\w+)\.lifecycle\.transitions\.\w+: .*'(\w+)' → '(\w+)'/);
        return `${entity}|${from}|${to}`;
      })
      .sort();
    const fromDiagram = lifecycleDiagrams(layers)
      .flatMap((lifecycle) =>
        [...lifecycle.diagram.matchAll(/^ {2}(\w+) --> (\w+) : sin operación$/gm)].map(([, from, to]) => `${lifecycle.entity}|${from}|${to}`)
      )
      .sort();
    assert.deepEqual(fromDiagram, fromValidate, name);
  }
});

test('marca el estado inalcanzable y el valor del enum que la máquina no menciona', () => {
  const layers = {
    domain: {
      types: { Status: { values: ['open', 'closed', 'lost', 'orphan'] } },
      entities: {
        Ticket: {
          fields: { id: { type: 'uuid', id: true }, status: { type: 'Status', required: true, default: 'open' } },
          lifecycle: { field: 'status', transitions: { open: ['closed'], closed: [], lost: ['closed'] } }
        }
      }
    },
    'use-cases': {
      operations: {
        closeTicket: { kind: 'command', transitions: [{ entity: 'Ticket', from: ['open', 'lost'], to: 'closed' }] }
      }
    }
  };
  const [lifecycle] = lifecycleDiagrams(layers);
  assert.match(lifecycle.diagram, /^ {2}note right of lost : inalcanzable$/m);
  assert.match(lifecycle.diagram, /^ {2}note right of orphan : fuera del ciclo$/m);
  assert.deepEqual(lifecycle.findings, [
    'lost: ninguna cadena de transiciones llega a él desde el estado inicial open.',
    'orphan: valor del enum que la máquina de estados no menciona (CHK-DOMAIN-STATE-NO-TRANSITIONS).'
  ]);
});

test('sin lifecycle no hay diagrama de estados, y una comilla no rompe la etiqueta', () => {
  const layers = {
    domain: {
      entities: {
        Note: { fields: { id: { type: 'uuid', id: true } }, checks: [{ requires: 'id', description: 'x' }, { forbids: 'a"b' }] }
      }
    }
  };
  assert.deepEqual(lifecycleDiagrams(layers), []);
  assert.match(domainDiagram(layers).diagram, /note for Note "checks: requires id \| forbids a'b"/);
  assert.doesNotMatch(renderDiagramMarkdown(layers), /Ciclo de vida/);
});

test('es determinista: dos derivaciones del mismo diseño dan el mismo texto', () => {
  for (const name of fixtureNames()) {
    assert.equal(renderDiagramMarkdown(layersOf(name)), renderDiagramMarkdown(layersOf(name)), name);
  }
});
