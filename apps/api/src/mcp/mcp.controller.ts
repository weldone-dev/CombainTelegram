import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { AiConfigService } from '../ai/ai-config.service.js';
import { AgentToolsService } from '../ai/agent-tools.service.js';
import { SkillsService } from '../ai/skills.service.js';
import { SoulsService } from '../ai/souls.service.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { DefaultUserService } from '../user-context/default-user.service.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = {
  name: 'combain-telegram',
  title: 'CombainTelegram',
  version: '1.0.0',
};

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcOk(id: unknown, result: unknown): RpcResponse {
  return {
    jsonrpc: '2.0',
    id: (id ?? null) as string | number | null,
    result,
  };
}

function rpcFail(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): RpcResponse {
  return {
    jsonrpc: '2.0',
    id: (id ?? null) as string | number | null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const given = Buffer.from(match[1] as string, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

/**
 * Model Context Protocol server (Streamable HTTP, stateless).
 *
 * Clients POST JSON-RPC 2.0 to `/mcp` with `Authorization: Bearer <token>`
 * (the token is shown in AI → MCP). Tools are the same registry the in-app
 * agent uses, so every call obeys the same permission policy and dry-run.
 */
@ApiTags('mcp')
@Controller('mcp')
export class McpController {
  constructor(
    private readonly config: AiConfigService,
    private readonly tools: AgentToolsService,
    private readonly skills: SkillsService,
    private readonly souls: SoulsService,
    private readonly accounts: AccountsService,
    private readonly users: DefaultUserService,
  ) {}

  @Post()
  async rpc(
    @Req() request: Request,
    @Res() response: Response,
    @Headers('authorization') authorization?: string,
  ): Promise<void> {
    const token = await this.config.mcpToken();
    if (!tokenMatches(token, authorization)) {
      response.status(401).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Invalid or missing MCP token' },
      });
      return;
    }

    const body = request.body as RpcRequest | RpcRequest[];
    if (Array.isArray(body)) {
      const replies: RpcResponse[] = [];
      for (const item of body) {
        const reply = await this.handleOne(item);
        if (reply) replies.push(reply);
      }
      response.status(200).json(replies);
      return;
    }

    const reply = await this.handleOne(body);
    if (!reply) {
      response.status(202).end();
      return;
    }
    response.status(200).json(reply);
  }

  /** This server does not offer a server→client SSE stream. */
  @Get()
  @HttpCode(405)
  get(): { error: string } {
    return { error: 'Use POST /mcp (Streamable HTTP, JSON responses).' };
  }

  @Delete()
  @HttpCode(204)
  delete(): void {
    // Stateless server: nothing to terminate.
  }

  private async handleOne(request: RpcRequest): Promise<RpcResponse | null> {
    const id = request?.id ?? null;
    const method = request?.method ?? '';
    const params = (request?.params ?? {}) as Record<string, unknown>;

    // Notifications carry no id and expect no body.
    if (id === null || id === undefined) {
      if (method.startsWith('notifications/')) return null;
    }

    try {
      switch (method) {
        case 'initialize': {
          const policy = await this.config.policy();
          return rpcOk(id, {
            protocolVersion:
              typeof params.protocolVersion === 'string'
                ? params.protocolVersion
                : PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              prompts: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: SERVER_INFO,
            instructions: [
              'MCP-доступ к локальному Telegram-приложению CombainTelegram.',
              `Разрешённые возможности: ${Object.entries(policy.capabilities)
                .filter(([, allowed]) => allowed)
                .map(([name]) => name)
                .join(', ') || 'нет'}.`,
              policy.dryRun
                ? 'dryRun включён: отправка/редактирование/удаление/реакции только симулируются. Ответ инструмента содержит dryRun: true.'
                : 'dryRun выключен: инструменты действительно меняют Telegram.',
              'Перед отправкой сообщения живому человеку покажите текст и получите явное подтверждение.',
              'Не выводите токены, API-ключи и пароли.',
            ].join('\n'),
          });
        }
        case 'ping':
          return rpcOk(id, {});
        case 'tools/list': {
          const user = await this.users.get();
          const schemas = await this.tools.schemas(
            {
              userId: user.id,
              accountId: null,
              chatId: null,
              source: 'mcp',
            },
            null,
          );
          return rpcOk(id, {
            tools: schemas.map((schema) => ({
              name: schema.function.name,
              description: schema.function.description,
              inputSchema: schema.function.parameters,
            })),
          });
        }
        case 'tools/call': {
          const name = typeof params.name === 'string' ? params.name : '';
          if (!name) return rpcFail(id, -32602, 'params.name is required');
          const args =
            params.arguments && typeof params.arguments === 'object'
              ? (params.arguments as Record<string, unknown>)
              : {};
          const user = await this.users.get();
          const result = await this.tools.execute(name, args, {
            userId: user.id,
            accountId: null,
            chatId: null,
            source: 'mcp',
          });
          const payload = result.ok
            ? result.result
            : { error: result.error, code: result.code };
          return rpcOk(id, {
            content: [
              {
                type: 'text',
                text: JSON.stringify(payload, null, 2) ?? 'null',
              },
            ],
            ...(result.ok ? {} : { isError: true }),
          });
        }
        case 'prompts/list': {
          const list = await this.skills.list();
          return rpcOk(id, {
            prompts: list.map((skill) => ({
              name: skill.slug,
              description: skill.description || skill.name,
              arguments: [],
            })),
          });
        }
        case 'prompts/get': {
          const name = typeof params.name === 'string' ? params.name : '';
          const skill = await this.skills.get(name);
          if (!skill) return rpcFail(id, -32602, `Unknown skill ${name}`);
          return rpcOk(id, {
            description: skill.description,
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: skill.instructions,
                },
              },
            ],
          });
        }
        case 'resources/list': {
          return rpcOk(id, {
            resources: [
              {
                uri: 'telegram://accounts',
                name: 'Telegram accounts',
                mimeType: 'application/json',
              },
              {
                uri: 'telegram://souls',
                name: 'Account souls',
                mimeType: 'application/json',
              },
            ],
          });
        }
        case 'resources/read': {
          const uri = typeof params.uri === 'string' ? params.uri : '';
          const user = await this.users.get();
          if (uri === 'telegram://accounts') {
            const list = await this.accounts.list(user.id);
            return rpcOk(id, {
              contents: [
                {
                  uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(
                    list.map((account) => ({
                      id: account.id,
                      name: account.firstName,
                      username: account.username,
                      phoneMasked: account.phoneMasked,
                    })),
                    null,
                    2,
                  ),
                },
              ],
            });
          }
          if (uri === 'telegram://souls') {
            const list = await this.souls.list();
            return rpcOk(id, {
              contents: [
                {
                  uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(list, null, 2),
                },
              ],
            });
          }
          return rpcFail(id, -32602, `Unknown resource ${uri}`);
        }
        default:
          return rpcFail(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      return rpcFail(id, -32603, (error as Error).message);
    }
  }
}
