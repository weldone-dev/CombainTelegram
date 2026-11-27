import { defineSchedule } from 'eve/schedules';
import { proactiveTick } from '../lib/proactive';

/**
 * Every minute, ask Nest to run one proactive tick.
 *
 * No model, no channel target: Nest selects the due `EveAgendaItem`, checks the
 * allowlist/cooldown and pushes `POST /eve/v1/nest/proactive` back to Eve only
 * when it is time. Running this from Eve's schedule runner means Nest does not
 * need a second ticker when `eve start` already fires schedules.
 *
 * `eve dev` never fires schedules on their cadence; use
 * `POST /eve/v1/dev/schedules/proactive` to run it by hand.
 */
export default defineSchedule({
  cron: '* * * * *',
  async run() {
    const result = await proactiveTick();
    if (!result.ok && !result.skipped) {
      console.warn(
        `[proactive] Nest tick failed (${result.status}): ${
          result.error ?? 'unknown error'
        }`,
      );
    }
  },
});
