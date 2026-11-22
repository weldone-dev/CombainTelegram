import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // The dashboard runs on another origin (default :3000). No cookies are used,
  // so credentials stay off; CORS_ORIGIN can be a comma-separated allowlist.
  // Outside production any port on localhost/127.0.0.1 is accepted too, so
  // opening the dashboard via 127.0.0.1 or a preview port does not look like
  // "API unreachable" in the browser.
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((value) => value.trim())
    : null;
  const isProduction = process.env.NODE_ENV === 'production';

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      if (!allowedOrigins || !origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      if (!isProduction) {
        try {
          const host = new URL(origin).hostname;
          if (host === 'localhost' || host === '127.0.0.1') {
            callback(null, true);
            return;
          }
        } catch {
          // Malformed Origin header: fall through to deny.
        }
      }
      callback(null, false);
    },
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('CombainTelegram API')
    .setDescription(
      'Single-user multi-account Telegram sessions, chats/messages and realtime events.',
    )
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
  });

  await app.listen(process.env.PORT ?? 3001);
}
await bootstrap();
