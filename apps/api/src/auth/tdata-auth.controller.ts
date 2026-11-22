import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { TdataAuthService, TDATA_MAX_ARCHIVE_BYTES } from './tdata-auth.service.js';
import type {
  TdataImportDto,
  TdataImportView,
  TdataUploadDto,
  TdataUploadView,
  UploadedArchive,
} from './tdata-auth.service.js';

/**
 * Multer writes here before the service takes over; this is evaluated when the
 * decorator runs, so it mirrors the `TELEGRAM_TMP_DIR` default without DI.
 */
const UPLOAD_DEST = resolve(
  process.env.TELEGRAM_TMP_DIR ?? join(tmpdir(), 'combain-telegram'),
  'uploads',
);

@ApiTags('auth')
@Controller('auth/tdata')
export class TdataAuthController {
  constructor(private readonly tdataAuth: TdataAuthService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      dest: UPLOAD_DEST,
      limits: { files: 1, fileSize: TDATA_MAX_ARCHIVE_BYTES },
    }),
  )
  upload(
    @CurrentUser() user: UserModel,
    @UploadedFile() file: UploadedArchive | undefined,
    @Body() body: TdataUploadDto,
  ): Promise<TdataUploadView> {
    return this.tdataAuth.upload(user, file, body ?? {});
  }

  @Post(':id/import')
  import(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Body() body: TdataImportDto,
  ): Promise<TdataImportView> {
    return this.tdataAuth.import(user, id, body ?? {});
  }

  @Delete(':id')
  cancel(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
  ): Promise<{ cancelled: boolean }> {
    return this.tdataAuth.cancel(user, id);
  }
}
