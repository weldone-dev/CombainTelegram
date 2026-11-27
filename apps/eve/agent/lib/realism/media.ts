/**
 * Media instructions for the turn.
 *
 * The channel already prefixes an incoming attachment with `[он прислал …]`.
 * That tells the model *what* arrived, not *how* to react. These short notes
 * close the gap and cover the other direction too: a request to send a photo,
 * voice or video is declined in character, because the persona has no such
 * capability.
 */

export type MediaKind =
  | 'photo'
  | 'sticker'
  | 'voice'
  | 'video'
  | 'video_note'
  | 'document'
  | 'unknown';

const INSTRUCTIONS: Record<MediaKind, string> = {
  photo:
    'он прислал фото. Если картинка видна — реагируй на конкретику: что на ней, что это напоминает. Не говори, что анализируешь изображение. Если непонятно — скажи естественно. Мем или известную картинку называй только при уверенности.',
  sticker:
    'он прислал стикер. Реагируй на эмоцию или картинку, а не только на emoji. Можно ответить коротко, реакцией или стикером.',
  voice:
    'он прислал голосовое. Если расшифровки нет — веди себя как человек, которому неудобно слушать: попроси текстом или отмахнись.',
  video:
    'он прислал видео. Не притворяйся, что видела детали, если их не передали. Реагируй осторожно.',
  video_note:
    'он прислал кружок. Не обещай кружок в ответ. Можно лениво или смущённо отреагировать.',
  document:
    'он прислал файл. Не обещай открыть или изучить его, если содержимого не передали.',
  unknown: '',
};

export function mediaKindOf(value: unknown): MediaKind {
  return value === 'photo' ||
    value === 'sticker' ||
    value === 'voice' ||
    value === 'video' ||
    value === 'video_note' ||
    value === 'document'
    ? value
    : 'unknown';
}

/** Internal line for the incoming attachment; empty for text messages. */
export function mediaInstruction(kind: string | undefined): string {
  const note = INSTRUCTIONS[mediaKindOf(kind)];
  return note ? `[internal: ${note}]` : '';
}

const REQUEST_VERB =
  /(?:скинь|пришли|отправь|покажи|запиши|сними|кинь|можешь\s+(?:скинуть|прислать|показать|записать))/i;

const REQUEST_TARGETS: Array<{ kind: MediaKind; re: RegExp }> = [
  { kind: 'voice', re: /(?:войс|голосов|гс\b|голосом)/i },
  { kind: 'video_note', re: /(?:кружок|кружочек|видео-?круж)/i },
  { kind: 'video', re: /(?:видео|видос)/i },
  {
    kind: 'photo',
    re: /(?:фото|фотк|селфи|снимок|себя\s+(?:покажи|скинь))/i,
  },
];

/**
 * Detects "скинь фото/войс/видео" so the turn can include a refusal hint.
 * Returns `null` for normal conversation and for requests she *can* satisfy
 * (text, emoji, sticker).
 */
export function requestedMedia(text: string): MediaKind | null {
  if (!text) return null;
  const target = REQUEST_TARGETS.find((entry) => entry.re.test(text));
  if (!target) return null;
  if (!REQUEST_VERB.test(text) && !/(?:хочу|давай|можешь)\s+\S{0,20}(?:фото|войс|видео|круж)/i.test(text)) {
    return null;
  }
  return target.kind;
}

const REFUSAL_LABELS: Record<string, string> = {
  photo: 'фото',
  voice: 'голосовое',
  video: 'видео',
  video_note: 'кружок',
};

/** Internal line that turns a media request into an in-character refusal. */
export function mediaRequestHint(kind: MediaKind | null): string {
  if (!kind) return '';
  const label = REFUSAL_LABELS[kind];
  if (!label) return '';
  return `[internal: он просит ${label}. У тебя нет возможности это отправить сейчас — откажи коротко и по-своему, без технических объяснений и без обещаний «потом обязательно».]`;
}
