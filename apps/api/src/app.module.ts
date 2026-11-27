import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AccountsModule } from './accounts/accounts.module.js';
import { AiModule } from './ai/ai.module.js';
import { AiAccountModule } from './ai-account/ai-account.module.js';
import { AiProvidersModule } from './ai-providers/ai-providers.module.js';
import { AiAccessModule } from './ai-access/ai-access.module.js';
import { EveModule } from './eve/eve.module.js';
import { N8nIntegrationsModule } from './integrations/n8n/n8n.module.js';
import { AuthModule } from './auth/auth.module.js';
import { LogsModule } from './logs/logs.module.js';
import { LoggingInterceptor } from './logs/logging.interceptor.js';
import { AllExceptionsFilter } from './logs/all-exceptions.filter.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProxiesModule } from './proxies/proxies.module.js';
import { PushModule } from './push/push.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { DefaultUserGuard } from './user-context/default-user.guard.js';
import { UserContextModule } from './user-context/user-context.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    LogsModule,
    TelegramModule,
    // Single-user mode: every request runs as DEFAULT_USER_ID, no login.
    UserContextModule,
    RealtimeModule,
    AccountsModule,
    MessagingModule,
    AuthModule,
    ProxiesModule,
    PushModule,
    AiProvidersModule,
    AiModule,
    AiAccountModule,
    AiAccessModule,
    EveModule,
    WorkflowsModule,
    N8nIntegrationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: DefaultUserGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
