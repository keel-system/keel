// La SELECCIÓN de un barrido: qué filas reclama cuando el estado no basta para decirlo.
//
// Nació de la corrida room-booking (R8). Su barrido `expireOffers` mueve DOS entidades, sale
// del mismo estado por dos transiciones (`waiting → lapsed` cuando el intervalo empieza,
// `waiting → offered` por la promoción) y caduca ofertas que son una ESPERA con plazo —la
// decisión de un empleado—, no trabajo a medias de una réplica. Build reclamaba por
// transición y sin predicado: habría caducado ofertas vigentes y cerrado esperas vivas. El
// agente reescribió nueve archivos para corregirlo, y ningún escenario lo habría visto hasta
// FL-WTL-005-C. Ninguna fixture tiene esta forma, así que el diseño se construye aquí.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../src/lib/model.js';
import { generate as generateRepositories } from '../src/scaffold/repositories.js';
import { generate as generateDocumentRepositories } from '../src/scaffold/document-repositories.js';
import { generate as generateServices } from '../src/scaffold/services.js';

const manifest = { keel: '2.0', service: { name: 'rooms', version: '0.1.0' }, layers: {} };

function roomBooking({ bookingIndex = true, withEvents = false } = {}) {
  return {
    ...(withEvents
      ? {
          messaging: {
            channels: { bookingEvents: {} },
            publishing: {
              events: {
                OfferExpired: { channel: 'bookingEvents', payload: { bookingId: { type: 'uuid', required: true } } },
                WaitlistEntryLapsed: { channel: 'bookingEvents', payload: { entryId: { type: 'uuid', required: true } } }
              }
            }
          }
        }
      : {}),
    domain: {
      entities: {
        Booking: {
          description: 'Reserva de una sala.',
          fields: {
            id: { type: 'uuid', id: true, generated: true },
            status: { type: 'enum', values: ['offered', 'confirmed', 'expired'] },
            offerExpiresAt: { type: 'timestamp' }
          },
          lifecycle: { field: 'status', transitions: { offered: ['confirmed', 'expired'], confirmed: [], expired: [] } }
        },
        WaitlistEntry: {
          description: 'Espera de un intervalo.',
          fields: {
            id: { type: 'uuid', id: true, generated: true },
            status: { type: 'enum', values: ['waiting', 'offered', 'fulfilled', 'lapsed'] },
            startsAt: { type: 'timestamp' }
          },
          lifecycle: {
            field: 'status',
            transitions: { waiting: ['offered', 'lapsed'], offered: ['fulfilled', 'lapsed'], fulfilled: [], lapsed: [] }
          }
        }
      },
      aggregates: {
        Reservation: { root: 'Booking', entities: [] },
        Waitlist: { root: 'WaitlistEntry', entities: [] }
      }
    },
    'use-cases': {
      operations: {
        // La operación EXPUESTA que saca a la entidad de `offered`: es lo que hace de
        // `offered` una espera con plazo y no un estado en vuelo.
        acceptOffer: {
          description: 'El empleado acepta la oferta.',
          kind: 'command',
          input: { fields: { bookingId: { type: 'uuid', required: true } } },
          output: 'void',
          transitions: [
            { entity: 'Booking', from: ['offered'], to: 'confirmed' },
            { entity: 'WaitlistEntry', from: ['offered'], to: 'fulfilled' }
          ]
        },
        expireOffers: {
          description: 'Caduca las ofertas vencidas y cierra las esperas cuyo intervalo empezó.',
          kind: 'command',
          input: 'void',
          output: 'void',
          schedule: { cron: '* * * * *' },
          ...(withEvents ? { emits: ['OfferExpired', 'WaitlistEntryLapsed'] } : {}),
          transitions: [
            { entity: 'Booking', from: ['offered'], to: 'expired' },
            { entity: 'WaitlistEntry', from: ['waiting'], to: 'lapsed' },
            { entity: 'WaitlistEntry', from: ['waiting'], to: 'offered' },
            { entity: 'WaitlistEntry', from: ['offered'], to: 'lapsed' }
          ]
        }
      }
    },
    persistence: {
      entities: {
        Booking: bookingIndex ? { indexes: [['status', 'offerExpiresAt']] } : {},
        WaitlistEntry: {}
      }
    }
  };
}

const modelFor = (layers, database = 'postgresql') => {
  const stack = { database, broker: 'kafka' };
  const model = buildModel({ manifest, layers, stack });
  model.stack = stack;
  return model;
};

const sweepOf = (model) =>
  model.services.flatMap((service) => service.operations).find((operation) => operation.name === 'expireOffers');

test('el reclamo con índice [estado, plazo] lleva el predicado: solo lo vencido', () => {
  const model = modelFor(roomBooking());
  const bookingClaim = (sweepOf(model).claim ?? []).find((claim) => claim.entity === 'Booking');
  assert.ok(bookingClaim, JSON.stringify(sweepOf(model).claim));
  assert.deepEqual(bookingClaim.due, { field: 'offerExpiresAt' });

  const jpa = generateRepositories(model).find((file) => file.path.endsWith('BookingJpaRepository.java')).content;
  assert.match(jpa, /where e\.status in :states and e\.offerExpiresAt <= :now order by/);
  assert.match(jpa, /where e\.id = :id and e\.status in :states and e\.offerExpiresAt <= :now"/);

  const mongo = modelFor(roomBooking(), 'mongodb');
  const adapter = generateDocumentRepositories(mongo).find((file) => file.path.endsWith('BookingRepositoryImpl.java')).content;
  assert.ok(adapter.includes('.and("offerExpiresAt").lte(now)'), adapter);
});

test('un from repetido en el barrido no se reclama: la regla decide, no el estado', () => {
  const model = modelFor(roomBooking());
  const claims = sweepOf(model).claim ?? [];
  // Ni waiting → lapsed ni waiting → offered: cuál toca a cada fila lo dice una regla.
  assert.ok(!claims.some((claim) => claim.entity === 'WaitlistEntry' && claim.from.includes('waiting')), JSON.stringify(claims));
  assert.ok(
    model.warnings.some((warning) => /expireOffers saca WaitlistEntry de waiting por más de una transición/.test(warning)),
    model.warnings.join('\n')
  );
});

test('una espera con plazo no es un estado en vuelo: sin rescate, y sin predicado no se reclama', () => {
  const model = modelFor(roomBooking());
  const claims = sweepOf(model).claim ?? [];
  // WaitlistEntry.offered lo saca acceptOffer (expuesta): no hay rescate ni aviso de reloj.
  assert.ok(!claims.some((claim) => claim.stalled), JSON.stringify(claims));
  assert.ok(!model.warnings.some((warning) => /offered, que es un estado EN VUELO/.test(warning)), model.warnings.join('\n'));
  // Y su plazo vive en OTRA entidad (Booking.offerExpiresAt): no hay predicado derivable.
  assert.ok(!claims.some((claim) => claim.entity === 'WaitlistEntry'), JSON.stringify(claims));
  assert.ok(
    model.warnings.some((warning) => /expireOffers saca WaitlistEntry de offered y el diseño no deja derivar QUÉ filas tocan/.test(warning)),
    model.warnings.join('\n')
  );
});

test('sin índice del que sacar el plazo, tampoco se genera el reclamo de la oferta', () => {
  const model = modelFor(roomBooking({ bookingIndex: false }));
  assert.ok(!(sweepOf(model).claim ?? []).some((claim) => claim.entity === 'Booking'));
  assert.ok(model.warnings.some((warning) => /expireOffers saca Booking de offered y el diseño no deja derivar/.test(warning)));
});

test('un barrido con reclamo generado se despacha sin transacción abarcadora', () => {
  // El reclamo confirma en su propia transacción antes de devolver el lote: envolver el lote
  // en una única transacción hace que un 409 en una fila revierta las demás y las deje
  // reclamadas a medias. room-booking (R8) lo cambió a mano a dispatchWithoutTransaction.
  const files = generateServices(modelFor(roomBooking()));
  const scheduler = files.find((file) => file.path.endsWith('Scheduler.java') && file.content.includes('ExpireOffersCommand'));
  assert.ok(scheduler, files.map((file) => file.path).join('\n'));
  assert.ok(scheduler.content.includes('mediator.dispatchWithoutTransaction(new ExpireOffersCommand());'), scheduler.content);
});

test('los eventos de un barrido que mueve varias raíces tienen emisor, buffer y drenaje', () => {
  // Sin entidad de grupo, las emisiones quedaban sin agregado y WaitlistEntry salía sin buffer
  // de eventos ni drenaje en su adaptador: el agente los añadió a mano (room-booking, R8).
  const model = modelFor(roomBooking({ withEvents: true }));
  const lapsed = model.events.find((event) => event.name === 'WaitlistEntryLapsed');
  assert.deepEqual([...lapsed.aggregates].sort(), ['Booking', 'WaitlistEntry']);
});
