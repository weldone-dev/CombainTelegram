import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { HttpAdapterHost } from "@nestjs/core";
import { LogsService } from "./logs.service.js";

/**
 * Last line of defence: anything that is not an `HttpException` (a crash in a
 * service, a Prisma error, a bug in a guard) is logged with its stack before
 * the client gets a stable `INTERNAL_ERROR` body. Interceptor already logs
 * ordinary HTTP errors, so those are passed through untouched.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(
    adapterHost: HttpAdapterHost,
    private readonly logs: LogsService,
  ) {
    super(adapterHost.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException) {
      super.catch(exception, host);
      return;
    }

    const context = host.switchToHttp();
    const request = context.getRequest<{
      method?: string;
      originalUrl?: string;
      url?: string;
      user?: { id?: string };
    }>();

    const error = exception instanceof Error ? exception : null;
    const message = error?.message ?? String(exception);
    this.logger.error(message, error?.stack);

    this.logs.write({
      level: "error",
      source: "app",
      action: "unhandled_exception",
      message: `${request.method ?? "?"} ${request.originalUrl ?? request.url ?? "?"}: ${message}`,
      status: "failed",
      userId: request.user?.id,
      errorCode: error?.name ?? "INTERNAL_ERROR",
      details: {
        name: error?.name,
        message,
        stack: error?.stack?.slice(0, 8000),
      },
    });

    super.catch(
      new HttpException(
        { code: "INTERNAL_ERROR", message: "Internal server error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      ),
      host,
    );
  }
}
