import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AutomationRunnerService } from './automation-runner.service.js';

@Injectable()
export class AutomationSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AutomationSchedulerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(private readonly runner: AutomationRunnerService) {}

  onModuleInit(): void {
    // A small in-process ticker is enough for a local single-user app.
    this.timer = setInterval(() => void this.tick(), 15_000);
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const count = await this.runner.runDue();
      if (count > 0) {
        this.logger.log(`Ran ${count} automation(s)`);
      }
    } catch (error) {
      this.logger.warn(`Automation tick failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
