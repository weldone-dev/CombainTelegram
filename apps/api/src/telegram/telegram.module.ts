import { Module } from '@nestjs/common';
import { ClientProfileService } from './client-profile.service.js';
import { ClientManagerService } from './client-manager.service.js';
import { ProxyTransportService } from './proxy-transport.service.js';
import { SessionCryptoService } from './session-crypto.service.js';
import { TelegramConfigService } from './telegram.config.js';

@Module({
  providers: [
    TelegramConfigService,
    ClientProfileService,
    SessionCryptoService,
    ProxyTransportService,
    ClientManagerService,
  ],
  exports: [
    TelegramConfigService,
    ClientProfileService,
    SessionCryptoService,
    ProxyTransportService,
    ClientManagerService,
  ],
})
export class TelegramModule {}
