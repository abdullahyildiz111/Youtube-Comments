// ISO 639-1 covers the languages YouTube comments and Gemini can be asked
// to use, plus the Chinese and Portuguese variants people actually pick.
const REPLY_LANGUAGE_CODE_LIST = `
aa ab ae af ak am an ar as av ay az
ba be bg bh bi bm bn bo br bs
ca ce ch co cr cs cu cv cy
da de dv dz
ee el en eo es et eu
fa ff fi fj fo fr fy
ga gd gl gn gu gv
ha he hi ho hr ht hu hy hz
ia id ie ig ii ik io is it iu
ja jv
ka kg ki kj kk kl km kn ko kr ks ku kv kw ky
la lb lg li ln lo lt lu lv
mg mh mi mk ml mn mr ms mt my
na nb nd ne ng nl nn no nr nv ny
oc oj om or os
pa pi pl ps pt pt-BR
qu
rm rn ro ru rw
sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw
ta te tg th ti tk tl tn to tr ts tt tw ty
ug uk ur uz
ve vi vo
wa wo
xh
yi yo
za zh zh-Hans zh-Hant zu
`
  .trim()
  .split(/\s+/);

export const REPLY_LANGUAGE_CODES: readonly string[] = [
  ...new Set(REPLY_LANGUAGE_CODE_LIST),
];

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

export interface ReplyLanguage {
  code: string;
  label: string;
}

function labelFor(code: string): string | null {
  try {
    const label = languageNames.of(code);
    if (!label || label.toLowerCase() === code.toLowerCase()) return null;
    return label;
  } catch {
    return null;
  }
}

export const REPLY_LANGUAGES: readonly ReplyLanguage[] = REPLY_LANGUAGE_CODES.flatMap(
  (code) => {
    const label = labelFor(code);
    return label ? [{ code, label }] : [];
  },
).sort((first, second) => first.label.localeCompare(second.label, 'en'));

const SUPPORTED_CODES = new Set(REPLY_LANGUAGES.map((language) => language.code));

export function isReplyLanguageCode(value: unknown): value is string {
  return typeof value === 'string' && SUPPORTED_CODES.has(value);
}

export function languageLabel(code: string): string {
  return languageNames.of(code) ?? code;
}
