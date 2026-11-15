import {
  DataSet,
  englishDataset,
  englishRecommendedTransformers,
  parseRawPattern,
  RegExpMatcher,
  resolveLeetSpeakTransformer,
  toAsciiLowerCaseTransformer,
} from "obscenity";

/** Matched anywhere in a username. */
const ANYWHERE = [
  "openskatemap",
  "hitler",
  "kkk",
  "google",
  "youtube",
  "instagram",
  "facebook",
  "whatsapp",
  "tiktok",
  "snapchat",
  "microsoft",
  "netflix",
  "spotify",
  "openai",
  "chatgpt",
  "anthropic",
  "samsung",
  "twitter",
  "linkedin",
  "pinterest",
  "reddit",
  "nike",
  "adidas",
  "newbalance",
  "thrasher",
  "redbull",
  "gopro",
  "volcom",
  "quiksilver",
  "billabong",
  "reebok",
  "carhartt",
  "stussy",
  "etnies",
  "emerica",
];

/** Matched only as a whole word, between underscores or digits ("palace_skate", not "metalhead"). */
const WHOLE_WORD = [
  "admin",
  "administrator",
  "moderator",
  "editor",
  "curator",
  "official",
  "verified",
  "staff",
  "support",
  "settings",
  "nazi",
  "nazis",
  "heil",
  "apple",
  "meta",
  "amazon",
  "uber",
  "discord",
  "vans",
  "converse",
  "supreme",
  "palace",
  "puma",
];

const english = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });

const ours = new RegExpMatcher({
  ...[...ANYWHERE, ...WHOLE_WORD.map((word) => `|${word}|`)]
    .reduce((terms, word) => terms.addPhrase((phrase) => phrase.addPattern(parseRawPattern(word))), new DataSet())
    .build(),
  // English's transformers also collapse repeated letters, so "support" would never match.
  blacklistMatcherTransformers: [resolveLeetSpeakTransformer(), toAsciiLowerCaseTransformer()],
});

export function isAllowedUsername(username: string): boolean {
  const spellings = [username.replace(/_/g, " "), username.replace(/_/g, ""), username.replace(/[_0-9]/g, " ")];
  return !spellings.some((spelling) => english.hasMatch(spelling) || ours.hasMatch(spelling));
}
