import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { UserModel } from '@repo/database';
import { DefaultUserService } from './default-user.service.js';

/**
 * Attaches the single local user to every HTTP request. No token, no session.
 */
@Injectable()
export class DefaultUserGuard implements CanActivate {
  constructor(private readonly users: DefaultUserService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<{ user?: UserModel }>();
    request.user = await this.users.get();
    return true;
  }
}
