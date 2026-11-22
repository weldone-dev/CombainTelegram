import { Global, Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { LogsController } from "./logs.controller.js";
import { LogsService } from "./logs.service.js";

@Global()
@Module({
  imports: [RealtimeModule],
  controllers: [LogsController],
  providers: [LogsService],
  exports: [LogsService],
})
export class LogsModule {}
