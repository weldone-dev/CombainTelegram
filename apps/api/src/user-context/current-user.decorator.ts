import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { UserModel } from '@repo/database';

/** The single local user selected by DefaultUserGuard (no login in this app). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UserModel => {
    const request = context.switchToHttp().getRequest<{ user: UserModel }>();
    return request.user;
  },
);
