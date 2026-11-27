import { defineInstrumentation } from 'eve/instrumentation';
import {
  recordModelCallSettled,
  recordModelCallStarted,
} from '../lib/context/capture';

/**
 * Records the *final* model input of every persona turn.
 *
 * The provider receives the AI SDK's prepared instructions and messages right
 * before the provider call, so this is the exact context the model saw — not a
 * reconstruction from the same sources. `recordModelCallStarted` keeps the
 * first call of a turn (the answer's context); the `turn.settled` hook posts it
 * to Nest.
 *
 * `recordInputs: true` is deliberate: this is a local single-user deployment
 * and the snapshot is the feature. Outputs stay out of the provider: only the
 * token usage is needed.
 */
export default defineInstrumentation({
  tracePolicy: () => ({
    emit: true,
    recordInputs: true,
    recordOutputs: false,
  }),
  events: {
    'model.call.started'(event) {
      recordModelCallStarted(event);
    },
    'model.call.settled'(event) {
      recordModelCallSettled(event);
    },
  },
});
