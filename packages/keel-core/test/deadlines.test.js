// Los plazos de negocio sobre el estado (DSL 2.26, lifecycle.deadlines). Las seis reglas mecánicas las falsa el corpus de
// mutaciones (extensión `deadline` de test/design-mutations/catalog.js); aquí, lo que el corpus no ve: cuándo aplica la
// revisión.

import test from 'node:test';
import assert from 'node:assert/strict';
import { applicableReviews } from '../src/lib/reviews.js';
import { declaredDeadlines } from '../src/lib/gen/deadlines.js';

const withDeadline = () => ({
  domain: {
    entities: {
      Reservation: {
        fields: { id: { type: 'uuid', id: true }, status: { type: 'string' }, heldAt: { type: 'timestamp' } },
        lifecycle: {
          field: 'status',
          transitions: { pending: ['confirmed', 'expired'], confirmed: [], expired: [] },
          deadlines: { pending: { after: { seconds: 900 }, since: 'heldAt', to: 'expired', by: 'expireReservation', lateAction: 'allow' } }
        }
      }
    }
  }
});

test('declaredDeadlines da un plazo por estado de origen, con su entidad', () => {
  const [deadline, ...rest] = declaredDeadlines(withDeadline());
  assert.deepEqual(rest, []);
  assert.equal(deadline.entityName, 'Reservation');
  assert.equal(deadline.state, 'pending');
  assert.equal(deadline.deadline.by, 'expireReservation');
  assert.deepEqual(declaredDeadlines({ domain: { entities: { Reservation: { lifecycle: { transitions: {} } } } } }), []);
});

test('REV-DOMAIN-DEADLINE-SINCE solo aplica a un diseño con algún plazo', () => {
  assert.ok(applicableReviews(withDeadline()).includes('REV-DOMAIN-DEADLINE-SINCE'));
  const without = withDeadline();
  delete without.domain.entities.Reservation.lifecycle.deadlines;
  assert.ok(!applicableReviews(without).includes('REV-DOMAIN-DEADLINE-SINCE'));
});
