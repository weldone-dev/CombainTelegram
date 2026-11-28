import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { EveEventsService } from './eve-events.service.js';
import { EveContextService } from './eve-context.service.js';
import { EveDelayedService } from './eve-delayed.service.js';
import { EveMemoryLifecycleService } from './eve-memory-lifecycle.service.js';
import { EvePersonaGenService } from './eve-persona-gen.service.js';
import { EveProactiveService } from './eve-proactive.service.js';
import { EveSchedulesService } from './eve-schedules.service.js';
import { EveTimelineService } from './eve-timeline.service.js';
import { EveTokenGuard } from './eve-token.guard.js';
import { EveTurnService, parseTurnInput } from './eve-turn.service.js';
import { EveService } from './eve.service.js';

/** Body ids are passed to the service, which validates them; never stringify
 * an arbitrary object into an id. */
function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : '';
}

/**
 * Internal contract for the local Eve process.
 *
 * Not part of the public dashboard API: the guard requires EVE_TOKEN and the
 * route is meant to be reachable only from 127.0.0.1. Nest stays the owner of
 * Telegram, SQLite and the message log; Eve only reads context and issues
 * explicit actions.
 */
@ApiTags('eve')
@ApiHeader({
  name: 'x-eve-token',
  required: true,
  description: 'Shared secret from EVE_TOKEN',
})
@Controller('internal/eve')
@UseGuards(EveTokenGuard)
export class EveController {
  constructor(
    private readonly eve: EveService,
    private readonly events: EveEventsService,
    private readonly turns: EveTurnService,
    private readonly personaGen: EvePersonaGenService,
    private readonly proactive: EveProactiveService,
    private readonly lifecycle: EveMemoryLifecycleService,
    private readonly delayed: EveDelayedService,
    private readonly contexts: EveContextService,
    private readonly schedules: EveSchedulesService,
    private readonly timeline: EveTimelineService,
  ) {}

  @Get('personas')
  listPersonas() {
    return this.eve.listPersonas();
  }

  @Post('personas')
  createPersona(@Body() body: Record<string, unknown>) {
    return this.eve.createPersona(body);
  }

  @Get('personas/:id')
  getPersona(@Param('id') id: string) {
    return this.eve.getPersona(id);
  }

  @Get('personas/:id/docs')
  getPersonaDocs(@Param('id') id: string) {
    return this.personaGen.ensureDocs(id);
  }

  @Put('personas/:id/docs')
  savePersonaDoc(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.personaGen.saveDoc(id, body.kind, body.content);
  }

  @Post('personas/:id/generate')
  generatePersona(@Param('id') id: string) {
    return this.personaGen.generate(id);
  }

  @Patch('personas/:id')
  updatePersona(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.eve.updatePersona(id, body);
  }

  @Post('personas/:id/accounts')
  bindAccount(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.eve.bindAccount(id, body);
  }

  @Delete('personas/:id/accounts/:accountId')
  unbindAccount(
    @Param('id') id: string,
    @Param('accountId') accountId: string,
  ) {
    return this.eve.unbindAccount(id, accountId);
  }

  @Get('personas/:id/chats')
  listChats(@Param('id') id: string) {
    return this.eve.listChats(id);
  }

  @Post('personas/:id/chats')
  allowChat(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.eve.allowChat(id, body);
  }

  @Get('context')
  async context(
    @Query('personaId') personaId?: string,
    @Query('accountId') accountId?: string,
    @Query('chatId') chatId?: string,
    @Query('threadId') threadId?: string,
    @Query('memory') memoryFlag?: string,
  ) {
    const context = await this.eve.context(
      personaId ?? '',
      accountId ?? '',
      chatId,
      Number(threadId ?? 0) || 0,
    );
    // Ranked palace/facts/episodes are only needed by the instruction builder,
    // not by the per-message behavior decision. `memory=1` opts in.
    let memory: unknown = null;
    if (memoryFlag === '1') {
      try {
        memory = await this.lifecycle.retrieve(
          context.scope.personaId,
          context.scope.scopeKey,
          '',
          {
            facts: 10,
            daily: 3,
            palace: 12,
            episodes: 4,
            crossChat: 3,
            timeItems: 6,
            events: 5,
          },
        );
      } catch {
        memory = null;
      }
    }
    return { ...context, memory };
  }

  @Get('events')
  listEvents(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.events.list(cursor, limit);
  }

  /**
   * Real model context of one turn. Eve posts the final AI SDK input
   * (instructions + messages) plus the usage after the turn settled.
   */
  @Post('context/snapshot')
  ingestContextSnapshot(@Body() body: Record<string, unknown>) {
    return this.contexts.ingest(body);
  }

  @Get('context/snapshots')
  listContextSnapshots(
    @Query('personaId') personaId?: string,
    @Query('accountId') accountId?: string,
    @Query('chatId') chatId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.contexts.list({ personaId, accountId, chatId, limit });
  }

  @Get('context/snapshots/:id')
  getContextSnapshot(@Param('id') id: string) {
    return this.contexts.get(id);
  }

  @Post('messages/send')
  sendText(@Body() body: Record<string, unknown>) {
    return this.eve.sendText(body);
  }

  @Post('messages/media')
  sendMedia(@Body() body: Record<string, unknown>) {
    return this.eve.sendMedia(body);
  }

  @Post('messages/voice')
  sendVoice(@Body() body: Record<string, unknown>) {
    return this.eve.sendVoice(body);
  }

  @Post('messages/sticker')
  sendSticker(@Body() body: Record<string, unknown>) {
    return this.eve.sendSticker(body);
  }

  @Post('messages/react')
  sendReaction(@Body() body: Record<string, unknown>) {
    return this.eve.sendReaction(body);
  }

  @Post('messages/edit')
  editMessage(@Body() body: Record<string, unknown>) {
    return this.eve.editMessage(body);
  }

  @Post('messages/delete')
  deleteMessage(@Body() body: Record<string, unknown>) {
    return this.eve.deleteMessage(body);
  }

  @Post('actions')
  enqueueAction(@Body() body: Record<string, unknown>) {
    return this.delayed.enqueue(body);
  }

  @Get('actions')
  listActions(
    @Query('personaId') personaId?: string,
    @Query('state') state?: string,
    @Query('limit') limit?: string,
  ) {
    return this.delayed.list({ personaId, state, limit });
  }

  @Post('actions/tick')
  actionsTick(@Body() body: Record<string, unknown>) {
    return this.delayed.tickRequest(body);
  }

  /**
   * Everything Eve has scheduled or deferred: compiled schedules from the
   * running Eve process plus Nest's durable delayed-action queue.
   */
  @Get('schedules')
  listSchedules(
    @Query('personaId') personaId?: string,
    @Query('accountId') accountId?: string,
    @Query('chatId') chatId?: string,
    @Query('states') states?: string,
    @Query('limit') limit?: string,
  ) {
    return this.schedules.overview({
      personaId,
      accountId,
      chatId,
      states,
      limit,
    });
  }

  @Post('messages/block')
  blockContact(@Body() body: Record<string, unknown>) {
    return this.eve.blockContact(body);
  }

  @Post('messages/unblock')
  unblockContact(@Body() body: Record<string, unknown>) {
    return this.eve.unblockContact(body);
  }

  @Post('typing')
  typing(@Body() body: Record<string, unknown>) {
    return this.eve.typing(body);
  }

  @Post('read')
  read(@Body() body: Record<string, unknown>) {
    return this.eve.read(body);
  }

  @Post('presence')
  presence(@Body() body: Record<string, unknown>) {
    return this.eve.presence(body);
  }

  @Post('presence/tick')
  presenceTick() {
    return this.eve.presenceTick();
  }

  @Get('stickers')
  listStickers(@Query('personaId') personaId?: string) {
    return this.eve.listStickers(personaId ?? '');
  }

  @Post('stickers')
  addSticker(@Body() body: Record<string, unknown>) {
    return this.eve.addSticker(field(body, 'personaId'), body);
  }

  /**
   * Chat timeline: his messages, her replies/ignores and the relationship
   * changes applied for those turns. Newest first; `before` pages older.
   */
  @Get('timeline')
  chatTimeline(
    @Query('personaId') personaId?: string,
    @Query('accountId') accountId?: string,
    @Query('chatId') chatId?: string,
    @Query('threadId') threadId?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.timeline.timeline({
      personaId,
      accountId,
      chatId,
      threadId,
      limit,
      before,
    });
  }

  @Get('history')
  history(
    @Query('accountId') accountId?: string,
    @Query('chatId') chatId?: string,
    @Query('limit') limit?: string,
    @Query('offsetId') offsetId?: string,
  ) {
    return this.eve.history({ accountId, chatId, limit, offsetId });
  }

  @Post('memory/recall')
  recall(@Body() body: Record<string, unknown>) {
    const personaId = field(body, 'personaId');
    return this.eve.recall(personaId, body);
  }

  @Post('memory/capture')
  capture(@Body() body: Record<string, unknown>) {
    const personaId = field(body, 'personaId');
    return this.eve.capture(personaId, body);
  }

  @Post('memory/facts')
  addFact(@Body() body: Record<string, unknown>) {
    const personaId = field(body, 'personaId');
    return this.eve.addFact(personaId, body);
  }

  @Get('memory/facts')
  listFacts(@Query('personaId') personaId?: string) {
    return this.eve.listFacts(personaId ?? '');
  }

  @Get('memory/daily')
  listMemoryDaily(@Query('personaId') personaId?: string) {
    return this.eve.listMemoryDaily(personaId ?? '');
  }

  @Get('memory/palace')
  listPalace(@Query('personaId') personaId?: string) {
    return this.eve.listPalace(personaId ?? '');
  }

  @Get('memory/sessions')
  listSessions(@Query('personaId') personaId?: string) {
    return this.eve.listSessions(personaId ?? '');
  }

  @Post('memory/close-day')
  closeDay(@Body() body: Record<string, unknown>) {
    return this.lifecycle.closeDay(
      field(body, 'personaId'),
      field(body, 'accountId'),
      body.chatId as string | number,
      typeof body.day === 'string' ? body.day : undefined,
    );
  }

  @Post('memory/retrieve')
  async retrieve(@Body() body: Record<string, unknown>) {
    const personaId = field(body, 'personaId');
    let scopeKey = field(body, 'scopeKey');
    // Eve sends the hash of its memory scope (`memscope1_…`), while Nest keys
    // relationships by `account:<accountId>:chat:<chatId>` (or `peer:`).
    // Resolve the real key from the address so the relationship snapshot and
    // relationship-scoped facts are not silently filtered out.
    const accountId = field(body, 'accountId');
    const chatId = field(body, 'chatId');
    if (accountId && chatId) {
      try {
        const scope = await this.eve.scope(
          personaId,
          accountId,
          chatId,
          Number(field(body, 'threadId')) || 0,
        );
        scopeKey = scope.scopeKey;
      } catch {
        // A bad address keeps the provided key instead of failing recall.
      }
    }
    return this.lifecycle.retrieve(
      personaId,
      scopeKey,
      typeof body.query === 'string' ? body.query : '',
      (body.limits as Record<string, number> | undefined) ?? {
        facts: Number(body.facts) || undefined,
        daily: Number(body.daily) || undefined,
        palace: Number(body.palace) || undefined,
        episodes: Number(body.episodes) || undefined,
        crossChat: Number(body.crossChat) || undefined,
        timeItems: Number(body.timeItems) || undefined,
        events: Number(body.events) || undefined,
      },
    );
  }

  @Post('memory/reflect')
  reflect(@Body() body: Record<string, unknown>) {
    return this.lifecycle.reflect(
      field(body, 'personaId'),
      field(body, 'accountId'),
      body.chatId as string | number,
    );
  }

  @Post('memory/amnesia')
  amnesia(@Body() body: Record<string, unknown>) {
    return this.lifecycle.amnesia(
      field(body, 'personaId'),
      Number(body.minutes),
    );
  }

  @Post('memory/reset')
  resetMemory(@Body() body: Record<string, unknown>) {
    return this.lifecycle.reset(field(body, 'personaId'));
  }

  @Get('state/relationship')
  getRelationship(
    @Query('personaId') personaId?: string,
    @Query('accountId') accountId?: string,
    @Query('chatId') chatId?: string,
  ) {
    return this.eve.getRelationship(
      personaId ?? '',
      accountId ?? '',
      chatId,
    );
  }

  @Patch('state/relationship')
  updateRelationship(@Body() body: Record<string, unknown>) {
    return this.eve.updateRelationship(
      field(body, 'personaId'),
      field(body, 'accountId'),
      body.chatId,
      body,
    );
  }

  /** Silent mood delta (negative reaction emoji): no turn, no counters. */
  @Post('state/mood')
  applyMood(@Body() body: Record<string, unknown>) {
    return this.eve.applyMood(field(body, 'personaId'), body);
  }

  @Get('state/conflict')
  getConflict(
    @Query('personaId') personaId?: string,
    @Query('accountId') accountId?: string,
    @Query('chatId') chatId?: string,
  ) {
    return this.eve.getConflict(personaId ?? '', accountId ?? '', chatId);
  }

  @Patch('state/conflict')
  updateConflict(@Body() body: Record<string, unknown>) {
    return this.eve.updateConflict(
      field(body, 'personaId'),
      field(body, 'accountId'),
      body.chatId,
      body,
    );
  }

  /**
   * Server-side writeback for one persona turn: mood delta, conflict automaton,
   * stage counters and the session log. The Eve process calls this once per
   * real incoming message; the allowlist gate lives in the service.
   */
  @Post('turn/apply')
  applyTurn(@Body() body: Record<string, unknown>) {
    return this.turns.applyTurn(parseTurnInput(body));
  }

  @Get('turn/state')
  turnState(
    @Query('personaId') personaId?: string,
    @Query('accountId') accountId?: string,
    @Query('chatId') chatId?: string,
  ) {
    return this.turns.getState(
      personaId ?? '',
      accountId ?? '',
      chatId,
    );
  }

  @Get('agenda')
  listAgenda(@Query('personaId') personaId?: string) {
    return this.eve.listAgenda(personaId ?? '');
  }

  @Post('agenda')
  createAgenda(@Body() body: Record<string, unknown>) {
    return this.eve.createAgenda(field(body, 'personaId'), body);
  }

  /** LLM extraction of events he mentioned + his answer to a recent ping. */
  @Post('agenda/extract')
  extractAgenda(@Body() body: Record<string, unknown>) {
    return this.proactive.extractAgendaUpdates(body);
  }

  @Patch('agenda/:id')
  updateAgenda(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.eve.updateAgenda(id, body);
  }
}
