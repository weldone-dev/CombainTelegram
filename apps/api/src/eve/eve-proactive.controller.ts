import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { EveProactiveService } from './eve-proactive.service.js';
import { EveTokenGuard } from './eve-token.guard.js';

/**
 * Internal proactive/daily-life endpoints for the local Eve process and the
 * `agent/schedules/*` tickers.
 *
 * Kept out of `EveController` on purpose: T9 owns this file and does not need
 * to touch the shared controller. The module must register both the controller
 * and `EveProactiveService`; see docs/eve/T9-proactive-handoff.md for the exact
 * lines.
 */
@ApiTags('eve')
@ApiHeader({
  name: 'x-eve-token',
  required: true,
  description: 'Shared secret from EVE_TOKEN',
})
@Controller('internal/eve')
@UseGuards(EveTokenGuard)
export class EveProactiveController {
  constructor(private readonly proactive: EveProactiveService) {}

  @Post('proactive/tick')
  tick(@Body() body: Record<string, unknown>) {
    return this.proactive.tickRequest(body);
  }

  @Post('daily-life/ensure')
  ensureDailyLife(@Body() body: Record<string, unknown>) {
    return this.proactive.ensureDailyLifeRequest(body);
  }
}
