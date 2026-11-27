import { defineSchedule } from 'eve/schedules';
import { presenceTick } from '../lib/proactive';

/**
 * Every minute, ask Nest to run one presence tick (sleep/busy/online drift).
 *
 * The Nest endpoint is owned by a later slice. Until it exists, Nest answers
 * 404/405 and `presenceTick` reports `skipped`, so this schedule is a silent
 * no-op instead of a failing cron.
 */
export default defineSchedule({
  cron: '* * * * *',
  async run() {
    const result = await presenceTick();
    if (!result.ok && !result.skipped) {
      console.warn(
        `[presence] Nest tick failed (${result.status}): ${
          result.error ?? 'unknown error'
        }`,
      );
    }
  },
});
