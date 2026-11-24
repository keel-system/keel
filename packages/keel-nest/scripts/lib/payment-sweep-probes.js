// El reclamo del barrido de pagos (G11 de PLAN-CORRIDAS-GELSA.md) sobre DOCUMENTOS: los casos PS-1 a PS-7 del bloque de
// db-check, contra un MongoDB real, sobre payment-checkout-mongo (keel-core/test/helpers/payment-designs.js). El reclamo es
// un findOneAndUpdate por candidato, así que la siembra y la lectura van por la colección cruda: el estado y el reloj se
// fijan con las claves del documento (documentShape) y el estado con la constante que guarda el adaptador.

import { documentShape } from '@keel-system/keel-core/gen/document';
import { screamingSnake } from '@keel-system/keel-core/gen/naming';
import { repositoryRoots, adapterClass } from '../../src/scaffold/repositories.js';
import { sampleEntity } from './samples.js';
import { adapterArgs } from './document-store-probes.js';

// Los sabotajes, con la forma del adaptador documental: [sufijo del archivo, texto, sustituto].
export const PAYMENT_SWEEP_DOCUMENT_SABOTAGES = {
  // El reclamo no renueva el reloj: lo deja rancio.
  'payment-sweep-no-lease': ['payment-repository-impl.ts', "{ $set: { 'awaiting_since': leasedAt } }", "{ $set: { 'awaiting_since': new Date(staleBefore.getTime() - 1000) } }"],
  // La cota se va al futuro: todo lo que espera es candidato, también lo recién reclamado.
  'payment-sweep-cutoff': ['payment-repository-impl.ts', "'awaiting_since': { $lt: staleBefore }", "'awaiting_since': { $lt: new Date(Date.now() + 86_400_000) }"]
};

// Los casos PS que tira cada uno. En documental el reclamo es un BUCLE de findOneAndUpdate: sin renovar el reloj (o con
// la cota en el futuro), cada vuelta vuelve a casar con el MISMO documento, así que también caen el que cuenta un cobro
// por estado (PS-4) y la carrera (PS-7), que en relacional, con una sola consulta por pasada, no lo ven.
export const PAYMENT_SWEEP_DOCUMENT_SABOTAGE_CASES = {
  'payment-sweep-no-lease': ['PS-1', 'PS-4', 'PS-7'],
  'payment-sweep-cutoff': ['PS-1', 'PS-2', 'PS-4', 'PS-7']
};

export function documentPaymentSweepBlock(model, ctx) {
  const payments = model.payments;
  if (!payments?.reconciliation?.sweep) return '';
  const root = repositoryRoots(model).find((entity) => entity.name === payments.record.entity);
  if (!root?.lifecycle) return '';
  const { enumType, field } = root.lifecycle;
  const keyOf = (member) => documentShape(model, root).find((entry) => entry.member === member || entry.field?.name === member)?.name ?? member;
  const statusKey = keyOf(field);
  const stampKey = keyOf(payments.record.awaitingSince);
  const awaiting = new Set(payments.awaitingStates);
  const enumDef = model.enums.find((candidate) => candidate.name === enumType);
  const stored = (literal) => JSON.stringify(enumDef.values.find((value) => value.literal === literal)?.constant ?? screamingSnake(literal));
  const other = enumDef.values.find((value) => !awaiting.has(value.literal));
  const waiting = payments.awaitingStates.map(stored);
  const samples = Array.from({ length: 24 }, (_, i) => `() => ${sampleEntity(model, root, ctx, `sweep${i}`)}`);
  const args = adapterArgs(model, root);
  return `
// ═══ Reclamo del barrido de pagos (G11), sobre documentos: ${root.name}.claimForPaymentSweep ═══
{
  const SAMPLES = [
    ${samples.join(',\n    ')}
  ];
  let next = 0;
  const payments = database.collection(${JSON.stringify(root.collectionName)});
  const adapter = () => new ${adapterClass(root)}(${args});
  const replica = () => new ${adapterClass(root)}(${args.replace(/^tx\b/, 'new TransactionContext(client, settings)')});
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);
  // Aparca todo documento en un estado que el barrido no busca: cada caso empieza limpio.
  const park = () => payments.updateMany({}, { $set: { ${JSON.stringify(statusKey)}: ${other ? stored(other.literal) : waiting[0]} } });
  const row = async (state, at) => {
    const saved = await adapter().save(SAMPLES[next++]());
    await payments.updateOne({ _id: new UUID(saved.id).toBinary() }, { $set: { ${JSON.stringify(statusKey)}: state, ${JSON.stringify(stampKey)}: at } });
    return saved.id;
  };
  const raw = (id) => payments.findOne({ _id: new UUID(id).toBinary() });
  {
    await park();
    const stale = await row(${waiting[0]}, minutesAgo(60));
    const cutoff = minutesAgo(10);
    const claimed = await adapter().claimForPaymentSweep(cutoff, 10);
    const after = await raw(stale);
    check('PS-1: el reclamo se lleva lo rancio, sin mover el estado y con el reloj renovado',
      claimed.length === 1 && claimed[0].id === stale && after[${JSON.stringify(statusKey)}] === ${waiting[0]} && after[${JSON.stringify(stampKey)}].getTime() > cutoff.getTime() &&
        (await adapter().claimForPaymentSweep(cutoff, 10)).length === 0,
      JSON.stringify({ claimed: claimed.map((e) => e.id), state: after[${JSON.stringify(statusKey)}], stamp: after[${JSON.stringify(stampKey)}] }));
  }
  {
    await park();
    await row(${waiting[0]}, new Date());
    check('PS-2: no se lleva lo recién puesto en espera', (await adapter().claimForPaymentSweep(minutesAgo(10), 10)).length === 0);
  }
${other ? `  {
    await park();
    await row(${stored(other.literal)}, minutesAgo(60));
    check('PS-3: no toca un cobro que no espera a la pasarela', (await adapter().claimForPaymentSweep(minutesAgo(10), 10)).length === 0);
  }
` : ''}  {
    await park();
    for (const state of [${waiting.join(', ')}]) await row(state, minutesAgo(60));
    const claimed = await adapter().claimForPaymentSweep(minutesAgo(10), 50);
    check('PS-4: cubre cada estado en espera', claimed.length === ${waiting.length}, String(claimed.length));
  }
  {
    await park();
    for (let i = 0; i < 3; i++) await row(${waiting[0]}, minutesAgo(60 + i));
    check('PS-5: el lote va acotado por su argumento', (await adapter().claimForPaymentSweep(minutesAgo(10), 2)).length === 2);
  }
  {
    await park();
    // $lt no casa con un reloj nulo: el documento no entra en ningún lote.
    await row(${waiting[0]}, null);
    check('PS-6: un cobro en espera sin reloj no lo recoge nadie', (await adapter().claimForPaymentSweep(minutesAgo(10), 10)).length === 0);
  }
  {
    await park();
    const raced = [];
    for (let i = 0; i < 6; i++) raced.push(await row(${waiting[0]}, minutesAgo(60 + i)));
    const [a, b] = await Promise.all([replica().claimForPaymentSweep(minutesAgo(10), 6), replica().claimForPaymentSweep(minutesAgo(10), 6)]);
    const both = [...a, ...b].map((e) => e.id);
    check('PS-7: dos réplicas a la vez no se llevan el mismo cobro, y entre las dos se llevan todos',
      new Set(both).size === both.length && [...both].sort().join() === [...raced].sort().join(), \`\${a.length} + \${b.length}\`);
  }
}`;
}
